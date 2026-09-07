import { describe, it, expect, vi, afterEach } from "vitest";
import {
  parseStatusMode,
  contextPercent,
  compactTokens,
  parseAccountUsage,
  fmtReset,
  fmtResetShort,
  renderSmall,
  renderFull,
  renderStatus,
  fetchRemoteAccountUsage,
  remoteAccountUsageCached,
} from "./statusline";
import type { TurnUsage } from "./core/contracts";

const U: TurnUsage = {
  inputTokens: 2470,
  cacheWriteTokens: 18623,
  cacheReadTokens: 0,
  outputTokens: 4,
  costUsd: 0.1998,
  contextTokens: 21093,
};

describe("statusline pure helpers (gw-command-statusline)", () => {
  it("parseStatusMode accepts none|small|full, rejects junk", () => {
    expect(parseStatusMode("none")).toBe("none");
    expect(parseStatusMode("SMALL")).toBe("small");
    expect(parseStatusMode(" full ")).toBe("full");
    expect(parseStatusMode("verbose")).toBeUndefined();
  });

  it("compactTokens humanizes counts", () => {
    expect(compactTokens(940)).toBe("940");
    expect(compactTokens(2470)).toBe("2.5k");
    expect(compactTokens(18623)).toBe("18.6k");
    expect(compactTokens(1_200_000)).toBe("1.2M");
  });

  it("contextPercent uses the peak single-call occupancy (contextTokens), capped at 100", () => {
    expect(contextPercent(U)).toBe(Math.round((100 * 21093) / 200000)); // no window ⇒ 200k default ⇒ ~11%
    expect(contextPercent({ ...U, contextWindow: 1_000_000 })).toBe(2); // opus 1M window ⇒ same occupancy is tiny
    // the summed totals would over-count (re-read cache each iteration) → cap at 100
    expect(contextPercent({ inputTokens: 50000, cacheWriteTokens: 300000, cacheReadTokens: 400000, outputTokens: 9 })).toBe(100);
    expect(contextPercent({ inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 })).toBe(0);
  });

  it("parseAccountUsage maps five_hour/seven_day, normalizes util (0-1 or 0-100)", () => {
    const w = parseAccountUsage({
      five_hour: { utilization: 7, resets_at: "2026-06-18T06:30:00Z" },
      seven_day: { utilization: 0.19, resets_at: "2026-06-22T01:00:00Z" },
      other: { utilization: 50 },
    });
    expect(w).toEqual([
      { key: "5h", usedPct: 7, resetAt: "2026-06-18T06:30:00Z" },
      { key: "7d", usedPct: 19, resetAt: "2026-06-22T01:00:00Z" },
    ]);
  });

  it("parseAccountUsage skips windows with no utilization and tolerates junk", () => {
    expect(parseAccountUsage({ five_hour: {} })).toEqual([]);
    expect(parseAccountUsage(null)).toEqual([]);
  });

  it("fmtReset gives a short relative time", () => {
    const now = Date.parse("2026-06-18T00:00:00Z");
    expect(fmtReset("2026-06-18T06:30:00Z", now)).toBe("in 6h 30m");
    expect(fmtReset("2026-06-22T00:00:00Z", now)).toBe("in 4d 0h");
    expect(fmtReset("2026-06-17T23:00:00Z", now)).toBe("now");
    expect(fmtReset(undefined, now)).toBe("");
  });

  it("renderSmall is one line with tokens, context, windows, and time-to-reset", () => {
    const now = Date.parse("2026-06-18T00:00:00Z");
    const w = [
      { key: "5h", usedPct: 7, resetAt: "2026-06-18T04:50:00Z" },
      { key: "7d", usedPct: 19, resetAt: "2026-06-23T03:00:00Z" },
    ];
    const line = renderSmall(U, "sonnet", w, now);
    // No icon, and no orphaned separator where it used to be.
    expect(line).not.toContain("📊");
    expect(line.startsWith("sonnet")).toBe(true);
    expect(line).toContain("sonnet"); // model shown (falls back to the passed model)
    expect(line).toContain("21.1k tok");
    expect(line).toContain("ctx 11%");
    expect(line).not.toContain("$"); // cost removed
    expect(line).toContain("5h 7% ⏳4h50m"); // time left until the 5h window resets
    expect(line).toContain("7d 19% ⏳5d3h"); // time left until the 7d window resets
    expect(line.split("\n")).toHaveLength(1);
    // the model the turn ACTUALLY ran wins over the configured one
    expect(renderSmall({ ...U, model: "opus-4-8[1m]" }, "sonnet", w, now)).toContain("opus-4-8[1m]");
  });

  it("fmtResetShort is terse: d+h, h+m, m, then <1m / now / empty", () => {
    const now = Date.parse("2026-06-18T00:00:00Z");
    expect(fmtResetShort("2026-06-23T03:00:00Z", now)).toBe("5d3h");
    expect(fmtResetShort("2026-06-18T04:50:00Z", now)).toBe("4h50m");
    expect(fmtResetShort("2026-06-18T00:12:00Z", now)).toBe("12m");
    expect(fmtResetShort("2026-06-18T00:00:30Z", now)).toBe("<1m");
    expect(fmtResetShort(undefined, now)).toBe("");
  });

  it("renderSmall omits windows when account usage is unavailable", () => {
    const line = renderSmall(U, "sonnet", []);
    expect(line).toContain("21.1k tok");
    expect(line).not.toContain("5h");
  });

  it("renderFull breaks the turn down and shows account windows with resets", () => {
    const now = Date.parse("2026-06-18T00:00:00Z");
    const full = renderFull(U, "sonnet", [{ key: "5h", usedPct: 7, resetAt: "2026-06-18T06:30:00Z" }], now);
    expect(full).toContain("input (fresh): 2,470");
    expect(full).toContain("cache write: 18,623");
    expect(full).toContain("cached system + context");
    expect(full).toContain("output: 4");
    expect(full).not.toContain("$"); // cost removed
    expect(full).toContain("sonnet"); // model in the header
    expect(full).toContain("context: 11%");
    // a 1M-window turn shows the real window
    expect(renderFull({ ...U, model: "opus-4-8[1m]", contextWindow: 1_000_000 }, undefined, [], 0)).toContain("of 1.0M");
    expect(full).toContain("5h: 7% used · resets in 6h 30m");
  });

  it("renderFull says n/a when no windows", () => {
    expect(renderFull(U, "sonnet", [], 0)).toContain("account usage: n/a");
  });

  it("renderStatus: none → null, small/full → text; null usage → null", () => {
    expect(renderStatus("none", U, "sonnet", [], 0)).toBeNull();
    expect(renderStatus("small", undefined, "sonnet", [], 0)).toBeNull();
    expect(renderStatus("small", U, "sonnet", [], 0)).toContain("sonnet");
    expect(renderStatus("full", U, "sonnet", [], 0)).toContain("Usage — this turn");
  });
});

describe("remote account usage over the k8s split (gw-command-statusline)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("fetchRemoteAccountUsage GETs {url}/usage with the bearer and returns its windows", async () => {
    const seen: { url?: string; auth?: string } = {};
    vi.stubGlobal("fetch", async (url: string, init: { headers: Record<string, string> }) => {
      seen.url = url;
      seen.auth = init.headers.Authorization;
      return { ok: true, json: async () => ({ windows: [{ key: "5h", usedPct: 7 }, { key: "7d", usedPct: 19 }] }) };
    });
    const w = await fetchRemoteAccountUsage("http://sapien-agent:8080/", "tok123");
    expect(seen.url).toBe("http://sapien-agent:8080/usage"); // trailing slash trimmed, /usage appended
    expect(seen.auth).toBe("Bearer tok123");
    expect(w).toEqual([{ key: "5h", usedPct: 7 }, { key: "7d", usedPct: 19 }]);
  });

  it("fetchRemoteAccountUsage degrades to [] on non-2xx, bad body, or no url", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: false, json: async () => ({}) }));
    expect(await fetchRemoteAccountUsage("http://x/", "t")).toEqual([]);
    vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => ({ notWindows: 1 }) }));
    expect(await fetchRemoteAccountUsage("http://x/", "t")).toEqual([]);
    expect(await fetchRemoteAccountUsage("", "t")).toEqual([]);
  });

  it("remoteAccountUsageCached serves a cache hit within TTL (one fetch), refetches after", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls++;
      return { ok: true, json: async () => ({ windows: [{ key: "5h", usedPct: calls }] }) };
    });
    const key = "http://agent:8080-test";
    const a = await remoteAccountUsageCached(key, "http://agent:8080", "t", 1000, 1_000);
    const b = await remoteAccountUsageCached(key, "http://agent:8080", "t", 1000, 1_500); // within TTL
    expect(calls).toBe(1);
    expect(b).toEqual(a);
    const c = await remoteAccountUsageCached(key, "http://agent:8080", "t", 1000, 3_000); // past TTL
    expect(calls).toBe(2);
    expect(c[0].usedPct).toBe(2);
  });
});
