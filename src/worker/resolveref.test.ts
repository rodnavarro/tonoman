// W7 — two schemes for a credential ref, and the precedence between them.
//
// `registry:slack.bot-token` satisfies the mounted-secret grammar perfectly well. Read the old way
// it would look for a FILE at `<secrets-dir>/registry/slack.bot-token`, not find one, and return ""
// — an agent reported as having no bot token while its token sat encrypted in the registry, and no
// error anywhere to say so. That is why the prefix is checked before the split, and why it has a
// test of its own rather than only being exercised through a running worker.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseRef, registrySecret, resolveRef } from "./worker";

const env = { ...process.env };
const tmps: string[] = [];
beforeEach(() => {
  process.env.TONOMANCLOUD_API_URL = "https://api.test";
  process.env.TONOMANCLOUD_API_TOKEN = "sys-token";
});
afterEach(async () => {
  process.env = { ...env };
  for (const t of tmps.splice(0)) await fs.rm(t, { recursive: true, force: true });
});

/** A fetch that records the call and answers however the test asks. */
function recorder(answer: { status?: number; body?: unknown } | Error = {}) {
  const calls: { url: string; auth?: string }[] = [];
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), auth: (init?.headers as Record<string, string> | undefined)?.authorization });
    if (answer instanceof Error) throw answer;
    const status = answer.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => answer.body ?? {},
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { calls, impl };
}

describe("parseRef — which scheme, decided before anything is read", () => {
  it("reads the registry prefix, and keeps the whole rest as the ref name", () => {
    expect(parseRef("registry:slack.bot-token")).toEqual({ kind: "registry", ref: "slack.bot-token" });
    // A ref name with its own colon belongs entirely to the registry — splitting again here would
    // hand the API half a name.
    expect(parseRef("registry:slack:bot-token")).toEqual({ kind: "registry", ref: "slack:bot-token" });
  });

  it("anything else is a mounted secret, exactly as before", () => {
    expect(parseRef("tonoman-slack:bot-token")).toEqual({ kind: "mount", ref: "tonoman-slack:bot-token" });
  });

  it("nothing at all is nothing — not an empty registry lookup", () => {
    expect(parseRef(undefined)).toBeUndefined();
    expect(parseRef("")).toBeUndefined();
    expect(parseRef("   ")).toBeUndefined();
    expect(parseRef("registry:")).toBeUndefined();
  });
});

describe("resolveRef — the mounted scheme is untouched", () => {
  it("reads <secret>/<key> from the secrets dir and trims it", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "secrets-"));
    tmps.push(dir);
    await fs.mkdir(path.join(dir, "tonoman-slack"), { recursive: true });
    await fs.writeFile(path.join(dir, "tonoman-slack", "bot-token"), "xoxb-abc\n");
    process.env.TONOMAN_SECRETS_DIR = dir;
    expect(await resolveRef("tonoman-slack:bot-token")).toBe("xoxb-abc");
  });

  it("still refuses a ref that could climb out of the mount", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "secrets-"));
    tmps.push(dir);
    process.env.TONOMAN_SECRETS_DIR = dir;
    expect(await resolveRef("../../etc:passwd")).toBe("");
    expect(await resolveRef("a/b:c")).toBe("");
  });

  it("a missing file is empty, not an error — one agent's credential, not the worker's life", async () => {
    process.env.TONOMAN_SECRETS_DIR = path.join(os.tmpdir(), "definitely-not-here");
    expect(await resolveRef("nope:nope")).toBe("");
  });
});

describe("resolveRef — the registry scheme (W7)", () => {
  it("fetches the agent's secret and returns its value", async () => {
    const f = recorder({ body: { value: "xoxb-from-the-hub" } });
    expect(await resolveRef("registry:slack.bot-token", "g-1", f.impl)).toBe("xoxb-from-the-hub");
    expect(f.calls[0].url).toBe("https://api.test/v1/system/agents/g-1/secrets/slack.bot-token");
    expect(f.calls[0].auth).toBe("Bearer sys-token");
  });

  it("url-encodes the ref name — it comes from a web form and lands in a path", async () => {
    const f = recorder({ body: { value: "v" } });
    await resolveRef("registry:slack/bot token", "g-1", f.impl);
    expect(f.calls[0].url).toContain("/secrets/slack%2Fbot%20token");
  });

  it("is NOT read as a mounted secret — the bug this whole scheme turns on", async () => {
    // Without the prefix check, `registry:slack.bot-token` is a perfectly legal mount ref and this
    // would read a file that does not exist, quietly.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "secrets-"));
    tmps.push(dir);
    await fs.mkdir(path.join(dir, "registry"), { recursive: true });
    await fs.writeFile(path.join(dir, "registry", "slack.bot-token"), "WRONG-from-the-filesystem");
    process.env.TONOMAN_SECRETS_DIR = dir;
    const f = recorder({ body: { value: "right-from-the-registry" } });
    expect(await resolveRef("registry:slack.bot-token", "g-1", f.impl)).toBe("right-from-the-registry");
  });

  it("a 404 is empty — nothing stored yet reads the same as an unmounted file", async () => {
    const f = recorder({ status: 404 });
    expect(await resolveRef("registry:slack.app-token", "g-1", f.impl)).toBe("");
  });

  it("any other failure is empty too, and never throws into the caller", async () => {
    expect(await resolveRef("registry:x", "g-1", recorder({ status: 500 }).impl)).toBe("");
    expect(await resolveRef("registry:x", "g-1", recorder(new Error("ECONNREFUSED")).impl)).toBe("");
    // A body with no `value` is the same kind of nothing.
    expect(await resolveRef("registry:x", "g-1", recorder({ body: {} }).impl)).toBe("");
  });

  it("with no agent to scope it to, it resolves to nothing and asks nobody", async () => {
    // A secret belongs to a tenant. Fetching one without saying whose is the cross-tenant read this
    // scheme is scoped per agent to prevent, so "no guid" must not degrade into "ask anyway".
    const f = recorder({ body: { value: "leak" } });
    expect(await resolveRef("registry:slack.bot-token", undefined, f.impl)).toBe("");
    expect(f.calls).toEqual([]);
  });

  it("with no registry configured at all, a registry ref is simply empty (file roster)", async () => {
    delete process.env.TONOMANCLOUD_API_URL;
    const f = recorder({ body: { value: "x" } });
    expect(await resolveRef("registry:slack.bot-token", "g-1", f.impl)).toBe("");
    expect(f.calls).toEqual([]);
  });

  it("tolerates a trailing slash on the API base rather than producing a double slash", async () => {
    process.env.TONOMANCLOUD_API_URL = "https://api.test/";
    const f = recorder({ body: { value: "v" } });
    await registrySecret("g-1", "slack.bot-token", f.impl);
    expect(f.calls[0].url).toBe("https://api.test/v1/system/agents/g-1/secrets/slack.bot-token");
  });
});
