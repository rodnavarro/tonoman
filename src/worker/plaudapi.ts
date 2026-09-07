// Plaud's third-party API, reached with the credentials the CLI's OAuth login stores.
//
// This is a SOURCE, not a pipeline. It answers two questions — what recordings exist, and where is
// the audio for one of them — and hands both to the transcription path that already exists.
//
// Deliberately not Plaud's own transcript. Their API will hand over `transaction_polish` and
// `outline` for free, and taking them would mean the quality of every recap is set by somebody
// else's model, tuned for somebody else's purpose, with our vocabulary hints thrown away and no
// way to change any of it. Groq and ffmpeg stay; this only replaces where the audio comes from.
//
// What it does replace is the credential. The bearer this supersedes was scraped from a browser,
// lived 24 hours, and was renewed by a scheduled task on one laptop. These tokens come from the
// account's owner, last about 300 days, and refresh themselves.

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { homeFor } from "./plaudcli";
import type { Recording } from "./recap";

const API_BASE = process.env.PLAUD_API_BASE ?? "https://platform.plaud.ai/developer/api";
const REFRESH_URL =
  process.env.PLAUD_REFRESH_URL ?? "https://platform.plaud.ai/developer/api/oauth/third-party/access-token/refresh";
const CLIENT_ID = process.env.PLAUD_CLI_CLIENT_ID ?? "client_f9e0b214-c11f-434b-8b95-c4497d1feb81";

/** What the CLI writes to ~/.plaud/tokens.json. Field names are its, not ours. */
interface TokenSet {
  access_token?: string;
  refresh_token?: string;
  expires_at?: number;
  [k: string]: unknown;
}

function tokenPath(agent: string, root?: string): string {
  return path.join(homeFor(agent, root), ".plaud", "tokens.json");
}

async function read(agent: string, root?: string): Promise<TokenSet | undefined> {
  try {
    return JSON.parse(await fsp.readFile(tokenPath(agent, root), "utf8")) as TokenSet;
  } catch {
    return undefined;
  }
}

/** Renew ahead of the deadline rather than on a 401.
 *
 *  A day of margin, because the alternative is discovering the expiry inside a poll that a person
 *  is waiting on — and these tokens last months, so spending a day of that early costs nothing. */
const RENEW_BEFORE_MS = 24 * 60 * 60 * 1000;

/** The access token for this agent, refreshed if it is close to expiring. Undefined means the
 *  tenant has not connected an account, which is a state and not a failure. */
export async function accessToken(agent: string, root?: string): Promise<string | undefined> {
  const t = await read(agent, root);
  if (!t?.access_token) return undefined;

  const expMs = typeof t.expires_at === "number" ? (t.expires_at > 1e12 ? t.expires_at : t.expires_at * 1000) : 0;
  if (!t.refresh_token || !expMs || expMs - Date.now() > RENEW_BEFORE_MS) return t.access_token;

  try {
    const res = await fetch(REFRESH_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: t.refresh_token, client_id: CLIENT_ID }),
    });
    if (!res.ok) return t.access_token; // still valid for now; say nothing and try again next poll
    const next = (await res.json()) as TokenSet;
    if (!next.access_token) return t.access_token;
    // Written back through the CLI's own file, so `plaud` and this agree about who is signed in.
    await fsp.writeFile(tokenPath(agent, root), JSON.stringify({ ...t, ...next }, null, 2), "utf8");
    return next.access_token;
  } catch {
    return t.access_token;
  }
}

async function call<T>(agent: string, pathname: string, root?: string): Promise<T> {
  const token = await accessToken(agent, root);
  if (!token) throw new Error("plaud: this agent has no connected account — run !connect");
  const res = await fetch(`${API_BASE}${pathname}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error("plaud: the connected account is no longer authorized — run !connect again");
  }
  if (!res.ok) throw new Error(`plaud: ${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

interface ApiFile {
  id: string;
  name?: string;
  start_at?: number;
  duration?: number;
  created_at?: number;
  presigned_url?: string;
}

/** `YYYY-MM-DD-HHMM` in the pod's timezone — the folder-per-recording name the rest of the
 *  pipeline already files by. */
export function stampFor(startMs: number): string {
  const d = new Date(startMs);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/** Plaud sends milliseconds. Reading them as seconds put a meeting in the year 58652 once already,
 *  so anything too small to be a recent instant is treated as seconds and promoted. */
export function toMs(v: number | undefined): number {
  if (!v) return 0;
  return v > 1e11 ? v : v * 1000;
}

export function toRecording(f: ApiFile): Recording {
  const startTime = toMs(f.start_at ?? f.created_at);
  return {
    id: f.id,
    title: (f.name ?? "").trim() || stampFor(startTime),
    startTime,
    duration: toMs(f.duration) === 0 ? 0 : f.duration && f.duration > 1e7 ? f.duration : (f.duration ?? 0) * 1000,
    stamp: stampFor(startTime),
  };
}

/** The recent recordings on this agent's connected account, newest first. */
export async function list(agent: string, pageSize = 20, root?: string): Promise<Recording[]> {
  const body = await call<{ data?: ApiFile[]; items?: ApiFile[] } | ApiFile[]>(
    agent,
    `/open/third-party/files/?page=1&page_size=${pageSize}`,
    root,
  );
  const rows = Array.isArray(body) ? body : (body.data ?? body.items ?? []);
  return rows.map(toRecording).sort((a, b) => b.startTime - a.startTime);
}

/** A time-limited download URL for one recording's audio. Signed on demand and short-lived, so it
 *  is fetched at the moment of use and never stored. */
export async function audioUrl(agent: string, id: string, root?: string): Promise<string> {
  const f = await call<ApiFile>(agent, `/open/third-party/files/${encodeURIComponent(id)}`, root);
  if (!f.presigned_url) {
    // Their own client distinguishes these two, and so should we: a recording that has not
    // finished syncing will have a URL shortly, and one that never had audio never will.
    const synced = Boolean(f.duration);
    throw new Error(
      synced
        ? "plaud: the audio is still being prepared — it will be there on the next poll"
        : "plaud: this recording has no audio",
    );
  }
  return f.presigned_url;
}

/** Whether this agent has a usable connected account, without making a request. */
export async function connected(agent: string, root?: string): Promise<boolean> {
  return Boolean((await read(agent, root))?.access_token);
}
