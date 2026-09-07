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
  /** What the token endpoint returns: seconds of life, not a deadline. */
  expires_in?: number;
  /** Ours: the deadline we computed when we stored it, so a restart does not think a token
   *  minted yesterday is fresh. */
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
 *  Ten minutes, measured against the real thing: the access token comes back with
 *  `expires_in: 86400`, so it lives a day, and the 300 days in Plaud's own documentation belongs
 *  to the refresh token behind it. A day of margin here would have refreshed on every single poll.
 *
 *  Ten is enough to cover a poll that takes a while — a long recording is minutes of ffmpeg and
 *  transcription — without spending the token's life ahead of time. */
const RENEW_BEFORE_MS = 10 * 60 * 1000;

/** The access token for this agent, refreshed if it is close to expiring. Undefined means the
 *  tenant has not connected an account, which is a state and not a failure. */
export async function accessToken(agent: string, root?: string): Promise<string | undefined> {
  const t = await read(agent, root);
  if (!t?.access_token) return undefined;

  const expMs = typeof t.expires_at === "number" ? (t.expires_at > 1e12 ? t.expires_at : t.expires_at * 1000) : 0;
  // No stored deadline means a token written by something that did not record one (the CLI's own
  // login, for instance). Treat it as due rather than as immortal.
  if (!t.refresh_token || !expMs || expMs - Date.now() > RENEW_BEFORE_MS) return t.access_token;

  try {
    // Form-encoded with a Basic header, as OAuth specifies and as the endpoint insists: sent as
    // JSON it answers 422 saying the fields are missing, which reads like a bad request rather
    // than the wrong encoding.
    const res = await fetch(REFRESH_URL, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${Buffer.from(`${CLIENT_ID}:`).toString("base64")}`,
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: t.refresh_token,
        client_id: CLIENT_ID,
      }),
    });
    if (!res.ok) return t.access_token; // still valid for now; say nothing and try again next poll
    const next = (await res.json()) as TokenSet;
    if (!next.access_token) return t.access_token;
    // Written back through the CLI's own file, so `plaud` and this agree about who is signed in.
    await fsp.writeFile(tokenPath(agent, root), JSON.stringify(stamp({ ...t, ...next }), null, 2), "utf8");
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

/** Verified against the live API, not inferred:
 *    { id, name, created_at, serial_number, start_at, duration, presigned_url, source_list, note_list }
 *  `start_at` is an ISO string ("2026-09-07T03:10:46.379000"), NOT epoch milliseconds, and
 *  `duration` is already milliseconds. */
interface ApiFile {
  id: string;
  name?: string;
  start_at?: string | number;
  duration?: number;
  created_at?: string | number;
  presigned_url?: string;
}

/** Record when a token set was stored, since the endpoint reports a lifetime and not a deadline. */
function stamp(t: TokenSet): TokenSet {
  const secs = typeof t.expires_in === "number" ? t.expires_in : 0;
  return secs ? { ...t, expires_at: Date.now() + secs * 1000 } : t;
}

/** `YYYY-MM-DD-HHMM` in UTC — the folder-per-recording name the rest of the pipeline files by.
 *
 *  UTC, and not the pod's local time, because the OTHER path that writes these stamps uses UTC.
 *  Written in local time the same recording got two names — `2026-09-07-1057` from one agent and
 *  `2026-09-07-0657` from the other — and since "already published" is decided by looking for the
 *  stamp in the second brain, a recording filed by one path is invisible to the other. It gets
 *  transcribed again, published again, and announced again. Two names for one meeting is not a
 *  cosmetic problem; it is a duplicate that costs money every poll. */
export function stampFor(startMs: number): string {
  const d = new Date(startMs);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
}

/** An instant, from either shape this API uses. `start_at` arrives as an ISO string with no zone
 *  ("2026-09-07T03:10:46.379000"), which JavaScript reads as LOCAL time — and the pod runs UTC,
 *  which is the zone Plaud means. Numbers are milliseconds; anything too small to be a recent
 *  instant is seconds and gets promoted, because reading one as the other once filed a meeting
 *  under the year 58652. */
export function toMs(v: string | number | undefined): number {
  if (!v) return 0;
  if (typeof v === "number") return v > 1e11 ? v : v * 1000;
  const t = Date.parse(/[Zz]|[+-]\d\d:?\d\d$/.test(v) ? v : `${v}Z`);
  return Number.isFinite(t) ? t : 0;
}

export function toRecording(f: ApiFile): Recording {
  const startTime = toMs(f.start_at ?? f.created_at);
  return {
    id: f.id,
    title: (f.name ?? "").trim() || stampFor(startTime),
    startTime,
    // Already milliseconds: a 31-second recording reports 31000.
    duration: f.duration ?? 0,
    stamp: stampFor(startTime),
  };
}

/** The recent recordings on this agent's connected account, newest first. */
export async function list(agent: string, pageSize = 20, root?: string): Promise<Recording[]> {
  // The API refuses a page smaller than ten, and says so with a 422 that names the constraint.
  const size = Math.max(10, Math.min(100, pageSize));
  const body = await call<{ data?: ApiFile[] }>(agent, `/open/third-party/files/?page=1&page_size=${size}`, root);
  return (body.data ?? []).map(toRecording).sort((a, b) => b.startTime - a.startTime);
}

/** A time-limited download URL for one recording's audio. Signed on demand and short-lived, so it
 *  is fetched at the moment of use and never stored. */
export async function audioUrl(agent: string, id: string, root?: string): Promise<string> {
  // The detail response is the file itself, with no envelope around it.
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
