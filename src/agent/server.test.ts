import { describe, it, expect, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Server } from "node:http";
import { serveRuntime, encodeEvent, materializeMedia } from "./server";
import type { TurnEvent, TurnRequest, TurnRunner } from "../core/contracts";

// A canned runner: yields the given events, no process spawned (net-runtime-server).
function cannedRunner(events: TurnEvent[]): TurnRunner {
  return {
    async *run() {
      for (const e of events) yield e;
    },
  };
}

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

async function boot(opts: Parameters<typeof serveRuntime>[0]): Promise<number> {
  server = serveRuntime(opts);
  await new Promise((r) => server!.on("listening", r));
  return (server!.address() as AddressInfo).port;
}

async function readLines(res: Response): Promise<string[]> {
  const text = await res.text();
  return text.split("\n").filter(Boolean);
}

describe("agent runtime server — /turn NDJSON (net-runtime-server)", () => {
  it("streams canned TurnEvents as one JSON object per line, in order", async () => {
    const events: TurnEvent[] = [
      { kind: "text", text: "hel" },
      { kind: "text", text: "lo" },
      { kind: "done", final: "hello", usage: { inputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 2 } },
    ];
    const port = await boot({ port: 0, newRunner: () => cannedRunner(events) });
    const res = await fetch(`http://127.0.0.1:${port}/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "hi" }),
    });
    expect(res.status).toBe(200);
    const lines = (await readLines(res)).map((l) => JSON.parse(l));
    expect(lines).toEqual(events); // usage is plain data → round-trips exactly
  });

  it("encodes the error kind's Error as a string (an Error doesn't JSON-serialize)", async () => {
    const port = await boot({ port: 0, newRunner: () => cannedRunner([{ kind: "error", err: new Error("boom") }]) });
    const res = await fetch(`http://127.0.0.1:${port}/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "hi" }),
    });
    const [line] = await readLines(res);
    expect(JSON.parse(line)).toEqual({ kind: "error", err: "boom" });
  });

  it("rejects /turn without the bearer token (401), but leaves /health open", async () => {
    const port = await boot({ port: 0, token: "sekret", newRunner: () => cannedRunner([{ kind: "done", final: "x" }]) });
    const noAuth = await fetch(`http://127.0.0.1:${port}/turn`, { method: "POST", body: JSON.stringify({ prompt: "hi" }) });
    expect(noAuth.status).toBe(401);
    const withAuth = await fetch(`http://127.0.0.1:${port}/turn`, {
      method: "POST",
      headers: { authorization: "Bearer sekret" },
      body: JSON.stringify({ prompt: "hi" }),
    });
    expect(withAuth.status).toBe(200);
  });

  it("400s a missing prompt", async () => {
    const port = await boot({ port: 0, newRunner: () => cannedRunner([]) });
    const res = await fetch(`http://127.0.0.1:${port}/turn`, { method: "POST", body: JSON.stringify({}) });
    expect(res.status).toBe(400);
  });
});

describe("agent runtime server — agent-side identity (clean split)", () => {
  it("injects the pod's own identityFile as systemPromptFile when the gateway ships none", async () => {
    let seen: string | undefined = "UNSET";
    const capture: TurnRunner = {
      async *run(req) {
        seen = req.systemPromptFile;
        yield { kind: "done", final: "ok" };
      },
    };
    const port = await boot({ port: 0, identityFile: "/root/agent/AGENTS.md", newRunner: () => capture });
    await fetch(`http://127.0.0.1:${port}/turn`, { method: "POST", body: JSON.stringify({ prompt: "hi" }) }).then((r) => r.text());
    expect(seen).toBe("/root/agent/AGENTS.md");
  });

  it("gateway-shipped systemPrompt content overrides the pod identity file", async () => {
    let seen: string | undefined;
    const capture: TurnRunner = {
      async *run(req) {
        seen = req.systemPromptFile;
        yield { kind: "done", final: "ok" };
      },
    };
    const port = await boot({ port: 0, identityFile: "/root/agent/AGENTS.md", newRunner: () => capture });
    await fetch(`http://127.0.0.1:${port}/turn`, { method: "POST", body: JSON.stringify({ prompt: "hi", systemPrompt: "override" }) }).then((r) => r.text());
    expect(seen).not.toBe("/root/agent/AGENTS.md"); // a tmp file holding the shipped content
    expect(seen).toMatch(/tonoman-sysprompt-/);
  });
});

describe("agent runtime server — learned rules injected into the system prompt (learn-durable)", () => {
  it("appends LEARNED.md to the identity so the agent's durable rules are in force every turn", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tnlearned-"));
    const identity = path.join(dir, "AGENTS.md");
    const learned = path.join(dir, "LEARNED.md");
    await fs.writeFile(identity, "You are Sapien.");
    await fs.writeFile(learned, "- Always tag every receipt to an entity via --link.");
    let combined = ""; // read DURING the turn (the tmp file is cleaned up in the handler's finally)
    const capture: TurnRunner = {
      async *run(req) {
        combined = await fs.readFile(req.systemPromptFile!, "utf8");
        yield { kind: "done", final: "ok" };
      },
    };
    const port = await boot({ port: 0, identityFile: identity, learnedFile: learned, newRunner: () => capture });
    await fetch(`http://127.0.0.1:${port}/turn`, { method: "POST", body: JSON.stringify({ prompt: "hi" }) }).then((r) => r.text());
    expect(combined).toContain("You are Sapien."); // identity preserved
    expect(combined).toContain("Always tag every receipt"); // learned rule appended
    expect(combined).toContain("learned rules"); // under a clear heading
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("with no LEARNED.md, uses the mounted identity file directly (unchanged behavior)", async () => {
    let seenFile: string | undefined;
    const capture: TurnRunner = {
      async *run(req) {
        seenFile = req.systemPromptFile;
        yield { kind: "done", final: "ok" };
      },
    };
    const port = await boot({ port: 0, identityFile: "/root/agent/AGENTS.md", learnedFile: "/nope/LEARNED.md", newRunner: () => capture });
    await fetch(`http://127.0.0.1:${port}/turn`, { method: "POST", body: JSON.stringify({ prompt: "hi" }) }).then((r) => r.text());
    expect(seenFile).toBe("/root/agent/AGENTS.md"); // no tmp combine when there are no learned rules
  });
});

describe("agent runtime server — /health token-free", () => {
  it("reports cred presence without spending tokens; no auth required even when a token is set", async () => {
    const credFile = path.join(os.tmpdir(), `tonoman-cred-test-${process.pid}.json`);
    await fs.writeFile(credFile, "{}", "utf8");
    const port = await boot({ port: 0, token: "sekret", credFile, bin: "definitely-not-a-real-binary-xyz" });
    const res = await fetch(`http://127.0.0.1:${port}/health`); // no Authorization header
    expect(res.status).not.toBe(401); // health is open to k8s probes
    const j = await res.json();
    expect(j.cred).toBe(true); // saw the credential file, no LLM call
    await fs.unlink(credFile).catch(() => {});
  });
});

describe("agent runtime server — client disconnect aborts the turn (net-http-abort)", () => {
  it("aborts the runner's signal when the client drops the connection", async () => {
    let sawAbort = false;
    let resolveAborted: () => void;
    const aborted = new Promise<void>((r) => (resolveAborted = r));
    const runner: TurnRunner = {
      async *run(_req, signal) {
        yield { kind: "text", text: "hi" };
        await new Promise<void>((resolve) => {
          if (signal?.aborted) return resolve();
          signal?.addEventListener(
            "abort",
            () => {
              sawAbort = true;
              resolveAborted();
              resolve();
            },
            { once: true },
          );
        });
      },
    };
    const port = await boot({ port: 0, newRunner: () => runner });
    const ac = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/turn`, {
      method: "POST",
      body: JSON.stringify({ prompt: "hi" }),
      signal: ac.signal,
    });
    // read the first chunk, then drop the connection
    const reader = res.body!.getReader();
    await reader.read();
    ac.abort();
    await aborted;
    expect(sawAbort).toBe(true);
  });
});

describe("agent runtime server — inbound media (split-media-carried)", () => {
  it("materializeMedia writes each item under AGENT_MEDIA_DIR by basename (no traversal)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tnagentmedia-"));
    const prev = process.env.AGENT_MEDIA_DIR;
    process.env.AGENT_MEDIA_DIR = dir;
    try {
      const paths = await materializeMedia([
        { name: "receipt.pdf", b64: Buffer.from([1, 2, 3]).toString("base64") },
        { name: "../../etc/evil", b64: Buffer.from([9]).toString("base64") }, // traversal attempt
      ]);
      expect(paths).toHaveLength(2);
      // both land INSIDE dir — the "../../etc/evil" name is reduced to its basename "evil"
      for (const p of paths) expect(path.dirname(p)).toBe(dir);
      expect(paths.some((p) => path.basename(p) === "evil")).toBe(true);
      expect(await fs.readFile(paths[0])).toEqual(Buffer.from([1, 2, 3]));
    } finally {
      if (prev === undefined) delete process.env.AGENT_MEDIA_DIR;
      else process.env.AGENT_MEDIA_DIR = prev;
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("/turn hands the runner req.mediaPaths for the shipped media, then cleans the files up", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tnagentmedia-"));
    const prev = process.env.AGENT_MEDIA_DIR;
    process.env.AGENT_MEDIA_DIR = dir;
    let seen: TurnRequest | undefined;
    const capture: TurnRunner = {
      async *run(req) {
        seen = req;
        // the file must exist DURING the turn
        expect(await fs.readFile(req.mediaPaths![0])).toEqual(Buffer.from([7, 7]));
        yield { kind: "done", final: "ok" };
      },
    };
    try {
      const port = await boot({ port: 0, newRunner: () => capture });
      await fetch(`http://127.0.0.1:${port}/turn`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "here's my receipt", media: [{ name: "r.pdf", b64: Buffer.from([7, 7]).toString("base64") }] }),
      }).then((r) => r.text());
      expect(seen?.mediaPaths).toHaveLength(1);
      expect(path.basename(seen!.mediaPaths![0])).toBe("r.pdf");
      // cleaned up after the turn (per-turn media is transient)
      await expect(fs.readFile(seen!.mediaPaths![0])).rejects.toThrow();
    } finally {
      if (prev === undefined) delete process.env.AGENT_MEDIA_DIR;
      else process.env.AGENT_MEDIA_DIR = prev;
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("encodeEvent", () => {
  it("omits absent fields and stringifies the error", () => {
    expect(JSON.parse(encodeEvent({ kind: "text", text: "a" }))).toEqual({ kind: "text", text: "a" });
    expect(JSON.parse(encodeEvent({ kind: "error", err: new Error("nope") }))).toEqual({ kind: "error", err: "nope" });
    expect(JSON.parse(encodeEvent({ kind: "done", final: "f", capped: true }))).toEqual({ kind: "done", final: "f", capped: true });
  });
});

describe("agent runtime server — backend flows to the runner factory (backend-*)", () => {
  it("passes the request backend (and model) through to newRunner", async () => {
    let seen: { model?: string; maxTurns?: number; backend?: string } | undefined;
    const port = await boot({
      port: 0,
      newRunner: (o) => {
        seen = o;
        return cannedRunner([{ kind: "done", final: "x" }]);
      },
    });
    const res = await fetch(`http://127.0.0.1:${port}/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "hi", backend: "bedrock", model: "sonnet" }),
    });
    await res.text(); // drain so the handler completes
    expect(seen).toMatchObject({ backend: "bedrock", model: "sonnet" });
  });
});
