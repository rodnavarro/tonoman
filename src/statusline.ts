// `/statusline` — per-turn token usage + Claude account headroom (gw-command-statusline).
// The renderers and parsers are PURE (unit-tested); the account-usage fetch + token read
// are thin effectful wrappers. Per-turn numbers come from the harness result (TurnUsage);
// the 5h/7d windows come from the Anthropic OAuth usage API (account-wide, like the Claude
// app), proven by hermes' account-usage. Nothing here is ever committed to the transcript.

import { execFile } from "node:child_process";
import type { TurnUsage } from "./core/contracts";

export type StatusMode = "none" | "small" | "full";
export const STATUS_MODES: StatusMode[] = ["none", "small", "full"];

export function parseStatusMode(s: string): StatusMode | undefined {
  const m = (s ?? "").trim().toLowerCase();
  return (STATUS_MODES as string[]).includes(m) ? (m as StatusMode) : undefined;
}

/** A Claude subscription usage window (account-wide). */
export interface UsageWindow {
  key: string; // "5h" | "7d"
  usedPct: number; // 0..100
  resetAt?: string; // ISO timestamp
}

/** The turn's real context window (tokens) — from the model the turn ran (e.g. 1M for an
 * opus 1M variant); falls back to 200k when the harness didn't report one. */
export function contextWindow(u: TurnUsage): number {
  return u.contextWindow && u.contextWindow > 0 ? u.contextWindow : 200_000;
}

/** Context use % = peak single-call occupancy ÷ the model's real window, capped at 100 (a
 * turn's SUMMED tokens re-count the cached context each iteration and would exceed the window). */
export function contextPercent(u: TurnUsage): number {
  const used = u.contextTokens ?? (u.inputTokens || 0) + (u.cacheReadTokens || 0) + (u.cacheWriteTokens || 0);
  return Math.min(100, Math.round((100 * used) / contextWindow(u)));
}

function totalTokens(u: TurnUsage): number {
  return (u.inputTokens || 0) + (u.cacheWriteTokens || 0) + (u.cacheReadTokens || 0) + (u.outputTokens || 0);
}

/** Compact token count: 2470 → "2.5k", 18623 → "18.6k", 1_200_000 → "1.2M". */
export function compactTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function grouped(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Maps the Anthropic OAuth-usage payload to the 5h + 7d windows (gw-command-statusline).
 * Utilization is sometimes a fraction (≤1) and sometimes a percent — normalize to 0..100. */
export function parseAccountUsage(payload: unknown): UsageWindow[] {
  const p = (payload ?? {}) as Record<string, { utilization?: number; resets_at?: string }>;
  const out: UsageWindow[] = [];
  for (const [field, key] of [
    ["five_hour", "5h"],
    ["seven_day", "7d"],
  ] as const) {
    const w = p[field];
    const util = w?.utilization;
    if (util == null) continue;
    const pct = Number(util) <= 1 ? Number(util) * 100 : Number(util);
    out.push({ key, usedPct: Math.round(pct), resetAt: w?.resets_at });
  }
  return out;
}

/** Short relative reset, e.g. "in 5h 30m" / "in 4d". */
export function fmtReset(resetAt: string | undefined, now: number): string {
  if (!resetAt) return "";
  const t = Date.parse(resetAt);
  if (Number.isNaN(t)) return "";
  const secs = Math.max(0, Math.floor((t - now) / 1000));
  if (secs <= 0) return "now";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (h >= 24) return `in ${Math.floor(h / 24)}d ${h % 24}h`;
  if (h > 0) return `in ${h}h ${m}m`;
  return `in ${m}m`;
}

/** Ultra-compact time-to-reset for the one-line footer, e.g. "4h50m" / "5d3h" / "12m" / "<1m".
 * Empty when unknown. (renderWindows uses the wordier fmtReset; the small line needs terseness.) */
export function fmtResetShort(resetAt: string | undefined, now: number): string {
  if (!resetAt) return "";
  const t = Date.parse(resetAt);
  if (Number.isNaN(t)) return "";
  let secs = Math.max(0, Math.floor((t - now) / 1000));
  if (secs <= 0) return "now";
  const d = Math.floor(secs / 86400);
  secs -= d * 86400;
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d > 0) return `${d}d${h}h`;
  if (h > 0) return `${h}h${m}m`;
  return m > 0 ? `${m}m` : "<1m";
}

/** Windows on one line, each with a "time left until reset" hourglass so you can see whether a
 * window is about to roll over (gw-command-statusline): `5h 9% ⏳4h50m · 7d 26% ⏳5d3h`. */
const windowsLine = (windows: UsageWindow[], now: number): string =>
  windows
    .map((w) => {
      const left = fmtResetShort(w.resetAt, now);
      return `${w.key} ${w.usedPct}%${left ? ` ⏳${left}` : ""}`;
    })
    .join(" · ");

/** The multi-line account-headroom block (5h/7d with resets); "n/a" when unavailable.
 * Reused by `renderFull` and the on-demand `/statusline print` (gw-command-statusline). */
export function renderWindows(windows: UsageWindow[], now: number): string {
  if (!windows.length) return "📈 account usage: n/a";
  const lines = ["📈 Account usage"];
  for (const w of windows) {
    const reset = fmtReset(w.resetAt, now);
    lines.push(`• ${w.key}: ${w.usedPct}% used${reset ? ` · resets ${reset}` : ""}`);
  }
  return lines.join("\n");
}

/** The model to display: the one the turn actually ran (from usage), else the configured one. */
function modelLabel(u: TurnUsage, model?: string): string | undefined {
  return u.model || model || undefined;
}

/** One compact status line. `now` drives the per-window time-to-reset (⏳). */
export function renderSmall(u: TurnUsage, model: string | undefined, windows: UsageWindow[], now: number = Date.now()): string {
  const ml = modelLabel(u, model);
  // No icon. This line sits under every answer the agent gives, so it is the most-repeated
  // element in the whole product — and an emoji there reads as a label on the answer rather than
  // as the quiet meter it is. The words carry it.
  const parts = [ml, `${compactTokens(totalTokens(u))} tok`, `ctx ${contextPercent(u)}%`].filter(
    (p): p is string => Boolean(p),
  );
  // Agentic iterations the turn took (⟳ N), when the harness reports it — shows how hard the turn
  // worked and how close it ran to its step cap (gw-command-statusline / 40-turn cap).
  if (u.iterationsUsed != null) parts.push(`⟳ ${u.iterationsUsed}`);
  if (windows.length) parts.push(windowsLine(windows, now));
  return parts.join(" · ");
}

/** A full per-turn breakdown + account headroom. */
export function renderFull(u: TurnUsage, model: string | undefined, windows: UsageWindow[], now: number): string {
  const ml = modelLabel(u, model);
  const lines = [
    `📊 Usage — this turn${ml ? ` · ${ml}` : ""}`,
    `• input (fresh): ${grouped(u.inputTokens || 0)}`,
    `• cache write: ${grouped(u.cacheWriteTokens || 0)}`,
    `• cache read: ${grouped(u.cacheReadTokens || 0)}  (cached system + context)`,
    `• output: ${grouped(u.outputTokens || 0)}`,
    `• context: ${contextPercent(u)}% of ${compactTokens(contextWindow(u))}`,
  ];
  if (u.iterationsUsed != null) lines.push(`• iterations: ${u.iterationsUsed}`);
  lines.push(renderWindows(windows, now));
  return lines.join("\n");
}

/** Renders the status for a mode (null = nothing to show). */
export function renderStatus(
  mode: StatusMode,
  u: TurnUsage | undefined,
  model: string | undefined,
  windows: UsageWindow[],
  now: number,
): string | null {
  if (mode === "none" || !u) return null;
  return mode === "full" ? renderFull(u, model, windows, now) : renderSmall(u, model, windows, now);
}

// --- effectful: token read + account-usage fetch (TTL-cached) ---------------

/** Reads the agent's OAuth access token from its credential file (in the sandbox). The token
 * stays in-process — never logged. Returns null if unavailable / not an OAuth account. */
export function readOauthToken(container: string, credFile: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("podman", ["exec", container, "cat", credFile], { maxBuffer: 1 << 20 }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        const c = JSON.parse(stdout);
        resolve((c.claudeAiOauth?.accessToken as string) || null);
      } catch {
        resolve(null);
      }
    });
  });
}

/** GETs the Anthropic OAuth usage API and parses the 5h/7d windows. Account-wide utilization
 * (the Claude app's numbers). Returns [] on any failure (graceful — never throws). */
export async function fetchAccountUsage(token: string): Promise<UsageWindow[]> {
  try {
    const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": "claude-code/2.1.0",
      },
    });
    if (!res.ok) return [];
    return parseAccountUsage(await res.json());
  } catch {
    return [];
  }
}

/** GETs a REMOTE agent runtime's /usage (claude-code-http, k8s split): the agent holds the
 * OAuth credential and reports its own 5h/7d windows, so the gateway — which can't podman-exec
 * across the split — pulls them over HTTP. Bearer-authed like /turn. Returns [] on any failure. */
export async function fetchRemoteAccountUsage(
  url: string,
  token: string | undefined,
  agent?: string,
): Promise<UsageWindow[]> {
  if (!url) return [];
  try {
    // Named, because the headroom is read with the ACCOUNT'S OWN token and each agent now has its
    // own. Unnamed, every agent reports the same 5h/7d figures whoever they are actually running
    // as — which is precisely the confusion per-agent credentials exist to remove, and it looks
    // entirely plausible while being wrong.
    const q = agent ? `?agent=${encodeURIComponent(agent)}` : "";
    const res = await fetch(`${url.replace(/\/$/, "")}/usage${q}`, {
      headers: token ? { Authorization: `Bearer ${token}`, Accept: "application/json" } : { Accept: "application/json" },
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { windows?: UsageWindow[] };
    return Array.isArray(body.windows) ? body.windows : [];
  } catch {
    return [];
  }
}

const usageCache = new Map<string, { at: number; windows: UsageWindow[] }>();

/** Remote-agent account usage, cached under `key` (same store as the local path so the sync
 * `cachedAccountUsage(key)` footer read works identically). Degrades to [] (windows omitted). */
export async function remoteAccountUsageCached(
  key: string,
  url: string,
  token: string | undefined,
  ttlMs = 120_000,
  now: number = Date.now(),
  agent?: string,
): Promise<UsageWindow[]> {
  const hit = usageCache.get(key);
  if (hit && now - hit.at < ttlMs) return hit.windows;
  const windows = await fetchRemoteAccountUsage(url, token, agent);
  usageCache.set(key, { at: now, windows });
  return windows;
}

/** Sync read of the cached account windows for an agent (no fetch), for the synchronous
 * status footer. Returns [] if nothing is cached or it's stale — the gateway warms the
 * cache with `accountUsageCached` at turn start. */
export function cachedAccountUsage(container: string, ttlMs = 120_000, now: number = Date.now()): UsageWindow[] {
  const hit = usageCache.get(container);
  return hit && now - hit.at < ttlMs ? hit.windows : [];
}

/** Account usage for an agent, cached briefly so it isn't re-fetched every turn. Degrades to
 * [] (windows omitted) when the token or endpoint is unavailable. */
export async function accountUsageCached(
  container: string,
  credFile: string,
  ttlMs = 120_000,
  now: number = Date.now(),
): Promise<UsageWindow[]> {
  const hit = usageCache.get(container);
  if (hit && now - hit.at < ttlMs) return hit.windows;
  const token = await readOauthToken(container, credFile);
  const windows = token ? await fetchAccountUsage(token) : [];
  usageCache.set(container, { at: now, windows });
  return windows;
}
