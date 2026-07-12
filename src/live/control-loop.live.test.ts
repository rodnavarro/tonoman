// LIVE integration test for `int-control-loop` (docs/scenarios/live/control-loop.md).
// Real container, real Claude, real tokens. Run on demand: `npm run test:live`.
//
// GENERIC: targets the harness container named by TONOMAN_LIVE_AGENT (NO hardcoded agent
// — the OSS repo is content-agnostic; the operator points it at any authenticated agent).
// Skips (does not fail) when that's unset / the container is down / it isn't authenticated.
// Drives the harness directly (no Telegram/gateway) and asserts STRUCTURE, not model text.

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import * as claudecode from "../harness/claudecode";
import { AsideLane, LiveTurn } from "../aside";
import type { Connector, Message, Reply, Streamer, TurnEvent, TurnRunner } from "../core/contracts";

const AGENT = process.env.TONOMAN_LIVE_AGENT?.trim() || "";
const spec = claudecode.spec();

function podman(args: string[]): string {
  return execFileSync("podman", args, { encoding: "utf8" });
}
function containerRunning(name: string): boolean {
  try {
    return podman(["inspect", "-f", "{{.State.Running}}", name]).trim() === "true";
  } catch {
    return false;
  }
}
function authenticated(name: string): boolean {
  try {
    execFileSync("podman", ["exec", "-e", "IS_SANDBOX=1", name, ...spec.statusArgs], { stdio: "ignore" });
    return true; // `claude auth status` exits 0 only when logged in
  } catch {
    return false;
  }
}
function fileExists(name: string, path: string): boolean {
  try {
    podman(["exec", name, "test", "-f", path]);
    return true;
  } catch {
    return false;
  }
}
function countContainers(): number {
  return podman(["ps", "-aq"]).split(/\r?\n/).filter((l) => l.trim()).length;
}

/** Drive a real turn to completion; return whether it ended cleanly + the final text. */
async function runTurn(runner: TurnRunner, prompt: string): Promise<{ ok: boolean; final: string }> {
  let ok = false;
  let final = "";
  for await (const ev of runner.run({ prompt })) {
    if (ev.kind === "done") {
      ok = true;
      final = ev.final ?? "";
    } else if (ev.kind === "error") {
      throw ev.err ?? new Error("live turn error");
    }
  }
  return { ok, final };
}

const ready = AGENT !== "" && containerRunning(AGENT) && authenticated(AGENT);
if (!ready) {
  // eslint-disable-next-line no-console
  console.warn(
    `[live] SKIPPING int-control-loop — set TONOMAN_LIVE_AGENT to an authenticated harness container ` +
      `(got "${AGENT || "(unset)"}", running=${AGENT ? containerRunning(AGENT) : false}).`,
  );
}

// A tiny capturing connector + streamer for the aside (we assert on captured replies).
function capture(): { conn: Connector; sent: string[] } {
  const sent: string[] = [];
  const reply: Reply = {
    send: async (t) => (sent.push(t), String(sent.length)),
    update: async () => {},
    finalize: async () => {},
    canEdit: () => true,
    working: async () => {},
  };
  const conn = { name: () => "live", receive: async function* () {}, reply: () => reply } as unknown as Connector;
  return { conn, sent };
}
const drainStreamer: Streamer = {
  async consume(reply: Reply, events: AsyncIterable<TurnEvent>): Promise<string> {
    let acc = "";
    let final = "";
    for await (const ev of events) {
      if (ev.kind === "text") acc += ev.text ?? "";
      else if (ev.kind === "done") final = ev.final ?? acc;
      else if (ev.kind === "error") throw ev.err ?? new Error("aside error");
    }
    const out = final || acc;
    await reply.send(out);
    return out;
  },
};
const noWindow = async (): Promise<Message[]> => [];

describe.skipIf(!ready)("int-control-loop (live)", () => {
  // unique-but-deterministic path (no Date/random) so re-runs don't collide and we clean up.
  const probe = `/root/tonoman-live-${process.pid}.md`;

  it("turn: a real turn does real work — writes a file on disk (outcome-verified)", async () => {
    const runner = spec.newRunner({ container: AGENT });
    const { ok, final } = await runTurn(
      runner,
      `Create the file ${probe} containing three short facts about Linux containers, one per line. Then reply with just: DONE.`,
    );
    expect(ok).toBe(true);
    expect(final.trim().length).toBeGreaterThan(0);
    expect(fileExists(AGENT, probe)).toBe(true); // the work is real, verified host-side — not from the reply
    try {
      podman(["exec", AGENT, "rm", "-f", probe]);
    } catch {
      /* best-effort cleanup */
    }
  });

  it("btw: an aside answers off a live turn, its own reply, and leaves no container behind", async () => {
    const live = new LiveTurn();
    const mainRunner = live.monitor(spec.newRunner({ container: AGENT }));
    const ephemeral = spec.newEphemeralRunner!({ volumesFrom: AGENT, image: spec.image, env: spec.runEnv });
    const { conn, sent } = capture();
    const lane = new AsideLane({
      conn,
      streamer: drainStreamer,
      runner: ephemeral,
      readWindow: noWindow,
      windowSize: 30,
      identity: { name: AGENT, role: "agent" },
      live,
    });

    const before = countContainers();
    // start a real (slightly long) main turn, do NOT await — fire the aside while it runs
    const mainP = runTurn(mainRunner, "Count slowly from 1 to 8, one number per line, then say DONE.");
    await lane.ask("what are you doing right now?", "live");
    const main = await mainP;

    expect(sent.length).toBeGreaterThan(0); // the aside replied
    expect(sent[0].trim().length).toBeGreaterThan(0);
    expect(sent[0]).toContain("↩"); // marked as an aside (its own reply, not the main turn)
    expect(main.ok).toBe(true); // the main turn was untouched and still completed
    expect(countContainers()).toBe(before); // the ephemeral sidecar was reaped (--rm)
  });

  it("model: a real turn runs on a switched model (the /model seam, live)", async () => {
    const runner = spec.newRunner({ container: AGENT, model: "sonnet" });
    expect((await runTurn(runner, "Reply with just: A")).ok).toBe(true);
    runner.setModel?.("haiku"); // switch — takes effect on the next turn
    expect((await runTurn(runner, "Reply with just: B")).ok).toBe(true);
  });
});
