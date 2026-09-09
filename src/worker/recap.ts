// The voice flow as activities: Plaud → transcribe → recap → second brain → wake.
//
// This used to be a script run by hand. It is here because a recording that finishes should be
// noticed by the platform, not by a person remembering to run a command — and because the durable
// half is exactly what Temporal is for: a poll that must not double-process, a transcription that
// costs money, and a notification that must not be lost if the pod dies between them.
//
// Kept as small activities with a workflow above them, so each step is retried or not on its own
// merits: listing is cheap and safe to retry, processing is neither.

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { budgetFor, chatWith, transcribeWith, type Provider } from "./inference";

// MOVED, not changed. Deciding what a provider's refusal means belongs with the providers; these
// two are re-exported because every existing caller and test names them here, and a move that
// rewrites call sites is a move that hides whether the behaviour moved too.
export { groqFailure, retryAfterMs } from "./inference";

/** Run a command and collect its output. Never throws: the caller decides what a non-zero exit
 *  means, which differs — a failed `git commit` means "nothing to commit", a failed ffmpeg means
 *  the recording is unusable. */
function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<{ code: number; out: string }> {
  return new Promise((resolve) =>
    execFile(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, maxBuffer: 1 << 24 }, (err, so, se) =>
      resolve({ code: err ? 1 : 0, out: `${so}${se}` }),
    ),
  );
}

import { ApplicationFailure } from "@temporalio/common";
import * as plaudapi from "./plaudapi";
import type { CalEvent } from "./calendar";

export interface PlaudCreds {
  /** The captured web token, as JSON — bearer plus the app headers the API insists on.
   *
   *  The CONTENT, not a path. A path is a property of the pod, and one pod serves every tenant it
   *  has agents for, so a path meant one Plaud account for all of them. Whose account this is has
   *  to be a property of the agent, and the only thing the agent knows is a secret reference. */
  tokenJson: string;
  /** When set, this agent has connected its own Plaud account through the official CLI, and the
   *  recordings come from the third-party API rather than the captured web bearer.
   *
   *  Both shapes exist on purpose and only for now: one tenant is on OAuth tokens that renew
   *  themselves, the other is still on a bearer that expires every 24 hours, and moving them both
   *  in one step would have meant no working pipeline at all while it was tried. The bearer path
   *  goes when the second tenant has connected. */
  cliAgent?: string;
}

export interface Recording {
  id: string;
  title: string;
  /** Epoch MILLISECONDS. Plaud sends ms; reading it as seconds gives a meeting in the year 58652. */
  startTime: number;
  /** Duration in MILLISECONDS, likewise. */
  duration: number;
  /** `YYYY-MM-DD-HHMM`, the folder-per-recording name. */
  stamp: string;
}

const PLAUD_BASE = "https://api.plaud.ai";

/** PURE: the second-brain folder name for a recording. Stable, sortable, and unique per minute, so
 *  re-processing the same recording lands on the same path and is a no-op. */
export function stampFor(startMs: number): string {
  const d = new Date(startMs);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.toISOString().slice(0, 10)}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
}

/** PURE: strip the file extension Plaud puts on a recording's name. */
export function titleFor(raw: string | undefined): string {
  return (raw || "Untitled meeting").replace(/\.[a-z0-9]+$/i, "");
}

async function plaudHeaders(creds: PlaudCreds): Promise<Record<string, string>> {
  const token = JSON.parse(creds.tokenJson) as Record<string, string>;
  if (!token.authorization) throw new Error("plaud: captured token has no authorization — it is dead");
  const h: Record<string, string> = {
    authorization: token.authorization,
    accept: "application/json, text/plain, */*",
    origin: "https://web.plaud.ai",
    referer: "https://web.plaud.ai/",
  };
  // The API wants the captured app headers too. The bearer alone gets a 401 that looks like an
  // expired token and is not.
  for (const k of ["source", "app-language", "app-platform", "edit-from", "timezone", "user-agent", "x-device-id", "x-pld-user"]) {
    if (token[k]) h[k] = token[k];
  }
  return h;
}

async function plaudGet<T>(creds: PlaudCreds, p: string, params?: Record<string, unknown>): Promise<T> {
  const url = new URL(PLAUD_BASE + p);
  for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, String(v));
  const r = await fetch(url, { headers: await plaudHeaders(creds) });
  if (!r.ok) throw new Error(`plaud ${p}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  const body = (await r.json()) as T;
  // The status LINE is not the answer; the envelope is. See envelopeError.
  const bad = plaudapi.envelopeError(body);
  if (bad) throw new Error(`plaud ${p}: ${bad}`);
  return body;
}

export async function listRecordings(creds: PlaudCreds, limit = 20): Promise<Recording[]> {
  if (creds.cliAgent) return plaudapi.list(creds.cliAgent, limit);
  const j = await plaudGet<{ data_file_list?: Record<string, unknown>[] }>(creds, "/file/simple/web", {
    skip: 0,
    limit,
    is_trash: 2,
    sort_by: "start_time",
    is_desc: true,
  });
  return (j.data_file_list ?? []).map((r) => {
    const startTime = Number(r.start_time ?? 0);
    return {
      id: String(r.id),
      title: titleFor(r.filename as string | undefined),
      startTime,
      duration: Number(r.duration ?? 0),
      stamp: stampFor(startTime),
    };
  });
}

/** PURE: the floor, as epoch ms. Recordings that started before it are not ours to process.
 *
 *  This is NOT an optimisation. "Not in the second brain" and "should be transcribed" are different
 *  questions, and treating them as one turns the first poll into a backfill of the customer's
 *  entire Plaud history — every recording transcribed, summarised, committed, and ANNOUNCED in
 *  Slack as if it had just happened. Which is exactly what it did: a 48-minute meeting from nine
 *  days ago arrived as "I've got a new recording".
 *
 *  `since` is an explicit ISO date when the operator sets one. Absent that the floor is the start
 *  of the day the worker booted, in the operator's timezone — "from today onwards", which is what
 *  somebody switching the feature on means by it. */
/** PURE: minutes EAST of UTC for a zone at a given instant.
 *
 *  Derived from the zone rather than stored, because a stored offset is wrong twice a year and the
 *  floor is a wall-clock question — "recordings from today onwards" means the tenant's today, and
 *  their today starts an hour earlier after the clocks change.
 *
 *  Computed by formatting the instant in the zone and in UTC and subtracting, which is the only way
 *  to get this out of the platform without a timezone library. Falls back to 0 (UTC) on a zone Node
 *  does not know, so a typo in a settings field costs correct times, never a crash. */
export function offsetMinutesFor(timezone: string, at: number): number {
  if (!timezone || timezone === "UTC") return 0;
  try {
    const read = (tz: string): number => {
      const p = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }).formatToParts(new Date(at));
      const v = (t: string): number => Number(p.find((x) => x.type === t)?.value ?? 0);
      const hour = v("hour") === 24 ? 0 : v("hour");
      return Date.UTC(v("year"), v("month") - 1, v("day"), hour, v("minute"), v("second"));
    };
    return Math.round((read(timezone) - read("UTC")) / 60_000);
  } catch {
    return 0;
  }
}

export function floorFor(since: string | undefined, now: number, tzOffsetMinutes = 0): number {
  if (since) {
    // A bare `YYYY-MM-DD` means local midnight, so it takes the offset. A full instant already
    // carries its own zone and must NOT be shifted again — doing so moved a floor of 01:35Z four
    // hours into the FUTURE, which silently stops the poll rather than bounding it.
    if (/^\d{4}-\d{2}-\d{2}$/.test(since)) {
      const t = Date.parse(`${since}T00:00:00Z`);
      if (!Number.isNaN(t)) return t - tzOffsetMinutes * 60_000;
    } else {
      const t = Date.parse(since);
      if (!Number.isNaN(t)) return t;
    }
  }
  // `tzOffsetMinutes` is minutes EAST of UTC (US Eastern in summer is -240), so local wall-clock
  // time is `now + offset` and turning a local midnight back into an instant subtracts it again.
  const local = new Date(now + tzOffsetMinutes * 60_000);
  const midnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  return midnight - tzOffsetMinutes * 60_000;
}

/** Which of these are new enough to process and have NOT been published yet.
 *
 *  Publication is answered from the second-brain checkout rather than a database table: the
 *  repository is the record, so "is it published" is a question about the repository. It also means
 *  a recap deleted by hand is reprocessed, which is what somebody deleting it would expect — and
 *  the floor is what keeps that from meaning "reprocess nine days of history". */
export async function unpublished(
  recordings: Recording[],
  brainDir: string,
  floorMs = 0,
  journal?: Journal,
): Promise<Recording[]> {
  const out: Recording[] = [];
  for (const r of recordings) {
    if (r.startTime < floorMs) continue;
    if (!(await isPublished(brainDir, r, journal))) out.push(r);
  }
  return out;
}

/** Has this recording been filed anywhere yet?
 *
 *  With a journal the answer cannot be a single stat: the route is not known until the meeting has
 *  been summarised, and a person may have MOVED a recap to a different folder afterwards. Both are
 *  normal, and both must count as published — otherwise re-filing a meeting by hand causes it to be
 *  transcribed and written again, which is the loop that emptied the transcription quota once
 *  already. So the check is "does any route hold a page whose name starts with this stamp". */
async function isPublished(brainDir: string, rec: Recording, journal?: Journal): Promise<boolean> {
  if (!journal) {
    return fs
      .stat(path.join(brainDir, "Meetings", `${rec.stamp}.md`))
      .then(() => true)
      .catch(() => false);
  }
  const root = path.join(brainDir, journal.path);
  let dirs: string[];
  try {
    dirs = (await fs.readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return false; // the journal folder does not exist yet; nothing is published
  }
  for (const d of dirs) {
    let names: string[];
    try {
      names = await fs.readdir(path.join(root, d));
    } catch {
      continue;
    }
    if (names.some((n) => n.startsWith(rec.stamp) && n.endsWith(".md"))) return true;
  }
  return false;
}

export interface TranscribeResult {
  text: string;
  seconds: number;
  /** Which providers actually served, in the order they first did. Recorded because the recap page
   *  states who transcribed it, and a hardcoded "Groq" became a lie the moment a second provider
   *  existed. Empty when every chunk came from the cache — see `transcribedBy`. */
  by: string[];
}

/** How long each piece of audio sent to Groq is.
 *
 *  Groq refuses an upload over its size cap with a flat 413 — which is exactly what a real meeting
 *  hit the first time the poll found one: the recording was posted, announced, and then failed on
 *  upload. Ten minutes of 16 kHz mono FLAC is roughly 10 MB, comfortably under any of Groq's tiers,
 *  and short enough that a chunk that does fail costs one retry rather than the whole meeting. */
const SEGMENT_SECONDS = Number(process.env.RECAP_SEGMENT_SECONDS ?? 600);

/** PURE: join the per-chunk transcripts into one.
 *
 *  Blank line between chunks and nothing else: a marker like "[part 2]" would end up quoted back
 *  by the summariser as if the meeting had sections, and the chunk boundary is an artefact of the
 *  upload limit, not of the conversation. */
export function joinChunks(parts: string[]): string {
  return parts
    .map((p) => p.trim())
    .filter(Boolean)
    .join("\n\n");
}

/** Re-encode to what a speech model actually wants, in pieces small enough to upload.
 *
 *  16 kHz mono is Whisper's own working format, so downsampling loses nothing it would have used
 *  and cuts a stereo 48 kHz recording by an order of magnitude before the size cap is even in
 *  question.
 *
 *  ONE FFMPEG PER PIECE, and NOT `-f segment`, which is what this used to do. The segment muxer
 *  writes FLAC headers that do not describe the segment: every piece but the last declares an
 *  unknown length, and the LAST piece declares the length of the WHOLE SOURCE. Measured, on a
 *  3740-second input cut at 600:
 *
 *      part-000..005   122 KB each   ffprobe: N/A
 *      part-006         35 KB        ffprobe: 3740.014875   <- 140 seconds of audio
 *
 *  Groq meters on the DECLARED duration, so the final chunk of every multi-part recording was
 *  charged as if it were the entire meeting again. A 62-minute recording cost 7340 seconds instead
 *  of 3720 — the doubling Rod spotted on the usage dashboard, and most of what emptied a day's
 *  quota. Single-chunk recordings were correct by accident, which is why a five-minute test
 *  measured perfectly and hid it.
 *
 *  Seeking BEFORE `-i` so each cut is still fast, and each output is finalised on its own, so its
 *  header describes itself:
 *
 *      part-000..005   ffprobe: 600.000000
 *      part-006        ffprobe: 140.014875 */
async function segments(srcPath: string, outDir: string): Promise<string[]> {
  const total = await probeSeconds(srcPath);
  if (total === undefined) {
    // Without a duration there is nothing to cut against. Refused rather than guessed: the old
    // fallback here is exactly the muxer that mis-declares lengths, and a silent return to it
    // would restore the bug it took a metered API and a usage dashboard to find.
    throw new Error("ffprobe could not read the recording's duration, so it cannot be split safely");
  }
  const out: string[] = [];
  for (let i = 0, off = 0; off < total; i++, off += SEGMENT_SECONDS) {
    const file = path.join(outDir, `part-${String(i).padStart(3, "0")}.flac`);
    const r = await run("ffmpeg", [
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      // BEFORE -i: ffmpeg seeks the container instead of decoding from the start, so cutting the
      // ninth piece of a long meeting costs the same as cutting the first.
      "-ss",
      String(off),
      "-t",
      String(SEGMENT_SECONDS),
      "-i",
      srcPath,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-c:a",
      "flac",
      file,
    ]);
    if (r.code !== 0) throw new Error(`ffmpeg: ${r.out.slice(0, 300)}`);
    // A final cut landing exactly on the end produces an empty file; it is not a chunk and must
    // not become a request.
    const size = await fs.stat(file).then((st) => st.size).catch(() => 0);
    if (size === 0) {
      await fs.rm(file, { force: true }).catch(() => {});
      break;
    }
    out.push(file);
  }
  if (out.length === 0) throw new Error("ffmpeg produced no audio segments");
  return out;
}

/** PURE: seconds out of ffprobe's output, or undefined when it did not say. */
export function parseProbeSeconds(out: string): number | undefined {
  const n = Number(String(out).trim().split(/\s+/)[0]);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** How many seconds of audio a segment actually contains.
 *
 *  MEASURED, not assumed. Every figure in this pipeline was derived from megabytes and chunk
 *  counts — and the one resource we are rationed on is SECONDS OF AUDIO, which nothing logged.
 *  When Groq's limiter and our own arithmetic disagreed there was no way to tell which was wrong.
 *  ffprobe is local and costs no quota, so there is no reason to guess. */
async function probeSeconds(file: string): Promise<number | undefined> {
  const r = await run("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    file,
  ]);
  return r.code === 0 ? parseProbeSeconds(r.out) : undefined;
}



/** PURE: where one chunk's text is kept between attempts. Keyed by the RECORDING, because that is
 *  what a retry is retrying, and by chunk INDEX and COUNT together — a different count means the
 *  audio was segmented differently and index 3 is no longer the same three minutes, so the whole
 *  set is stale and must not be reused. */
export function chunkCachePath(cacheDir: string, rec: Recording, index: number, total: number): string {
  return path.join(cacheDir, rec.id, `of-${total}`, `chunk-${String(index).padStart(3, "0")}.txt`);
}

/** Text only, never audio. The transcript is going to the second brain anyway, so keeping it for a
 *  few minutes costs nothing; the AUDIO is the customer's meeting and has no business outliving
 *  the attempt, which is why the retry re-downloads rather than caching it. */
async function cachedChunk(file: string): Promise<string | undefined> {
  return fs.readFile(file, "utf8").catch(() => undefined);
}

/** Drop a recording's saved chunks. Called once it is published: the transcript is in the second
 *  brain by then, so keeping a second copy of the customer's meeting on the volume is a liability
 *  with no remaining purpose. Best effort — a cache that fails to clear costs disk, not
 *  correctness, and the next attempt would simply reuse it. */
export async function clearChunkCache(cacheDir: string, rec: Recording): Promise<void> {
  await fs.rm(path.join(cacheDir, rec.id), { recursive: true, force: true }).catch(() => {});
}

export async function transcribe(
  creds: PlaudCreds,
  rec: Recording,
  providers: Provider[],
  vocab: string,
  onProgress?: (done: number, total: number) => void,
  /** Where finished chunks are kept, so a retry resumes instead of starting over. Optional: the
   *  single-machine path passes none and behaves exactly as before. */
  cacheDir?: string,
): Promise<TranscribeResult> {
  const t0 = Date.now();
  // The audio, and ONLY the audio. Plaud will also hand over its own transcript and summary, and
  // taking them would put the quality of every recap in somebody else's model, tuned for somebody
  // else's purpose, with our vocabulary hints discarded. ffmpeg and Groq stay.
  const tempUrl = creds.cliAgent
    ? await plaudapi.audioUrl(creds.cliAgent, rec.id)
    : (await plaudGet<{ temp_url: string }>(creds, `/file/temp-url/${rec.id}`)).temp_url;
  const audio = Buffer.from(await (await fetch(tempUrl)).arrayBuffer());

  // A scratch directory per recording, removed whether or not this succeeds. The audio is the
  // customer's meeting; it has no business outliving the transcription.
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "recap-"));
  try {
    const src = path.join(work, "source");
    await fs.writeFile(src, audio);
    const parts = await segments(src, work);
    const durations = await Promise.all(parts.map(probeSeconds));
    const totalSecs = durations.reduce((a: number, b) => a + (b ?? 0), 0);
    console.log(
      `recap: ${rec.title} — ${(audio.length / 1e6).toFixed(1)}MB in ${parts.length} chunk(s), ` +
        `${Math.round(totalSecs)}s of audio [${durations.map((d) => (d === undefined ? "?" : Math.round(d))).join(", ")}]`,
    );

    const texts: string[] = [];
    let reused = 0;
    const by: string[] = [];
    // A provider that is DEAD AT THE TRANSPORT — nothing listening, DNS gone, the container stopped —
    // is skipped for the rest of this recording rather than waited on once per chunk. Scoped to the
    // recording, not the process: a server that comes back is asked again on the next one.
    let dead: string[] = [];
    for (const [i, file] of parts.entries()) {
      // RESUME, don't restart. Without this a meeting that failed on chunk 6 of 9 threw away the
      // five it had already paid for and asked for them again on the next tick — which is how a
      // handful of meetings consumed a whole day's audio quota: 611 attempts, 4 published.
      const at = cacheDir ? chunkCachePath(cacheDir, rec, i, parts.length) : undefined;
      const already = at ? await cachedChunk(at) : undefined;
      if (already !== undefined) {
        texts.push(already);
        reused++;
        onProgress?.(i + 1, parts.length);
        continue;
      }
      // Sequential on purpose: the chunks are one conversation, and a rate-limited burst would
      // fail a whole meeting to save a few seconds on one.
      // Said before the request, not after: when a chunk is REFUSED, this is the only record of
      // An empty list after filtering means every provider looked dead, which is far more likely to
      // be this machine's network than all of them being down — so ask everyone again rather than
      // fail a meeting on the strength of one blip.
      const live = providers.filter((x) => !dead.includes(x.name));
      const asking = live.length ? live : providers;
      // Said BEFORE the request, not after: when a chunk is REFUSED this is the only record of how
      // much audio we asked for, and that is exactly the number the limiter is counting. It names
      // the ORDER rather than one provider, because which one answers is not known until one does —
      // this line said "groq" unconditionally, which stopped being true the day a second existed.
      console.log(
        `recap: ${rec.title} — chunk ${i + 1}/${parts.length}, ${Math.round(durations[i] ?? 0)}s → ${asking.map((x) => x.name).join(" → ")}`,
      );
      const served = await transcribeWith(asking, file, vocab, {
        onDead: (n) => { dead = [...dead, n]; },
        log: (line) => console.log(line),
      });
      const text = served.value;
      if (!by.includes(served.provider.name)) by.push(served.provider.name);
      if (at) {
        await fs.mkdir(path.dirname(at), { recursive: true }).catch(() => {});
        // Written BEFORE the next chunk is attempted, so a failure on chunk i+1 cannot lose chunk i.
        await fs.writeFile(at, text, "utf8").catch(() => {});
      }
      texts.push(text);
      onProgress?.(i + 1, parts.length);
    }
    if (reused) console.log(`recap: ${rec.title} — reused ${reused}/${parts.length} chunk(s) from a previous attempt`);
    return { text: joinChunks(texts), seconds: (Date.now() - t0) / 1000, by };
  } finally {
    await fs.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

export interface Recap {
  summary: string;
  highlights: string[];
  decisions: string[];
  followups: string[];
  /** Which configured route this meeting belongs to. Absent when the flow configures none. */
  route?: string;
  /** One line on WHY, so a misfiling is auditable and correctable rather than mysterious. */
  routeReason?: string;
  /** Which calendar entry this recording was, when one matched. The event's own summary — so a
   *  recurring meeting is named the same way every week, which is what makes a series findable. */
  meeting?: string;
  /** Why that entry and not another. The Overview shows it beside every candidate considered,
   *  because "why is this filed under the wrong meeting" is otherwise unanswerable. */
  meetingReason?: string;
  /** Whether this meeting moved the tenant's mission forward, did nothing for it, or COST the
   *  attention it needed. One of ALIGNMENTS, or absent when there is no mission to judge against. */
  alignment?: string;
  /** One line on why. The verdict without the reason is a score, and nobody trusts a score. */
  alignmentReason?: string;
}

/** The only verdicts. A closed set, exactly like `route`, and for the same reason: a free-text
 *  judgement cannot be counted, filtered, or checked for the failure mode below. */
export const ALIGNMENTS = ["advances", "neutral", "detracts"] as const;

/** PURE: the model's answer, or NOTHING.
 *
 *  Unrecognised maps to "" and NOT to "neutral", which is the whole point. A fabricated neutral is a
 *  judgement nobody made, rendered on the page in the same typeface as one somebody did — and it
 *  would be indistinguishable from a real verdict forever after. Absent is honest; invented is not. */
export function resolveAlignment(proposed: string | undefined): string {
  const v = (proposed ?? "").trim().toLowerCase();
  return (ALIGNMENTS as readonly string[]).includes(v) ? v : "";
}

/** Where meetings are filed, as configuration rather than code.
 *
 *  A route's `id` IS the folder name, so adding one is adding a folder — a different tenant gets
 *  `client-meetings` / `listings` / `internal` and nothing here changes. `when` is the sentence the
 *  model is given to decide by, authored by whoever knows the business.
 *
 *  No journal configured at all means the flat `Meetings/` layout, unchanged. */
export interface Journal {
  /** Folder inside the brain that holds the routes, e.g. "Meeting-Journals". */
  path: string;
  /** Where anything ambiguous goes. A real destination, NOT an error: "I am not sure" is a
   *  legitimate answer, and forcing a guess is how one client's meeting lands in another's
   *  folder. */
  fallback: string;
  routes: { id: string; when: string }[];
}

/** PURE: is this title just a timestamp?
 *
 *  Plaud names an untitled recording after its own clock — "2026-09-06 23:10:46". Slugged, that
 *  produced `2026-09-07-0310-2026-09-06-23-10-46.md`: the date twice, in two formats, and nothing
 *  a person could recognise in a folder listing. A knowledge base is searched by name. */
export function isTimestampTitle(title: string): boolean {
  return /^\s*\d{4}[-/]\d{2}[-/]\d{2}[\sT_-]*\d{2}[:.-]?\d{2}([:.-]?\d{2})?\s*$/.test(title || "");
}

/** PURE: a filename-safe slug from a meeting title, matching the vault's existing convention
 *  (`2026-07-03-1819-jobs-and-gates-reflect`). Empty when the title yields nothing usable, so the
 *  caller falls back to the bare stamp rather than writing a file called "-.md". */
export function slugFor(title: string): string {
  if (isTimestampTitle(title)) return "";
  return (title || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .slice(0, 8)
    .join("-")
    .slice(0, 60);
}

/** PURE: the route to actually file under.
 *
 *  A CLOSED set. The model's answer is accepted only if it names a configured route; anything else
 *  — a hallucinated folder, a near-miss, an empty string — becomes the fallback. A route invented
 *  by the model would create a directory nobody ever opens, which is strictly worse than a meeting
 *  sitting in `unclassified` where somebody will see it. */
export function resolveRoute(journal: Journal | undefined, proposed: string | undefined): string {
  if (!journal) return "";
  const want = (proposed ?? "").trim().toLowerCase();
  const hit = journal.routes.find((r) => r.id.toLowerCase() === want);
  return hit ? hit.id : journal.fallback;
}

/** PURE: the calendar entry to actually claim.
 *
 *  A CLOSED set, for the same reason `resolveRoute` is one: the model may only choose from what it
 *  was shown. A name it invented or half-remembered would put a confident, wrong meeting title on
 *  the page and file the recording into a series it does not belong to — and unlike a wrong route,
 *  which lands somewhere a person reviews, a wrong meeting name looks entirely correct.
 *
 *  Empty is a legitimate answer and the common one: people record things that are not on anybody's
 *  calendar. */
export function resolveMeeting(candidates: CalEvent[], proposed: string | undefined): CalEvent | undefined {
  const want = (proposed ?? "").trim().toLowerCase();
  if (!want) return undefined;
  return candidates.find((c) => c.summary.trim().toLowerCase() === want);
}

/** PURE: where a recording's page and its folder live, given the journal (or the flat default). */
export function pathsFor(
  journal: Journal | undefined,
  rec: Recording,
  route: string,
  slugHint?: string,
): { page: string; folder: string } {
  // The recording's own title first; when Plaud only gave it a timestamp, a few words from what the
  // meeting was actually about. Naming it after the clock twice helps nobody find it later.
  const slug = slugFor(rec.title) || slugFor(slugHint ?? "");
  const name = slug ? `${rec.stamp}-${slug}` : rec.stamp;
  // posix.join, not join: these are paths INSIDE a git repository, and a backslash would be a
  // literal character in a filename rather than a separator the moment anyone runs this on Windows.
  if (!journal) {
    return { page: path.posix.join("Meetings", `${rec.stamp}.md`), folder: path.posix.join("Meetings", rec.stamp) };
  }
  return {
    page: path.posix.join(journal.path, route, `${name}.md`),
    folder: path.posix.join(journal.path, route, name),
  };
}

/** PURE: how much transcript the summariser is given, and WHICH part of it.
 *
 *  `transcript.slice(0, 40000)` was head-only truncation, and the end of a meeting is exactly where
 *  the decisions and the follow-ups are — so a long meeting silently lost the part those fields are
 *  extracted from, and still produced a confident-looking recap. It never protected the context
 *  limit either: the 413 that killed a 62-minute recording said `Requested 9739` with that cap
 *  already in place, because 40000 characters sits far ABOVE an 8000-token ceiling.
 *
 *  So: keep both ends, and say out loud that the middle is gone. The default is high enough that a
 *  three-hour meeting is never cut — this is a stop against a pathological bill, not a
 *  summarisation strategy. The real answer to a small ceiling is a summariser with room, and that
 *  is a provider row. */
export function budgetTranscript(text: string, max = 200_000): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  const omitted = text.length - max;
  return `${text.slice(0, head)}\n\n[... ${omitted} characters of the middle of this transcript are omitted ...]\n\n${text.slice(-tail)}`;
}

/** PURE: the model's JSON, however it chose to wrap it.
 *
 *  `response_format: json_object` is an OpenAI feature a gateway may honour, emulate, or drop
 *  silently, and the same model that obeys it on one provider fences its answer in a code block on
 *  another. A bare `JSON.parse` throws there — discarding a transcription already paid for, over
 *  punctuation. */
export function parseRecapJson(raw: string): Recap {
  const text = raw.trim();
  const shapes = [text];
  const fenced = /```(?:json)?([^`]*)```/i.exec(text);
  if (fenced?.[1]) shapes.push(fenced[1].trim());
  const open = text.indexOf("{");
  const close = text.lastIndexOf("}");
  if (open >= 0 && close > open) shapes.push(text.slice(open, close + 1));
  for (const shape of shapes) {
    try {
      return JSON.parse(shape) as Recap;
    } catch {
      /* try the next shape */
    }
  }
  throw new Error(`summarize: the model did not return JSON — ${text.slice(0, 200)}`);
}

export async function summarize(
  transcript: string,
  title: string,
  providers: Provider[],
  journal?: Journal,
  candidates: CalEvent[] = [],
  /** What the tenant is trying to do. Empty means this recap does not judge. */
  mission = "",
  /** Names the transcriber is known to mishear. Passed UNCONDITIONALLY — see below. */
  vocab = "",
): Promise<Recap> {
  // Classification rides THIS call rather than taking one of its own: the transcript is already
  // here, already paid for, and a second round-trip would double the latency of every recap to
  // answer a one-word question.
  const routing = journal
    ? [
        `Also decide where this meeting is filed. Choose exactly one "route" from this list:`,
        journal.routes.map((r) => `"${r.id}" — ${r.when}`).join(" | "),
        `If none clearly fits, or the transcript does not say enough to be sure, answer "${journal.fallback}".`,
        `A wrong confident guess is worse than "${journal.fallback}": somebody reviews that folder, and nobody reviews a misfiled meeting.`,
        `Add "route" (one of the ids above) and "routeReason" (one short sentence) to the JSON.`,
      ].join(" ")
    : "";
  // Which calendar entry this was rides the same call, for the same reason routing does — the
  // transcript is already here and already paid for.
  //
  // CONTENT decides, not time. Two meetings overlap, a recording starts in the gap between them,
  // and the only thing that knows which one this was is what people actually said. Picking the
  // nearest start time is what the old pipeline did first and had to undo.
  const calendaring = candidates.length
    ? [
        "A calendar shows these entries around the time of this recording.",
        "Decide which ONE the recording actually is:",
        candidates
          .map(
            (c, i) =>
              `${i + 1}. "${c.summary}"${c.attendees.length ? ` — with ${c.attendees.slice(0, 6).join(", ")}` : ""}`,
          )
          .join(" | "),
        'Add "meeting" to the JSON: the chosen entry\'s text EXACTLY as written above, or "" if the transcript does not clearly match any of them.',
        '"" is a correct and common answer — people record things that are not on a calendar, and a wrong match renames the meeting and files it into a series it does not belong to.',
        'Also add "meetingReason": one short sentence naming what in the transcript decided it.',
      ].join(" ")
    : "";
  // Whether this meeting was worth the attention it took. Rides the same call as routing and
  // calendaring, for the same reason: the transcript is already here and already paid for.
  //
  // THE FAILURE MODE THIS PROMPT IS WRITTEN AGAINST is a field that only ever reports how a meeting
  // helped. That version looks exactly like a working one — every recap has an alignment, every
  // alignment is positive, and the section is quietly worthless. So "detracts" is sanctioned out
  // loud, with examples, and flattery is forbidden by name.
  const aligning = mission
    ? [
        `The person whose meeting this is describes what they are trying to do as: "${mission}".`,
        "Treat that as a statement about ATTENTION, not about topics. It does not mean meetings on other subjects are unimportant; it means their attention is the scarce resource, and the question is whether this meeting bought progress or spent the capacity to make progress.",
        `Add "alignment" to the JSON, exactly one of: ${ALIGNMENTS.join(" | ")}.`,
        '"detracts" is a normal and expected answer. Use it when the meeting reached no decision, re-answered a question already settled, or covered something that belonged in a message — however pleasant or productive it felt.',
        '"neutral" is for a meeting that neither moved this forward nor cost anything worth naming.',
        'Also add "alignmentReason": ONE short sentence naming what in the transcript decided it.',
        "Do not flatter. Do not look for a way to connect the meeting to the goal. If the honest answer is that this was an hour that bought nothing, say so.",
      ].join(" ")
    : "";
  // Vocabulary correction, UNCONDITIONALLY. The chunk cache records text with no note of which
  // provider produced it, and one transcript can mix a vocabulary-biased chunk with an unbiased one
  // across retries — so "was this transcript biased?" has no answer by construction. Asking every
  // time costs nothing and is the only version that is always right.
  //
  // LIMIT, stated: this corrects the RECAP. Transcript.md still says "plot".
  const spelling = vocab
    ? [
        `The transcriber mishears these names: ${vocab}.`,
        "Where the transcript clearly means one of them, use the correct spelling in your answer.",
        "Spelling only — never change what was said or what it meant.",
      ].join(" ")
    : "";
  const system = [
    "You summarise a recorded business meeting for a searchable knowledge base.",
    "Be specific and factual. Never invent a name, number, decision or commitment.",
    "If something is unclear in the transcript, leave it out rather than guessing.",
    'Reply with STRICT JSON only: {"summary": string, "highlights": string[], "decisions": string[], "followups": string[]}.',
    "summary: 2-4 sentences. highlights: at most 5, each one line. decisions/followups may be empty.",
    routing,
    calendaring,
    aligning,
    spelling,
  ]
    .filter(Boolean)
    .join(" ");
  // The MODEL comes from the provider row, so which model summarises is a tenant's configuration
  // rather than this file's opinion — and pointing it at a gateway with room is what removes the
  // 413 that made a 62-minute meeting unsummarisable at any price.
  const served = await chatWith(
    providers,
    {
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: `Meeting: ${title}\n\nTranscript:\n${budgetTranscript(transcript, budgetFor(providers))}` },
      ],
    },
    { log: (line) => console.log(line) },
  );
  const out = parseRecapJson(served.value);
  // A verdict outside the closed set is DROPPED, not coerced. See `resolveAlignment`.
  out.alignment = resolveAlignment(out.alignment);
  if (!out.alignment) out.alignmentReason = undefined;
  return out;
}

const bullets = (xs: string[] | undefined, empty: string): string =>
  xs?.length ? xs.map((x) => `- ${x}`).join("\n") : `_${empty}_`;

/** PURE: `14:00–14:30` in UTC, for the candidate list. Short because the date is already at the
 *  top of the page, and the only question the reader has here is which slot. */
const span = (a: number, b: number, timezone = "UTC"): string => {
  // Same rule as the header: a candidate list showing 16:00–16:30 beside a meeting the reader
  // remembers at noon is worse than no times at all.
  const hm = (t: number): string => localWhen(t, timezone).slice(11, 16);
  return `${hm(a)}–${hm(b)}`;
};

/** PURE: the Calendar section — the match, and everything it was chosen from.
 *
 *  Showing the REJECTED candidates is the point, not padding. "Why is this filed under the wrong
 *  meeting" is unanswerable from a page that shows only the winner, and a calendar match that goes
 *  wrong goes wrong quietly: the title looks plausible and the folder looks deliberate. Listing
 *  what the model saw turns that into something a person can correct in one glance.
 *
 *  Empty string when no calendar is connected, so the page is exactly what it is today. */
/** PURE: the verdict, or nothing at all.
 *
 *  Omitted entirely when there is no mission or the model gave no usable answer. An "Alignment:
 *  unknown" heading on every page would train the reader to skip the section, which costs more than
 *  the section is worth. */
export function alignmentSection(recap: Recap): string {
  if (!recap.alignment) return "";
  const said: Record<string, string> = {
    advances: "Advances the mission",
    neutral: "Neutral for the mission",
    detracts: "Cost attention the mission needed",
  };
  const reason = recap.alignmentReason ? `

${recap.alignmentReason}` : "";
  return `
## Alignment

**${said[recap.alignment] ?? recap.alignment}**${reason}
`;
}

export function calendarSection(recap: Recap, candidates: CalEvent[], timezone = "UTC"): string {
  if (!candidates.length) return "";
  const chosen = (recap.meeting ?? "").trim().toLowerCase();
  const lines = candidates.map((c) => {
    const mark = c.summary.trim().toLowerCase() === chosen ? "**→**" : "·";
    const who = c.attendees.length ? ` — ${c.attendees.slice(0, 4).join(", ")}` : "";
    return `${mark} \`${span(c.start, c.end)}\` ${c.summary}${who}  <sub>${c.source.kind}/${c.source.alias}</sub>`;
  });
  const verdict = recap.meeting
    ? `Matched **${recap.meeting}**${recap.meetingReason ? ` — ${recap.meetingReason}` : ""}`
    : // Not a failure. Most recordings are not on anybody's calendar, and saying so plainly stops
      // the absence of a match reading as a bug.
      `No calendar entry matched${recap.meetingReason ? ` — ${recap.meetingReason}` : ""}.`;
  return `
## Calendar

${verdict}

${lines.join("\n")}
`;
}

/** PURE: the overview page. Separated from writing it so the layout is testable.
 *
 *  The frontmatter matches the convention already in the vault — `recording_id`, `source`,
 *  `datetime`, `title`, `route` — rather than inventing a second one alongside it. `route` in
 *  particular already existed and was always "unclassified"; filling it in is the whole point, and
 *  keeping it in frontmatter means re-filing a meeting is a `git mv` and one edited line. */
/** PURE: a wall-clock time in the TENANT's timezone, as `2026-09-09 12:10 EDT`.
 *
 *  Every time on a recap used to be UTC with nothing saying so, which is the part that made it
 *  wrong rather than merely inconvenient: a 12:10 Eastern interview read as 16:10, and an agent
 *  asked how many meetings there had been that day answered confidently and four hours out.
 *
 *  An IANA NAME, never an offset, because an offset is wrong twice a year. The zone abbreviation is
 *  printed alongside so the reader can tell a local time from a UTC one at a glance — an unlabelled
 *  timestamp is exactly how this went unnoticed.
 *
 *  Falls back to UTC on a zone Node does not recognise, rather than throwing: a typo in a settings
 *  field must not take down a recap. */
export function localWhen(ms: number, timezone = "UTC"): string {
  const zone = timezone || "UTC";
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZoneName: "short",
    }).formatToParts(new Date(ms));
    const at = (t: string): string => parts.find((x) => x.type === t)?.value ?? "";
    // `hour` can come back as "24" for midnight in some ICU builds; normalise so a reader never
    // sees a time that does not exist on a clock.
    const hour = at("hour") === "24" ? "00" : at("hour");
    return `${at("year")}-${at("month")}-${at("day")} ${hour}:${at("minute")} ${at("timeZoneName")}`;
  } catch {
    return `${new Date(ms).toISOString().replace("T", " ").slice(0, 16)} UTC`;
  }
}

/** PURE: who actually transcribed this recording, for the page to state.
 *
 *  It used to be the literal string "Groq (whisper-large-v3-turbo)", written once and true only
 *  while there was exactly one provider. The moment a second one existed that line was a claim
 *  nobody checked, on a page a person reads to decide whether to trust the transcript — and no test
 *  guarded it, because a hardcoded string always matches itself.
 *
 *  Empty means every chunk came from a previous attempt's cache, and the cache records no provider.
 *  That is said plainly rather than guessed at: an honest "not recorded" is worth more here than a
 *  confident name that might be wrong. */
export function transcribedBy(by: string[] = []): string {
  if (by.length === 0) return "a previous attempt (provider not recorded)";
  return by.join(" + ");
}

export function overviewMarkdown(
  rec: Recording,
  recap: Recap,
  folder?: string,
  candidates: CalEvent[] = [],
  by: string[] = [],
  timezone = "UTC",
): string {
  const when = localWhen(rec.startTime, timezone);
  const transcript = folder ? `${path.posix.basename(folder)}/Transcript.md` : `./${rec.stamp}/Transcript.md`;
  const head = [
    "---",
    `recording_id: ${rec.id}`,
    "source: plaud",
    // The INSTANT, unchanged and still UTC — that is what an instant is, and every existing page
    // has it. `local_time` is the same moment as the tenant reads a clock, so a vault query can ask
    // "what did I do on Tuesday" and mean the tenant's Tuesday.
    `datetime: ${new Date(rec.startTime).toISOString()}`,
    `local_time: ${JSON.stringify(localWhen(rec.startTime, timezone))}`,
    `duration_min: ${(rec.duration / 60000).toFixed(1)}`,
    "artifact: overview",
    `title: ${JSON.stringify(rec.title)}`,
    ...(recap.route ? [`route: ${recap.route}`] : []),
    ...(recap.routeReason ? [`route_reason: ${JSON.stringify(recap.routeReason)}`] : []),
    // In frontmatter so the series is queryable from the vault — "every API Team Standup" is the
    // question a knowledge base exists to answer, and it cannot be asked of prose.
    ...(recap.meeting ? [`meeting: ${JSON.stringify(recap.meeting)}`] : []),
    // In frontmatter for the same reason `route` is: "which meetings detracted this month" should
    // be a query over the vault, not a person re-reading thirty pages to find out.
    ...(recap.alignment ? [`alignment: ${recap.alignment}`] : []),
    ...(recap.alignmentReason ? [`alignment_reason: ${JSON.stringify(recap.alignmentReason)}`] : []),
    "---",
    "",
  ].join("\n");

  return `${head}# ${rec.title}

**When:** ${when}${recap.route ? ` · **Filed under:** ${recap.route}` : ""}
**Recorded on:** Plaud · **Transcribed by:** ${transcribedBy(by)}

## Summary

${recap.summary}

## Highlights

${bullets(recap.highlights, "none")}

## Decisions

${bullets(recap.decisions, "none recorded")}

## Follow-ups

${bullets(recap.followups, "none recorded")}
${alignmentSection(recap)}${calendarSection(recap, candidates, timezone)}
---

[Full transcript](${transcript})
`;
}

function git(dir: string, args: string[], env?: NodeJS.ProcessEnv): Promise<{ code: number; out: string }> {
  return run("git", args, { cwd: dir, env });
}

/** Write the recap into the checkout and push it. Returns false when there was nothing to commit,
 *  which is the normal answer for a recording already published. */
export async function publish(
  brainDir: string,
  rec: Recording,
  recap: Recap,
  transcript: string,
  pushUrl: string,
  journal?: Journal,
  candidates: CalEvent[] = [],
  by: string[] = [],
  timezone = "UTC",
): Promise<boolean> {
  const route = resolveRoute(journal, recap.route);
  const where = pathsFor(journal, rec, route, recap.highlights?.[0] ?? recap.summary);
  const dir = path.join(brainDir, where.folder);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(brainDir, where.page),
    overviewMarkdown(rec, { ...recap, route }, where.folder, candidates, by, timezone),
    "utf8",
  );
  await fs.writeFile(
    path.join(dir, "Transcript.md"),
    `# Transcript — ${rec.title}\n\nTranscribed by ${transcribedBy(by)} from the Plaud recording.\n\n---\n\n${transcript}\n`,
    "utf8",
  );

  await git(brainDir, ["add", "-A"]);
  // The identity is passed per-command rather than assumed. A container has no git config, so the
  // commit fails with "please tell me who you are" — and because the old code read ANY non-zero
  // exit as "nothing to commit", that failure was reported as success-with-nothing-to-do. The recap
  // was never committed, the 60-second second-brain `reset --hard` then deleted the untracked file,
  // and the next poll transcribed the same recording again. Every two minutes. That is what
  // exhausted the transcription quota.
  const c = await git(brainDir, [
    "-c",
    "user.name=Tonoman",
    "-c",
    "user.email=agent@tonoman.local",
    "commit",
    "-m",
    `Meeting recap: ${rec.title} (${rec.stamp})`,
  ]);
  if (c.code !== 0) {
    // "nothing to commit" is the ONE benign non-zero exit, and it is now distinguished from every
    // other. A commit that fails for any other reason is a failure, and says so.
    if (/nothing to commit|nothing added to commit/i.test(c.out)) return false;
    throw new Error(`git commit failed: ${redact(c.out, pushUrl).slice(0, 200)}`);
  }

  // The credential rides one command and is never left in .git/config.
  await git(brainDir, ["remote", "set-url", "origin", pushUrl]);
  const p = await git(brainDir, ["push", "origin", "HEAD"]);
  await git(brainDir, ["remote", "set-url", "origin", pushUrl.replace(/\/\/[^@]+@/, "//")]);
  if (p.code !== 0) throw new Error(`git push failed: ${redact(p.out, pushUrl).slice(0, 200)}`);
  return true;
}

/** PURE: never let a tokenised URL reach a log. */
export function redact(text: string, url: string): string {
  return text.split(url).join("***").replace(/\/\/[^/@\s]+:[^/@\s]+@/g, "//***:***@");
}
