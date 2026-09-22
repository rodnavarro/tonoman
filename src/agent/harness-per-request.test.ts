// W1 — the runtime honours the harness the CALLER names, over its own env default.
//
// One agent runtime holds both CLIs and both credential stores, and one worker serves a whole
// tenant whose agents can answer on two different providers. So TONOMAN_HARNESS is a DEFAULT, not
// a fact: a request that says `?harness=codex` must get codex's spec, codex's login and status
// commands, codex's credential file and codex's config home — and a request that says nothing must
// keep behaving exactly as it did before this existed.
//
// The failure these pin down is quiet: every one of them "works" against the wrong account, and
// reports success.

import { describe, it, expect, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Server } from "node:http";
import { serveRuntime } from "./server";
import type { TurnEvent, TurnRunner } from "../core/contracts";
import * as claudecode from "../harness/claudecode";
import * as codex from "../harness/codex";

let server: Server | undefined;
const tmps: string[] = [];
afterEach(async () => {
  server?.close();
  server = undefined;
  delete process.env.TONOMAN_HARNESS;
  for (const t of tmps.splice(0)) await fs.rm(t, { recursive: true, force: true });
});

async function boot(opts: Parameters<typeof serveRuntime>[0]): Promise<number> {
  server = serveRuntime(opts);
  await new Promise((r) => server!.on("listening", r));
  return (server!.address() as AddressInfo).port;
}

const canned = (events: TurnEvent[]): TurnRunner => ({
  async *run() {
    for (const e of events) yield e;
  },
});

describe("codex.configHomeFor — the codex counterpart of claudecode's (W1)", () => {
  it("mirrors claudecode exactly, under codex's own root", () => {
    expect(codex.configHomeFor(undefined)).toBe(codex.CONFIG_HOME);
    expect(codex.configHomeFor("sapien")).toBe("/root/.codex/agents/sapien");
    expect(codex.configHomeFor("sapien", "U123")).toBe("/root/.codex/agents/sapien/users/U123");
  });

  it("sanitises both halves the same way — they arrive over the wire and decide a path", () => {
    expect(codex.configHomeFor("../../etc")).toBe("/root/.codex/agents/etc");
    expect(codex.configHomeFor("sapien", "../root")).toBe("/root/.codex/agents/sapien/users/root");
  });

  it("a name that was GIVEN but sanitises away gets a dir of its own, never the shared one", () => {
    // Falling back to the pool's home here would hand the shared credential to whatever nonsense
    // was supplied — the exact hazard claudecode's version was written to avoid.
    expect(codex.configHomeFor("///")).toBe("/root/.codex/agents/_invalid");
    expect(codex.configHomeFor("sapien", "///")).toBe("/root/.codex/agents/sapien/users/_invalid");
    expect(codex.configHomeFor("///")).not.toBe(codex.CONFIG_HOME);
  });

  it("the two providers never share a directory", () => {
    expect(codex.configHomeFor("sapien", "U1")).not.toBe(claudecode.configHomeFor("sapien", "U1"));
  });
});

describe("codex.localEnv — CODEX_HOME per turn (W1)", () => {
  it("points CODEX_HOME at the config home it is given, and never lets an API key outrank the sub", () => {
    const env = codex.localEnv({ OPENAI_API_KEY: "sk-nope" }, "/root/.codex/agents/sapien/users/U1");
    expect(env.CODEX_HOME).toBe("/root/.codex/agents/sapien/users/U1");
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });
  it("defaults to the shared home when nobody is named", () => {
    expect(codex.localEnv({}).CODEX_HOME).toBe(codex.CONFIG_HOME);
  });
});

describe("/turn — the harness rides the body (W1)", () => {
  const seen: { harness?: string }[] = [];
  const spy = (o: { harness?: string }): TurnRunner => {
    seen.push({ harness: o.harness });
    return canned([{ kind: "done", final: "ok" }]);
  };

  it("hands the runner factory the harness the body named", async () => {
    seen.length = 0;
    const port = await boot({ port: 0, newRunner: spy });
    await fetch(`http://127.0.0.1:${port}/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "hi", harness: "codex" }),
    });
    expect(seen).toEqual([{ harness: "codex" }]);
  });

  it("falls back to the pod default when the body says nothing (an older gateway is unchanged)", async () => {
    seen.length = 0;
    process.env.TONOMAN_HARNESS = "codex";
    const port = await boot({ port: 0, newRunner: spy });
    await fetch(`http://127.0.0.1:${port}/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "hi" }),
    });
    expect(seen).toEqual([{ harness: "codex" }]);
  });

  it("the REQUEST beats the env: a claude turn on a codex-default pod runs claude", async () => {
    seen.length = 0;
    process.env.TONOMAN_HARNESS = "codex";
    const port = await boot({ port: 0, newRunner: spy });
    await fetch(`http://127.0.0.1:${port}/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "hi", harness: "claude-code" }),
    });
    expect(seen).toEqual([{ harness: "claude-code" }]);
  });
});

// The status command, the config home and the env var that points at it all differ per harness.
// These run a FAKE status binary (node) so the assertions are about our plumbing, not about codex.
describe("/auth/status — the harness the caller named decides everything (W1)", () => {
  async function bootWithEcho(): Promise<number> {
    // Echoes the env var that matters, so the response proves which config home was used.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-req-"));
    tmps.push(dir);
    const script = path.join(dir, "echo-home.js");
    await fs.writeFile(
      script,
      "process.stdout.write(`CLAUDE=${process.env.CLAUDE_CODE_DIR_PROBE ?? process.env.CLAUDE_CONFIG_DIR ?? ''} CODEX=${process.env.CODEX_HOME ?? ''} logged in`);",
    );
    return boot({ port: 0, statusArgs: [process.execPath, script] });
  }

  it("a codex request is answered out of CODEX_HOME, not CLAUDE_CONFIG_DIR", async () => {
    const port = await bootWithEcho();
    const res = await fetch(`http://127.0.0.1:${port}/auth/status?agent=sapien&user=U1&harness=codex`);
    const j = (await res.json()) as { status: string };
    expect(j.status).toContain(`CODEX=${codex.configHomeFor("sapien", "U1")}`);
    expect(j.status).toContain("CLAUDE= ");
  });

  it("a claude request is answered out of CLAUDE_CONFIG_DIR, not CODEX_HOME", async () => {
    const port = await bootWithEcho();
    const res = await fetch(`http://127.0.0.1:${port}/auth/status?agent=sapien&user=U1&harness=claude-code`);
    const j = (await res.json()) as { status: string };
    expect(j.status).toContain(`CLAUDE=${claudecode.configHomeFor("sapien", "U1")}`);
    expect(j.status).toContain("CODEX=");
    expect(j.status).not.toContain(`CODEX=${codex.configHomeFor("sapien", "U1")}`);
  });

  it('"Not logged in" is reported as NOT logged in (the codex wording)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-req-"));
    tmps.push(dir);
    const script = path.join(dir, "not.js");
    await fs.writeFile(script, "process.stdout.write('Not logged in');");
    const port = await boot({ port: 0, statusArgs: [process.execPath, script] });
    const res = await fetch(`http://127.0.0.1:${port}/auth/status?agent=sapien&harness=codex`);
    expect(await res.json()).toMatchObject({ loggedIn: false, status: "Not logged in" });
  });
});
