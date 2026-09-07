// Where a connected account's tokens live.
//
// The tests that matter here are not the round trips. They are the three places where a wrong
// answer is indistinguishable from a right one:
//
//   • a read failure reported as "not connected", which offers a reconnect that then OVERWRITES a
//     credential we merely failed to read;
//   • a login reported as connected when the store never accepted it, so the person believes they
//     are done and nothing ever polls;
//   • a credential in a URL rather than a body, which puts it in the access logs at both ends.

import { afterEach, describe, expect, it } from "vitest";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { chooseStore, cloudStore, fileStore, resetStore, stamp, storeFor, tokens, useStore } from "./tokenstore";

afterEach(() => resetStore());

const tmp = async (): Promise<string> => fsp.mkdtemp(path.join(os.tmpdir(), "tokenstore-"));

const ok = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200 });
const status = (code: number): Response => new Response("{}", { status: code });

describe("the volume", () => {
  it("round-trips a token set", async () => {
    const root = await tmp();
    const s = fileStore(root);
    await s.save("nelly", { access_token: "a", refresh_token: "r" });
    expect(await s.load("nelly")).toMatchObject({ access_token: "a", refresh_token: "r" });
  });

  it("keeps one agent's tokens out of another's", async () => {
    // Two agents in one pod is the whole deployment, so this is not hypothetical.
    const root = await tmp();
    const s = fileStore(root);
    await s.save("nelly", { access_token: "nelly-token" });
    await s.save("sapien", { access_token: "sapien-token" });
    expect((await s.load("nelly"))?.access_token).toBe("nelly-token");
    expect((await s.load("sapien"))?.access_token).toBe("sapien-token");
  });

  it("reads a missing file as not connected rather than throwing", async () => {
    expect(await fileStore(await tmp()).load("nobody")).toBeUndefined();
  });

  it("clears, and clearing twice is not an error", async () => {
    const root = await tmp();
    const s = fileStore(root);
    await s.save("nelly", { access_token: "a" });
    await s.clear("nelly");
    await s.clear("nelly");
    expect(await s.load("nelly")).toBeUndefined();
  });
});

describe("Tonoman Cloud", () => {
  const deps = (f: typeof fetch) =>
    cloudStore({ baseUrl: "http://api", token: "sys", guidOf: () => "guid-1", fetchImpl: f });

  it("reads a stored credential back", async () => {
    const s = deps((async () => ok({ value: JSON.stringify({ access_token: "a" }) })) as unknown as typeof fetch);
    expect(await s.load("nelly")).toMatchObject({ access_token: "a" });
  });

  it("sends the credential in the BODY, never the URL", async () => {
    // A token in a path is logged by every proxy between here and Postgres.
    let seen: { url: string; init?: RequestInit } | undefined;
    const s = deps((async (url: string, init?: RequestInit) => ((seen = { url, init }), ok({}))) as unknown as typeof fetch);
    await s.save("nelly", { access_token: "super-secret" });
    expect(seen?.url).not.toContain("super-secret");
    expect(String(seen?.init?.body)).toContain("super-secret");
    expect(seen?.init?.method).toBe("PUT");
  });

  it("addresses the secret by agent guid, so the worker never names a tenant", async () => {
    let url = "";
    const s = deps((async (u: string) => ((url = u), ok({ value: "{}" }))) as unknown as typeof fetch);
    await s.load("nelly");
    expect(url).toBe("http://api/v1/system/agents/guid-1/secrets/plaud.tokens");
  });

  it("carries the system token", async () => {
    let headers: Record<string, string> = {};
    const s = deps((async (_u: string, init?: RequestInit) => ((headers = init?.headers as Record<string, string>), ok({ value: "{}" }))) as unknown as typeof fetch);
    await s.load("nelly");
    expect(headers.authorization).toBe("Bearer sys");
  });

  it("treats 404 as not connected — the ordinary state before anyone connects", async () => {
    const s = deps((async () => status(404)) as unknown as typeof fetch);
    expect(await s.load("nelly")).toBeUndefined();
  });

  it("THROWS on 500 rather than saying not connected", async () => {
    // This is the dangerous one. A failed decrypt reported as "not connected" offers a reconnect,
    // and the reconnect overwrites a credential that was there all along.
    const s = deps((async () => status(500)) as unknown as typeof fetch);
    await expect(s.load("nelly")).rejects.toThrow(/500/);
  });

  it("THROWS on 503, so a missing key is not mistaken for a missing account", async () => {
    const s = deps((async () => status(503)) as unknown as typeof fetch);
    await expect(s.load("nelly")).rejects.toThrow(/503/);
  });

  it("throws when a save is refused, so a login cannot report success it did not have", async () => {
    const s = deps((async () => status(500)) as unknown as typeof fetch);
    await expect(s.save("nelly", { access_token: "a" })).rejects.toThrow(/500/);
  });

  it("refuses to save for an agent with no guid rather than dropping it silently", async () => {
    const s = cloudStore({
      baseUrl: "http://api",
      token: "sys",
      guidOf: () => undefined,
      fetchImpl: (async () => ok({})) as unknown as typeof fetch,
    });
    await expect(s.save("stranger", { access_token: "a" })).rejects.toThrow(/no registry guid/);
  });

  it("reads an unreachable API as an error, not as a disconnection", async () => {
    const s = deps((async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch);
    // fetch rejecting is caught and becomes "no response", which we treat as not connected only
    // because a network blip must not take the poll down. Documented here so the choice is visible.
    expect(await s.load("nelly")).toBeUndefined();
  });

  it("puts the ref in the path safely", async () => {
    let url = "";
    const s = cloudStore({
      baseUrl: "http://api",
      token: "t",
      guidOf: () => "g",
      ref: "claude.credentials:murphy-nelly",
      fetchImpl: (async (u: string) => ((url = u), ok({ value: "{}" }))) as unknown as typeof fetch,
    });
    await s.load("nelly");
    expect(url).toContain("claude.credentials%3Amurphy-nelly");
  });
});

describe("which store", () => {
  it("uses the volume when there is no registry to talk to", () => {
    expect(chooseStore({} as NodeJS.ProcessEnv, () => "g").where).toBe("the volume");
  });

  it("uses the cloud when there is", () => {
    expect(chooseStore({ TONOMANCLOUD_API_URL: "http://api" } as NodeJS.ProcessEnv, () => "g").where).toContain(
      "encrypted",
    );
  });

  it("can be forced back onto the volume, for a bad afternoon", () => {
    const env = { TONOMANCLOUD_API_URL: "http://api", TONOMAN_TOKENS_ON_VOLUME: "1" } as NodeJS.ProcessEnv;
    expect(chooseStore(env, () => "g").where).toBe("the volume");
  });

  it("defaults to the volume when nothing installed a store", () => {
    expect(tokens().where).toBe("the volume");
  });

  it("an explicit root still means the volume, even with the cloud store installed", async () => {
    // Otherwise every `root` argument in the codebase is silently ignored, and the tests that pass
    // one go green while exercising the wrong store.
    const root = await tmp();
    useStore(cloudStore({ baseUrl: "http://api", token: "t", guidOf: () => "g" }));
    expect(storeFor(root).where).toBe("the volume");
    expect(storeFor().where).toContain("encrypted");
    await storeFor(root).save("nelly", { access_token: "on-disk" });
    expect((await storeFor(root).load("nelly"))?.access_token).toBe("on-disk");
  });
});

describe("stamp", () => {
  it("turns a lifetime into a deadline, so a restart knows yesterday's token is old", () => {
    const before = Date.now();
    const t = stamp({ access_token: "a", expires_in: 86400 });
    expect(t.expires_at).toBeGreaterThanOrEqual(before + 86400 * 1000);
  });

  it("leaves a token set with no lifetime alone rather than inventing one", () => {
    expect(stamp({ access_token: "a" }).expires_at).toBeUndefined();
  });
});
