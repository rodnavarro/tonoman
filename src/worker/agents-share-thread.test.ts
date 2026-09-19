// Two agents in one thread, and an agent switched between providers (docs/definition/objects/
// conversation.md, inference.md). What each keeps for a conversation is its own; what a switch
// changes, it changes for the next turn only. Titles start with the rule they prove.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { threadModels } from "./threadmodels";
import { sessionKeyOf } from "./activities";
import { sessionStore } from "./worker";
import { watchDeviceLogin, outcomeIsCurrent, handleInteraction, codeModal, registrationAfterLogin } from "./authgate";

const THREAD = "T1/C1/1.0";

describe("two agents, one thread", () => {
  let dir = "";
  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), "tonoman-two-agents-"));
  });
  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it("CONVO-EACH-AGENT-ITS-OWN a !model to Echo in a thread changes nothing for Golf in the same thread", () => {
    const m = threadModels();
    m.set("echo", THREAD, "opus");
    expect(m.get("echo", THREAD, "claude")).toBe("opus");
    expect(m.get("golf", THREAD, "claude")).toBeUndefined();
    m.set("golf", THREAD, undefined);
    expect(m.get("echo", THREAD, "claude")).toBe("opus");
  });

  it("CONVO-EACH-AGENT-ITS-OWN each agent has its own session in a shared thread, and !new to Echo leaves Golf's", async () => {
    const s = sessionStore(dir, (() => { let n = 0; return () => `id-${++n}`; })());
    const key = sessionKeyOf(THREAD, "UANA");
    const e = await s.claim("echo", key);
    const g = await s.claim("golf", key);
    expect(e.id).not.toBe(g.id);
    await s.forget("echo", key); // what !new does
    expect(await s.claim("golf", key)).toEqual({ id: g.id, isNew: false });
    expect((await s.claim("echo", key)).isNew).toBe(true);
  });
});

describe("switching an agent's provider", () => {
  it("INFER-SWITCH-COUNTS-CURRENT the next turn after a switch starts a fresh session; a Claude agent's sessions keep their names", () => {
    expect(sessionKeyOf(THREAD, "UANA")).toBe(`${THREAD}#UANA`);
    expect(sessionKeyOf(THREAD, "UANA", "claude")).toBe(`${THREAD}#UANA`);
    expect(sessionKeyOf(THREAD, "UANA", "codex")).not.toBe(sessionKeyOf(THREAD, "UANA", "claude"));
  });

  it("INFER-SWITCH-COUNTS-CURRENT a thread's model chosen on the old provider is dropped on the new one", () => {
    const m = threadModels();
    m.set("lumen", THREAD, "opus");
    expect(m.get("lumen", THREAD, "codex")).toBeUndefined(); // the roster's Codex model answers instead
    m.set("lumen", THREAD, "sol");
    expect(m.get("lumen", THREAD, "codex")).toBe("sol");
    expect(m.get("lumen", THREAD, "claude")).toBeUndefined();
  });

  it("INFER-SWITCH-COUNTS-CURRENT a login started on Claude that finishes after the switch to Codex is reported as Claude's", async () => {
    let provider: "claude" | "codex" = "claude";
    const reported: { state: string; provider?: string }[] = [];
    let finish: () => void = () => {};
    const done = new Promise<void>((r) => (finish = r));
    // The login completes only after the Hub switched the agent to Codex.
    const ops = {
      pending: async () => {
        await done;
        return { done: true, loggedIn: true, status: "ok" };
      },
    };
    const registered: { user: string; provider?: string }[] = [];
    const run = watchDeviceLogin(
      {
        ops: () => undefined,
        conn: () => undefined,
        provider: () => provider,
        setAuthState: async (_a, state, _u, p) => void reported.push({ state, provider: p }),
        onLogin: async (_a, user, p) => void registered.push({ user, provider: p }),
      },
      "lumen",
      "c1",
      ops as never,
      "UANA",
      false,
      { pollMs: 1, timeoutMs: 5000 },
    );
    provider = "codex";
    finish();
    await run;
    expect(reported).toEqual([{ state: "ok", provider: "claude" }]);
    // Registration carries the login's own provider too, never the one the agent was switched to.
    expect(registered).toEqual([{ user: "UANA", provider: "claude" }]);
  });

  it("INFER-SWITCH-COUNTS-CURRENT a pasted Claude code submitted after the switch to Codex registers and reports Claude's login, not Codex's", async () => {
    let provider: "claude" | "codex" = "claude";
    const modal = codeModal("lumen", "c1", provider); // opened while the agent was still on Claude
    provider = "codex"; // the Hub switches it before the code is pasted
    const reported: { state: string; provider?: string }[] = [];
    const registered: { user: string; provider?: string }[] = [];
    const conn = { reply: () => ({ send: async () => "m" }) };
    await handleInteraction(
      {
        ops: () => ({ submitCode: async () => ({ ok: true, status: "ok", loginTail: "" }) }) as never,
        conn: () => conn as never,
        provider: () => provider,
        setAuthState: async (_a, state, _u, p) => void reported.push({ state, provider: p }),
        onLogin: async (_a, user, p) => void registered.push({ user, provider: p }),
      },
      "lumen",
      { kind: "view_submission", callbackId: "tonoman_connect_inference", privateMetadata: modal.private_metadata as string, userId: "UANA", values: { code: { value: { value: "abc" } } } } as never,
    );
    expect(reported).toEqual([{ state: "ok", provider: "claude" }]);
    expect(registered).toEqual([{ user: "UANA", provider: "claude" }]);
  });

  it("INFER-SWITCH-COUNTS-CURRENT registering someone after a login on the old provider never marks them signed in on the new one", () => {
    // Their Claude login worked: they are registered, and their Codex state is left as it was.
    expect(registrationAfterLogin("claude", "codex")).toBeUndefined();
    // A login on the provider the agent uses now is registered already signed in, as before.
    expect(registrationAfterLogin("codex", "codex")).toEqual({ authState: "ok", authProvider: "codex" });
  });

  it("INFER-SWITCH-COUNTS-CURRENT an outcome for the provider an agent no longer uses never changes its badge", () => {
    expect(outcomeIsCurrent("claude", "codex")).toBe(false);
    expect(outcomeIsCurrent("codex", "codex")).toBe(true);
    expect(outcomeIsCurrent(undefined, "codex")).toBe(true); // no provider named = the current one
  });
});
