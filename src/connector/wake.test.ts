import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConvStore } from "./convstore";
import { withWake } from "./wake";
import type { Connector, Envelope, Reply } from "../core/contracts";

/** A connector that yields nothing and never ends — the wake supplies the traffic. */
function silentConnector(): Connector {
  return {
    name: () => "test",
    reply: () => ({}) as Reply,
    async *receive(signal: AbortSignal) {
      await new Promise<void>((r) => signal.addEventListener("abort", () => r(), { once: true }));
    },
  };
}

async function post(port: number, body: unknown, token?: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/api/wake`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("gw-wake — a system can start the conversation", () => {
  it("turns an authenticated POST into an ordinary envelope addressed by PERSON", async () => {
    const store = new ConvStore<{ id: string }>();
    store.put("conv-42", { id: "conv-42" }, ["rod@example.com", "Rod Navarro"]);

    const ac = new AbortController();
    const conn = withWake(silentConnector(), { token: "s3cret", port: 3991, store });
    const got: Envelope[] = [];
    const pump = (async () => {
      for await (const env of conn.receive(ac.signal)) got.push(env);
    })();
    await new Promise((r) => setTimeout(r, 120));

    // "rod" resolves via the local part of the verified email — a caller never
    // has to know the channel's conversation id.
    const res = await post(3991, { person: "rod", text: "a draft is ready; tell Rod" }, "s3cret");
    expect(res.status).toBe(202);
    await new Promise((r) => setTimeout(r, 120));

    expect(got).toHaveLength(1);
    expect(got[0].conversation).toBe("conv-42");
    expect(got[0].text).toContain("a draft is ready");
    // Same shape as a typed message, which is why everything downstream works.
    expect(got[0].channel).toBe("test");
    expect(got[0].mediaPaths).toEqual([]);

    ac.abort();
    await pump;
  });

  it("refuses without the shared secret, and 404s an unknown person rather than dropping it", async () => {
    const store = new ConvStore<{ id: string }>();
    const ac = new AbortController();
    const conn = withWake(silentConnector(), { token: "s3cret", port: 3992, store });
    const pump = (async () => {
      for await (const _ of conn.receive(ac.signal)) void _;
    })();
    await new Promise((r) => setTimeout(r, 120));

    expect((await post(3992, { person: "rod", text: "hi" })).status).toBe(401);
    expect((await post(3992, { person: "rod", text: "hi" }, "wrong")).status).toBe(401);
    // Nobody has ever messaged the agent: say so loudly. A silent 200 here is
    // how a client ends up never hearing from anyone.
    expect((await post(3992, { person: "ghost", text: "hi" }, "s3cret")).status).toBe(404);

    ac.abort();
    await pump;
  });

  it("is not served at all when no token is configured", async () => {
    const store = new ConvStore<{ id: string }>();
    const ac = new AbortController();
    const conn = withWake(silentConnector(), { port: 3993, store });
    const pump = (async () => {
      for await (const _ of conn.receive(ac.signal)) void _;
    })();
    await new Promise((r) => setTimeout(r, 120));

    await expect(post(3993, { person: "rod", text: "hi" })).rejects.toThrow();

    ac.abort();
    await pump;
  });
});

describe("teams-conversation-reference — surviving a restart", () => {
  it("a persisted reference is still addressable by a brand new store", () => {
    const dir = mkdtempSync(join(tmpdir(), "convstore-"));
    const file = join(dir, "conversations.json");
    try {
      const first = new ConvStore<{ serviceUrl: string }>({ file });
      first.put("conv-1", { serviceUrl: "https://smba.example/" }, ["rod@example.com"]);

      // A fresh process, as after a gateway restart. Without persistence the
      // agent can still ANSWER but can never speak first — and fails silently.
      const second = new ConvStore<{ serviceUrl: string }>({ file });
      const found = second.resolve("rod");
      expect(found?.conversation).toBe("conv-1");
      expect(found?.ref.serviceUrl).toBe("https://smba.example/");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accumulates aliases rather than replacing them", () => {
    const store = new ConvStore<{ n: number }>();
    store.put("c1", { n: 1 }, ["aad-123"]);          // first activity: only an aad id
    store.put("c1", { n: 2 }, ["rod@example.com"]);  // later: the resolved email
    expect(store.resolve("aad-123")?.conversation).toBe("c1");
    expect(store.resolve("rod@example.com")?.conversation).toBe("c1");
    expect(store.resolve("rod")?.conversation).toBe("c1");
    expect(store.get("c1")).toEqual({ n: 2 });
  });
});
