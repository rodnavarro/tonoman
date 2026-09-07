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

export interface PlaudCreds {
  /** The captured web token, as JSON — bearer plus the app headers the API insists on.
   *
   *  The CONTENT, not a path. A path is a property of the pod, and one pod serves every tenant it
   *  has agents for, so a path meant one Plaud account for all of them. Whose account this is has
   *  to be a property of the agent, and the only thing the agent knows is a secret reference. */
  tokenJson: string;
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
  return (await r.json()) as T;
}

export async function listRecordings(creds: PlaudCreds, limit = 20): Promise<Recording[]> {
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
 *  question. The segment muxer does the split in the same pass. */
async function segments(srcPath: string, outDir: string): Promise<string[]> {
  const pattern = path.join(outDir, "part-%03d.flac");
  const r = await run("ffmpeg", [
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    srcPath,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "flac",
    "-f",
    "segment",
    "-segment_time",
    String(SEGMENT_SECONDS),
    pattern,
  ]);
  if (r.code !== 0) throw new Error(`ffmpeg: ${r.out.slice(0, 300)}`);
  const files = (await fs.readdir(outDir)).filter((f) => f.startsWith("part-")).sort();
  if (files.length === 0) throw new Error("ffmpeg produced no audio segments");
  return files.map((f) => path.join(outDir, f));
}

/** One chunk through Groq. Separated so a retry, a log line, or a heartbeat is per chunk. */
async function transcribeChunk(file: string, groqKey: string, vocab: string): Promise<string> {
  const audio = await fs.readFile(file);
  const form = new FormData();
  form.append("file", new Blob([audio], { type: "audio/flac" }), path.basename(file));
  form.append("model", process.env.GROQ_MODEL || "whisper-large-v3-turbo");
  form.append("response_format", "verbose_json");
  // Vocabulary bias. Without it the transcriber hears "Plaud" as "plot" and "Tonoman" as
  // "tournament" — the exact words somebody later searches the second brain for.
  form.append("prompt", vocab);

  const r = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${groqKey}` },
    body: form,
  });
  if (!r.ok) throw new Error(`groq transcribe: ${r.status} ${(await r.text()).slice(0, 300)}`);
  const j = (await r.json()) as { text: string };
  return j.text ?? "";
}

export async function transcribe(
  creds: PlaudCreds,
  rec: Recording,
  groqKey: string,
  vocab: string,
  onProgress?: (done: number, total: number) => void,
): Promise<TranscribeResult> {
  const t0 = Date.now();
  const { temp_url } = await plaudGet<{ temp_url: string }>(creds, `/file/temp-url/${rec.id}`);
  const audio = Buffer.from(await (await fetch(temp_url)).arrayBuffer());

  // A scratch directory per recording, removed whether or not this succeeds. The audio is the
  // customer's meeting; it has no business outliving the transcription.
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "recap-"));
  try {
    const src = path.join(work, "source");
    await fs.writeFile(src, audio);
    const parts = await segments(src, work);
    console.log(`recap: ${rec.title} — ${(audio.length / 1e6).toFixed(1)}MB in ${parts.length} chunk(s)`);

    const texts: string[] = [];
    for (const [i, file] of parts.entries()) {
      // Sequential on purpose: the chunks are one conversation, and a rate-limited burst would
      // fail a whole meeting to save a few seconds on one.
      texts.push(await transcribeChunk(file, groqKey, vocab));
      onProgress?.(i + 1, parts.length);
    }
    return { text: joinChunks(texts), seconds: (Date.now() - t0) / 1000 };
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

export async function summarize(
  transcript: string,
  title: string,
  groqKey: string,
  journal?: Journal,
): Promise<Recap> {
  // Checked against /v1/models rather than assumed — the obvious llama name is not on this account.
  const model = process.env.GROQ_TEXT_MODEL || "openai/gpt-oss-120b";
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
  const system = [
    "You summarise a recorded business meeting for a searchable knowledge base.",
    "Be specific and factual. Never invent a name, number, decision or commitment.",
    "If something is unclear in the transcript, leave it out rather than guessing.",
    'Reply with STRICT JSON only: {"summary": string, "highlights": string[], "decisions": string[], "followups": string[]}.',
    "summary: 2-4 sentences. highlights: at most 5, each one line. decisions/followups may be empty.",
    routing,
  ]
    .filter(Boolean)
    .join(" ");
  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${groqKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: `Meeting: ${title}\n\nTranscript:\n${transcript.slice(0, 40000)}` },
      ],
    }),
  });
  if (!r.ok) throw new Error(`groq summarize: ${r.status} ${(await r.text()).slice(0, 300)}`);
  const j = (await r.json()) as { choices: { message: { content: string } }[] };
  return JSON.parse(j.choices[0]!.message.content) as Recap;
}

const bullets = (xs: string[] | undefined, empty: string): string =>
  xs?.length ? xs.map((x) => `- ${x}`).join("\n") : `_${empty}_`;

/** PURE: the overview page. Separated from writing it so the layout is testable.
 *
 *  The frontmatter matches the convention already in the vault — `recording_id`, `source`,
 *  `datetime`, `title`, `route` — rather than inventing a second one alongside it. `route` in
 *  particular already existed and was always "unclassified"; filling it in is the whole point, and
 *  keeping it in frontmatter means re-filing a meeting is a `git mv` and one edited line. */
export function overviewMarkdown(rec: Recording, recap: Recap, folder?: string): string {
  const when = new Date(rec.startTime).toISOString().replace("T", " ").slice(0, 16);
  const transcript = folder ? `${path.posix.basename(folder)}/Transcript.md` : `./${rec.stamp}/Transcript.md`;
  const head = [
    "---",
    `recording_id: ${rec.id}`,
    "source: plaud",
    `datetime: ${new Date(rec.startTime).toISOString()}`,
    `duration_min: ${(rec.duration / 60000).toFixed(1)}`,
    "artifact: overview",
    `title: ${JSON.stringify(rec.title)}`,
    ...(recap.route ? [`route: ${recap.route}`] : []),
    ...(recap.routeReason ? [`route_reason: ${JSON.stringify(recap.routeReason)}`] : []),
    "---",
    "",
  ].join("\n");

  return `${head}# ${rec.title}

**When:** ${when}${recap.route ? ` · **Filed under:** ${recap.route}` : ""}
**Recorded on:** Plaud · **Transcribed by:** Groq (\`whisper-large-v3-turbo\`)

## Summary

${recap.summary}

## Highlights

${bullets(recap.highlights, "none")}

## Decisions

${bullets(recap.decisions, "none recorded")}

## Follow-ups

${bullets(recap.followups, "none recorded")}

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
): Promise<boolean> {
  const route = resolveRoute(journal, recap.route);
  const where = pathsFor(journal, rec, route, recap.highlights?.[0] ?? recap.summary);
  const dir = path.join(brainDir, where.folder);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(brainDir, where.page), overviewMarkdown(rec, { ...recap, route }, where.folder), "utf8");
  await fs.writeFile(
    path.join(dir, "Transcript.md"),
    `# Transcript — ${rec.title}\n\nTranscribed by Groq \`whisper-large-v3-turbo\` from the Plaud recording.\n\n---\n\n${transcript}\n`,
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
