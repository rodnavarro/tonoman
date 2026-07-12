import { describe, it, expect } from "vitest";
import { buildSummaryPrompt, collectFinal, compactConversation, COMPACT_SEED_PREFIX } from "./compact";
import type { Message, TurnEvent, TurnRequest, TurnRunner } from "./core/contracts";

const msg = (role: string, text: string): Message => ({ role, text, ts: "2026-07-12T00:00:00Z" });

/** A runner that records the prompts it was asked to run and returns a canned summary. */
function fakeRunner(final: string, sink: TurnRequest[] = []): TurnRunner {
  return {
    async *run(req: TurnRequest): AsyncIterable<TurnEvent> {
      sink.push(req);
      yield { kind: "done", final };
    },
  };
}

/** An in-memory MemoryStore recording the op order + seeded messages. */
function fakeMemory(initial: Message[]) {
  const ops: string[] = [];
  let win = [...initial];
  const appended: Message[] = [];
  const store = {
    async readWindow(): Promise<Message[]> {
      return win;
    },
    async append(_c: string, ...m: Message[]): Promise<void> {
      ops.push("append");
      appended.push(...m);
    },
    async commit(): Promise<void> {
      ops.push("commit");
    },
    async newSession(): Promise<string> {
      ops.push("newSession");
      win = []; // a fresh session reads an empty window (until seeded)
      return "sess-2";
    },
  };
  return { store: store as any, ops, appended };
}

describe("compact orchestrator (gw-command-compact)", () => {
  it("buildSummaryPrompt embeds the transcript and asks for a summary only", () => {
    const p = buildSummaryPrompt([msg("user", "file the receipt"), msg("assistant", "done, filed 2026")]);
    expect(p).toContain("hand-off brief");
    expect(p).toContain("THIRD PERSON"); // must not be a chatty reply
    expect(p).toContain("user: file the receipt");
    expect(p).toContain("assistant: done, filed 2026");
    expect(p).toContain("ONLY the brief");
  });

  it("collectFinal returns the done event's final and throws on error", async () => {
    async function* ok(): AsyncGenerator<TurnEvent> {
      yield { kind: "text", text: "…" };
      yield { kind: "done", final: "the summary" };
    }
    expect(await collectFinal(ok())).toBe("the summary");
    async function* bad(): AsyncGenerator<TurnEvent> {
      yield { kind: "error", err: new Error("boom") };
    }
    await expect(collectFinal(bad())).rejects.toThrow("boom");
  });

  it("summarizes → rotates → seeds, IN THAT ORDER, and the summary turn is a one-shot (no session)", async () => {
    const prompts: TurnRequest[] = [];
    const runner = fakeRunner("SUMMARY: receipt filed; deck contact pending", prompts);
    const { store, ops, appended } = fakeMemory([msg("user", "a"), msg("assistant", "b"), msg("user", "c")]);
    const receipt = await compactConversation({ conversation: "conv", runner, memory: store });

    // order is the contract: summarize FIRST (transcript intact), THEN rotate, THEN seed
    expect(ops).toEqual(["newSession", "append", "commit"]);
    // the summary turn ran as a standalone call — no sessionId/sessionNew (no resume of the live session)
    expect(prompts).toHaveLength(1);
    expect(prompts[0].sessionId).toBeUndefined();
    expect(prompts[0].sessionNew).toBeUndefined();
    // the seed carries the summary under the prefix, so the next turn frames it as prior context
    expect(appended).toHaveLength(1);
    expect(appended[0].role).toBe("assistant");
    expect(appended[0].text).toBe(COMPACT_SEED_PREFIX + "SUMMARY: receipt filed; deck contact pending");
    expect(receipt).toContain("Compacted");
  });

  it("no-ops on a short conversation (nothing to compact) — never rotates", async () => {
    const runner = fakeRunner("unused");
    const { store, ops } = fakeMemory([msg("user", "hi")]);
    const receipt = await compactConversation({ conversation: "conv", runner, memory: store });
    expect(ops).toEqual([]); // no rotate, no seed — context left intact
    expect(receipt).toContain("Nothing to compact");
  });

  it("leaves context INTACT if the summary turn fails or is empty (rotate never happens)", async () => {
    const boom: TurnRunner = {
      async *run(): AsyncIterable<TurnEvent> {
        yield { kind: "error", err: new Error("model down") };
      },
    };
    const { store, ops } = fakeMemory([msg("user", "a"), msg("assistant", "b")]);
    const receipt = await compactConversation({ conversation: "conv", runner: boom, memory: store });
    expect(ops).toEqual([]); // summarize failed → we never rotated/cleared
    expect(receipt).toContain("nothing changed");

    const empty = fakeRunner("   "); // whitespace-only summary
    const m2 = fakeMemory([msg("user", "a"), msg("assistant", "b")]);
    const r2 = await compactConversation({ conversation: "conv", runner: empty, memory: m2.store });
    expect(m2.ops).toEqual([]);
    expect(r2).toContain("nothing changed");
  });
});
