// A pool says it is alive (worker-pool.md in Tonoman Cloud).
import { describe, it, expect } from "vitest";
import { beat, isPoolCredential, startHeartbeat } from "./heartbeat";

const answer = (status: number, body: unknown) => ({ status, ok: status >= 200 && status < 300, json: async () => body }) as Response;

describe("POOL-HEARTBEATS", () => {
  it("POOL-HEARTBEATS only a worker on a pool credential heartbeats; the platform's fleet does not", () => {
    expect(isPoolCredential("tpc_abc")).toBe(true);
    expect(isPoolCredential("some-platform-token")).toBe(false);
    expect(isPoolCredential(undefined)).toBe(false);
  });

  it("POOL-HEARTBEATS a beat is a PUT with the version on the pool's credential, and reads back whether the release is still served", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return answer(200, { ok: true, outdated: true, releases: { current: "v0.3.0", previous: "v0.2.0" } });
    }) as unknown as typeof fetch;
    const r = await beat({ baseUrl: "https://api.example.com/", token: "tpc_x", version: "v0.1.0", fetchImpl });
    expect(seen[0]!.url).toBe("https://api.example.com/v1/pool/heartbeat");
    expect(seen[0]!.init.method).toBe("PUT");
    expect((seen[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer tpc_x");
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual({ version: "v0.1.0" });
    expect(r).toEqual({ ok: true, outdated: true, releases: { current: "v0.3.0", previous: "v0.2.0" } });
  });

  it("POOL-REVOKED-WITHIN-A-MINUTE a revoked credential is said once as such, and a recovery once; the outdated release once", async () => {
    let status = 401;
    const fetchImpl = (async () => answer(status, status === 200 ? { ok: true, outdated: true, releases: { current: "v9", previous: "v8" } } : {})) as unknown as typeof fetch;
    const lines: string[] = [];
    const stop = startHeartbeat({ baseUrl: "http://x", token: "tpc_x", version: "v1", intervalMs: 20, fetchImpl, log: (l) => lines.push(l) });
    await new Promise((r) => setTimeout(r, 70));
    status = 200;
    await new Promise((r) => setTimeout(r, 70));
    stop();
    expect(lines.filter((l) => /heartbeat failed/.test(l)).length).toBe(1);
    expect(lines.filter((l) => /revoked/.test(l)).length).toBe(1);
    expect(lines.filter((l) => /heartbeat back/.test(l)).length).toBe(1);
    expect(lines.filter((l) => /no longer served/.test(l)).length).toBe(1);
    expect(lines.find((l) => /no longer served/.test(l))).toMatch(/current is v9, previous v8/);
  });
});
