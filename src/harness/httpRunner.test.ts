import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HttpRunner, decodeEvent } from "./httpRunner";
import type { TurnEvent } from "../core/contracts";

/** A Response streaming the given NDJSON lines (uses Node's global Response + web streams). */
function ndjsonResponse(lines: string[], status = 200): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const l of lines) controller.enqueue(enc.encode(l + "\n"));
      controller.close();
    },
  });
  return new Response(stream, { status });
}

type Captured = { url?: string; init?: RequestInit };
function fakeFetch(make: () => Promise<Response>, cap?: Captured): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    if (cap) {
      cap.url = url;
      cap.init = init;
    }
    return make();
  }) as unknown as typeof fetch;
}

async function collect(it: AsyncIterable<TurnEvent>): Promise<TurnEvent[]> {
  const out: TurnEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const events = (): TurnEvent[] => [
  { kind: "text", text: "hel" },
  { kind: "text", text: "lo" },
  { kind: "done", final: "hello", usage: { inputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 2 } },
];

describe("HttpRunner — POST /turn transport (net-http-transport)", () => {
  it("streams decoded TurnEvents in order and carries prompt+model+maxTurns in the body", async () => {
    const cap: Captured = {};
    const lines = events().map((e) => JSON.stringify(e.kind === "error" ? { kind: "error", err: (e.err as Error).message } : e));
    const r = new HttpRunner({ url: "http://agent:8080/", model: "sonnet", maxTurns: 10, token: "tok", fetch: fakeFetch(async () => ndjsonResponse(lines), cap) });
    const got = await collect(r.run({ prompt: "hi" }));
    expect(got).toEqual(events());
    expect(cap.url).toBe("http://agent:8080/turn"); // trailing slash normalized
    expect((cap.init!.headers as Record<string, string>)["authorization"]).toBe("Bearer tok");
    const body = JSON.parse(cap.init!.body as string);
    expect(body).toMatchObject({ prompt: "hi", model: "sonnet", maxTurns: 10 });
  });

  it("reads req.mediaPaths off disk and ships them base64'd in body.media (split-media-carried)", async () => {
    const cap: Captured = {};
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tnmedia-"));
    const file = path.join(dir, "receipt.pdf");
    await fs.writeFile(file, Buffer.from([1, 2, 3, 4]));
    const r = new HttpRunner({ url: "http://agent", fetch: fakeFetch(async () => ndjsonResponse(['{"kind":"done","final":"x"}']), cap) });
    await collect(r.run({ prompt: "here's my receipt", mediaPaths: [file] }));
    const body = JSON.parse(cap.init!.body as string);
    expect(body.media).toEqual([{ name: "receipt.pdf", b64: Buffer.from([1, 2, 3, 4]).toString("base64") }]);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("omits body.media entirely when there are no attachments", async () => {
    const cap: Captured = {};
    const r = new HttpRunner({ url: "http://agent", fetch: fakeFetch(async () => ndjsonResponse(['{"kind":"done","final":"x"}']), cap) });
    await collect(r.run({ prompt: "hi" }));
    expect(JSON.parse(cap.init!.body as string).media).toBeUndefined();
  });

  it("keepalive lines are skipped; a mid-line chunk boundary still parses", async () => {
    const lines = ['{"kind":"keepalive"}', '{"kind":"text","text":"a"}', '{"kind":"keepalive"}', '{"kind":"done","final":"a"}'];
    const r = new HttpRunner({ url: "http://agent", fetch: fakeFetch(async () => ndjsonResponse(lines)) });
    const got = await collect(r.run({ prompt: "hi" }));
    expect(got).toEqual([{ kind: "text", text: "a" }, { kind: "done", final: "a" }]);
  });

  it("setModel takes effect on the NEXT run's body", async () => {
    const cap: Captured = {};
    const r = new HttpRunner({ url: "http://agent", model: "sonnet", fetch: fakeFetch(async () => ndjsonResponse(['{"kind":"done","final":"x"}']), cap) });
    await collect(r.run({ prompt: "1" }));
    expect(JSON.parse(cap.init!.body as string).model).toBe("sonnet");
    r.setModel("opus");
    expect(r.getModel()).toBe("opus");
    await collect(r.run({ prompt: "2" }));
    expect(JSON.parse(cap.init!.body as string).model).toBe("opus");
  });

  it("sends the system prompt as CONTENT read from systemPromptFile (not the path)", async () => {
    const cap: Captured = {};
    const f = path.join(os.tmpdir(), `tonoman-sp-test-${process.pid}.md`);
    await fs.writeFile(f, "You are Atlas.", "utf8");
    const r = new HttpRunner({ url: "http://agent", fetch: fakeFetch(async () => ndjsonResponse(['{"kind":"done","final":"x"}']), cap) });
    await collect(r.run({ prompt: "hi", systemPromptFile: f }));
    const body = JSON.parse(cap.init!.body as string);
    expect(body.systemPrompt).toBe("You are Atlas.");
    expect(body.systemPromptFile).toBeUndefined();
    await fs.unlink(f).catch(() => {});
  });
});

describe("HttpRunner — error surfacing (net-http-error-terminal)", () => {
  it("rehydrates an error line into an Error event", async () => {
    const r = new HttpRunner({ url: "http://agent", fetch: fakeFetch(async () => ndjsonResponse(['{"kind":"error","err":"boom"}'])) });
    const got = await collect(r.run({ prompt: "hi" }));
    expect(got).toHaveLength(1);
    expect(got[0].kind).toBe("error");
    expect(got[0].err).toBeInstanceOf(Error);
    expect(got[0].err!.message).toBe("boom");
  });

  it("a non-2xx response yields exactly one terminal error (no throw)", async () => {
    const r = new HttpRunner({ url: "http://agent", fetch: fakeFetch(async () => new Response("nope", { status: 502 })) });
    const got = await collect(r.run({ prompt: "hi" }));
    expect(got).toHaveLength(1);
    expect(got[0].kind).toBe("error");
    expect(got[0].err!.message).toMatch(/502/);
  });

  it("a fetch that throws yields one connect error", async () => {
    const r = new HttpRunner({ url: "http://agent", fetch: (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch });
    const got = await collect(r.run({ prompt: "hi" }));
    expect(got).toHaveLength(1);
    expect(got[0].err!.message).toMatch(/connect .*ECONNREFUSED/);
  });

  it("a clean stream with no done/error yields a 'no result' terminal error", async () => {
    const r = new HttpRunner({ url: "http://agent", fetch: fakeFetch(async () => ndjsonResponse(['{"kind":"text","text":"partial"}'])) });
    const got = await collect(r.run({ prompt: "hi" }));
    expect(got[got.length - 1].kind).toBe("error");
    expect(got[got.length - 1].err!.message).toMatch(/no result/);
  });
});

describe("HttpRunner — abort is intentional (net-http-abort)", () => {
  it("an aborted signal ends the generator with NO error event", async () => {
    const ac = new AbortController();
    ac.abort();
    const r = new HttpRunner({
      url: "http://agent",
      fetch: (async () => { throw new DOMException("aborted", "AbortError"); }) as unknown as typeof fetch,
    });
    const got = await collect(r.run({ prompt: "hi" }, ac.signal));
    expect(got).toEqual([]); // aborted → the Router decides; the runner stays silent
  });
});

describe("decodeEvent", () => {
  it("skips keepalive, rehydrates error, passes through data events", () => {
    expect(decodeEvent('{"kind":"keepalive"}')).toBeNull();
    expect(decodeEvent("not json")).toBeNull();
    const e = decodeEvent('{"kind":"error","err":"x"}')!;
    expect(e.kind).toBe("error");
    expect(e.err).toBeInstanceOf(Error);
    expect(decodeEvent('{"kind":"text","text":"hi"}')).toEqual({ kind: "text", text: "hi" });
  });
});

describe("HttpRunner — backend rides the body + is live-switchable (backend-switch-live)", () => {
  const done = ['{"kind":"done","final":"x"}'];

  it("carries the configured backend in the /turn body (backend-config-default)", async () => {
    const cap: Captured = {};
    const r = new HttpRunner({ url: "http://agent", backend: "bedrock", fetch: fakeFetch(async () => ndjsonResponse(done), cap) });
    await collect(r.run({ prompt: "hi" }));
    expect(JSON.parse(cap.init!.body as string).backend).toBe("bedrock");
  });

  it("setBackend takes effect on the NEXT run's body (backend-switch-live)", async () => {
    const cap: Captured = {};
    const r = new HttpRunner({ url: "http://agent", backend: "bedrock", fetch: fakeFetch(async () => ndjsonResponse(done), cap) });
    await collect(r.run({ prompt: "a" }));
    expect(JSON.parse(cap.init!.body as string).backend).toBe("bedrock");
    r.setBackend("subscription");
    await collect(r.run({ prompt: "b" }));
    expect(JSON.parse(cap.init!.body as string).backend).toBe("subscription");
    expect(r.getBackend()).toBe("subscription");
  });

  it("omits backend from the body when unset (back-compat)", async () => {
    const cap: Captured = {};
    const r = new HttpRunner({ url: "http://agent", fetch: fakeFetch(async () => ndjsonResponse(done), cap) });
    await collect(r.run({ prompt: "hi" }));
    expect(JSON.parse(cap.init!.body as string).backend).toBeUndefined();
  });
});
