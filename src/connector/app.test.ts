// channel-app: the Tonoman client's surface on the gateway. The load-bearing claim these
// tests defend is that a scanned document reaches the agent through the EXISTING media path
// (Envelope.mediaPaths) with no harness or agent change — so an agent like sapien needs no
// edit to receive a scan.

import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AppConnector, safeName } from "./app";
import type { Envelope } from "../core/contracts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

async function start(opts?: { mediaMount?: string }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "app-conn-"));
  const conn = new AppConnector({
    port: 0,
    mediaDir: dir,
    mediaMount: opts?.mediaMount,
    agent: { name: "sapien", role: "the axiplex agent" },
    allowedOrigins: ["https://app.axiplex.com"],
    // no verifier => open API (the dev path); auth itself is covered in cloudauth.test.ts
  });
  const ac = new AbortController();
  const seen: Envelope[] = [];
  const pump = (async () => {
    for await (const env of conn.receive(ac.signal)) seen.push(env);
  })();
  // receive() binds before it yields; wait for the port rather than sleeping a guess.
  for (let i = 0; i < 200 && conn.boundPort === 0; i++) await new Promise((r) => setTimeout(r, 10));
  cleanups.push(() => {
    ac.abort();
    void pump.catch(() => {});
    void fs.rm(dir, { recursive: true, force: true });
  });
  return { conn, dir, seen, base: `http://127.0.0.1:${conn.boundPort}` };
}

/** Waits for a condition instead of sleeping — the inbox is filled asynchronously. */
async function until(f: () => boolean, ms = 2000): Promise<void> {
  const t0 = Date.now();
  while (!f()) {
    if (Date.now() - t0 > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("AppConnector — the client surface (channel-app)", () => {
  it("serves the roster so the client can list this gateway's agents", async () => {
    const { base } = await start();
    const r = await fetch(`${base}/api/agents`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ agents: [{ name: "sapien", role: "the axiplex agent" }] });
  });

  it("an uploaded scan lands on the shared mount and rides Envelope.mediaPaths to the agent", async () => {
    // This is the no-agent-change claim, end to end.
    const { base, dir, seen } = await start({ mediaMount: "/home/agent/media" });
    const pdf = Buffer.from("%PDF-1.4 fake scan");
    const up = await fetch(`${base}/api/media`, {
      method: "POST",
      headers: { "x-filename": "scan.pdf" },
      body: pdf,
    });
    expect(up.status).toBe(200);
    const { path: mediaPath, bytes } = (await up.json()) as { path: string; bytes: number };
    expect(bytes).toBe(pdf.length);
    // The path handed back is the AGENT's view (the mount), never the gateway's host path.
    expect(mediaPath.startsWith("/home/agent/media/")).toBe(true);
    // …and the bytes really are on the host side of that mount.
    const written = await fs.readFile(path.join(dir, mediaPath.split("/").pop()!));
    expect(written.equals(pdf)).toBe(true);

    const send = await fetch(`${base}/api/chat/app-1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "file this receipt", mediaPaths: [mediaPath] }),
    });
    expect(send.status).toBe(202);

    await until(() => seen.length > 0);
    expect(seen[0].channel).toBe("app");
    expect(seen[0].conversation).toBe("app-1");
    expect(seen[0].text).toBe("file this receipt");
    expect(seen[0].mediaPaths).toEqual([mediaPath]);
  });

  it("REFUSES a mediaPath it did not hand out — otherwise the field reads any host file", async () => {
    // The agent Reads whatever path it is given, so an unvalidated mediaPaths is an
    // arbitrary-file-read primitive aimed straight at the model.
    const { base, seen } = await start({ mediaMount: "/home/agent/media" });
    for (const evil of [
      "/etc/passwd",
      "/home/agent/media/../../etc/shadow",
      "/home/agent/media/sub/dir/x.pdf",
      "/home/agent/mediaXX/x.pdf",
    ]) {
      const r = await fetch(`${base}/api/chat/app-evil/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "", mediaPaths: [evil] }),
      });
      // Nothing left after filtering + no text => the message is empty, so it is rejected.
      expect(r.status).toBe(400);
    }
    expect(seen).toHaveLength(0);
  });

  it("streams a reply over SSE as progressive in-place edits", async () => {
    const { base, conn } = await start();
    const es = await fetch(`${base}/api/chat/app-2/stream`);
    const reader = es.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const readUntil = async (pred: (s: string) => boolean) => {
      for (let i = 0; i < 100 && !pred(buf); i++) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
      }
      return buf;
    };
    await readUntil((s) => s.includes("connected"));

    const reply = conn.reply("app-2");
    const id = await reply.send("Fil");
    await reply.update(id, "Filing");
    await reply.finalize(id, "Filing the receipt — done.");

    const out = await readUntil((s) => s.includes('"final"'));
    expect(out).toContain('"type":"message"');
    expect(out).toContain('"type":"update"');
    expect(out).toContain("Filing the receipt — done.");
    // canEdit drives the shared streamer's progressive path — the same fidelity Telegram
    // gets from editMessageText, so no app-specific branch is needed in the streamer.
    expect(reply.canEdit()).toBe(true);
    reader.cancel().catch(() => {});
  });

  it("only sends CORS headers to an allow-listed origin", async () => {
    const { base } = await start();
    const ok = await fetch(`${base}/api/agents`, { headers: { origin: "https://app.axiplex.com" } });
    expect(ok.headers.get("access-control-allow-origin")).toBe("https://app.axiplex.com");
    const bad = await fetch(`${base}/api/agents`, { headers: { origin: "https://evil.test" } });
    expect(bad.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("rejects an empty message rather than burning a turn on nothing", async () => {
    const { base } = await start();
    const r = await fetch(`${base}/api/chat/app-3/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "   " }),
    });
    expect(r.status).toBe(400);
  });
});

describe("safeName — the client never chooses WHERE a file lands", () => {
  it("strips directory components rather than escaping them", () => {
    expect(safeName("../../etc/passwd")).toBe("passwd");
    expect(safeName("/abs/path/scan.pdf")).toBe("scan.pdf");
    expect(safeName("C:\\Users\\x\\scan.pdf")).toBe("scan.pdf");
  });
  it("neutralizes leading dots and exotic characters", () => {
    expect(safeName(".bashrc").startsWith("_")).toBe(true);
    expect(safeName("a b;rm -rf.pdf")).toBe("a_b_rm_-rf.pdf");
  });
  it("never returns empty", () => {
    expect(safeName("").length).toBeGreaterThan(0);
    expect(safeName("///").length).toBeGreaterThan(0);
  });
});
