// Inference providers: WHO transcribes and WHO summarises, and what happens when one of them says no.
//
// WHY THIS IS A LIST AND NOT A KEY. The voice flow used to name one provider in code — Groq, read
// from `GROQ_API_KEY` at the call site. That made three separate things impossible: a tenant could
// not bring its own transcription, a rotated key killed every meeting while a working second key sat
// unused, and a 62-minute recording could not be summarised AT ALL because the free tier's context
// is 8000 tokens and no amount of retrying makes a request smaller.
//
// A provider is therefore shaped like a ROW — name, url, model, key — so the registry can become the
// source without a single call site changing. The platform default stays Groq. A tenant's own
// providers come from `flow_property` rows and win. Nothing here defaults to a machine: an address
// like `host.containers.internal:8181` is meaningful on exactly one laptop and resolves nowhere in a
// cluster, so a local server is included only when somebody explicitly configured one.
//
// PURE WHERE IT MATTERS. `classifyAttempt` and `chooseFailure` never touch the network, because
// deciding "is this worth retrying, and when" is the part that was wrong before and the part a test
// can actually pin down.

import fs from "node:fs/promises";
import path from "node:path";
import { ApplicationFailure } from "@temporalio/common";

/** One place that can answer. `baseUrl` is the OpenAI-compatible root — the bit before
 *  `/audio/transcriptions` — because every provider worth having speaks that shape. */
export interface Provider {
  /** For the log and for the recap's provenance line. Not an id: nothing looks it up. */
  name: string;
  baseUrl: string;
  model: string;
  /** Absent for a server that wants no auth. ABSENT, not empty: see `authHeaders`. */
  apiKey?: string;
  timeoutMs?: number;
  /** Whether this provider biases its vocabulary from `prompt`. Groq does; faster-whisper's
   *  OpenAI-compatible server accepts the field and ignores it. Recorded because it changes what the
   *  transcript will contain, not because it changes what we send. */
  biasesWithPrompt?: boolean;
}

/** What one provider said. Deliberately not an Error: an attempt is EVIDENCE, and the decision about
 *  what to throw can only be made once every provider has spoken. */
export interface Attempt {
  provider: string;
  kind: "rateLimited" | "server" | "permanent" | "transport";
  message: string;
  /** Only for `rateLimited`, and only when the provider named a time. */
  delayMs?: number;
}

/** How long to wait before asking again, in milliseconds, or undefined if nobody said.
 *
 *  Two sources because Groq uses both: a `retry-after` header, and — for the daily audio budget —
 *  only a sentence in the body, `"Please try again in 19m48s"`. Reading just the header would have
 *  missed the one that actually matters here. Capped at six hours so a malformed or hostile value
 *  cannot park a meeting until next week. */
export function retryAfterMs(header: string | null, body: string): number | undefined {
  const cap = (ms: number): number => Math.min(Math.max(ms, 1_000), 6 * 3_600_000);
  const h = Number(header);
  if (Number.isFinite(h) && h > 0) return cap(h * 1000);
  // "19m48s", "1h2m3s", "45.6s" — the shape Groq writes into the message.
  const m = /try again in\s+(?:(\d+)h)?(?:(\d+)m)?(?:([\d.]+)s)?/i.exec(body);
  if (m && (m[1] || m[2] || m[3])) {
    const ms = (Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)) * 1000;
    if (ms > 0) return cap(ms);
  }
  return undefined;
}

/** The right KIND of failure for a Groq response. KEPT for the single-provider path and its tests;
 *  `chooseFailure` is the same judgement made across several providers at once.
 *
 *  The distinction this exists to make: `429 ... please try again in 19m48s` is a request that came
 *  too EARLY, and waiting fixes it. `413 ... Limit 8000, Requested 9739` is a request that is too
 *  LARGE, and no amount of waiting will ever make it fit — it burned seven attempts proving that,
 *  each one a full transcription's worth of orchestration for a foregone conclusion. */
export function groqFailure(what: string, status: number, body: string, retryAfter: string | null): Error {
  const message = `groq ${what}: ${status} ${body}`;
  if (status === 429) {
    const wait = retryAfterMs(retryAfter, body);
    if (wait !== undefined) {
      return ApplicationFailure.create({ message, type: "GroqRateLimited", nextRetryDelay: wait });
    }
  }
  // Too large, malformed, unauthorised, or a model that does not exist: all of them are the same
  // request next time, and the same answer.
  if ([400, 401, 403, 404, 413].includes(status)) {
    return ApplicationFailure.create({ message, type: "GroqRejected", nonRetryable: true });
  }
  return new Error(message);
}

/** Statuses no retry can fix FOR THE PROVIDER THAT SAID THEM.
 *
 *  Note what is NOT universal here, because assuming it was is the bug this replaces. A `413` from
 *  the local whisper server is a fact about that server's body limit, not about the chunk — Groq
 *  accepts 25MB and would have transcribed it. Treating any 4xx as fatal for the RECORDING meant one
 *  provider's limit could kill a meeting without the next provider ever being asked, which is the
 *  exact opposite of what a fallback is for. So these end the ATTEMPT, never the recording; only
 *  `chooseFailure` decides whether the recording is finished. */
const PERMANENT = [400, 401, 403, 404, 413, 422];

/** PURE. What one HTTP response means, without deciding anything about the others. */
export function classifyAttempt(
  provider: string,
  what: string,
  status: number,
  body: string,
  retryAfter: string | null,
): Attempt {
  const message = `${provider} ${what}: ${status} ${body}`;
  if (status === 429) return { provider, kind: "rateLimited", message, delayMs: retryAfterMs(retryAfter, body) };
  if (PERMANENT.includes(status)) return { provider, kind: "permanent", message };
  // 5xx, 408, and anything unrecognised: assumed transient, because guessing "permanent" wrongly
  // discards a meeting and guessing "transient" wrongly costs one more attempt.
  return { provider, kind: "server", message };
}

/** PURE. Every provider has now answered; this is what to throw.
 *
 *  THE DELAY IS THE MINIMUM, not the last one. You need exactly ONE provider to come back, so the
 *  soonest time anybody named is the honest wait. Taking the last retryable attempt — the obvious
 *  implementation — also throws the delay away entirely whenever the final provider happened to say
 *  `429` without naming a time, turning a precise 19-minute wait into a blind exponential backoff. */
export function chooseFailure(what: string, attempts: Attempt[]): Error {
  if (attempts.length === 0) {
    return ApplicationFailure.create({
      message: `${what}: no inference provider is configured — set GROQ_API_KEY, or add transcribe.* rows for this agent`,
      type: "NoProvider",
      nonRetryable: true,
    });
  }
  const message = attempts.map((a) => a.message).join(" | ");

  const delays = attempts.map((a) => a.delayMs).filter((d): d is number => d !== undefined);
  if (delays.length > 0) {
    return ApplicationFailure.create({ message, type: "RateLimited", nextRetryDelay: Math.min(...delays) });
  }
  // Anything that might work on its own next time — a 5xx, a timeout, a dropped connection — makes
  // the whole thing retryable on Temporal's ordinary backoff. Mixed with a permanent refusal from
  // some OTHER provider, retryable still wins: the one that refused is not the only one asked.
  if (attempts.some((a) => a.kind === "server" || a.kind === "transport" || a.kind === "rateLimited")) {
    return new Error(message);
  }
  // Everyone refused permanently. NOW it is worth stopping — this is yesterday's 413 lesson, kept.
  return ApplicationFailure.create({ message, type: "Rejected", nonRetryable: true });
}

/** OMITTED, not empty. `Authorization: Bearer undefined` is a string a server will happily reject as
 *  a bad credential, which reads in the log as "the local GPU refused our key" for a server that
 *  wanted no key at all. */
function authHeaders(p: Provider): Record<string, string> {
  return p.apiKey ? { Authorization: `Bearer ${p.apiKey}` } : {};
}

const DEFAULT_TRANSCRIBE_MS = 15 * 60_000;
const DEFAULT_CHAT_MS = 5 * 60_000;

export interface Served<T> {
  value: T;
  provider: Provider;
}

export interface TryOptions {
  /** Told when a provider fails at the transport level, so a dead server can be skipped for the rest
   *  of a recording rather than waited on once per chunk. */
  onDead?: (name: string) => void;
  log?: (line: string) => void;
}

const timedOut = (e: unknown): boolean => (e as Error).name === "TimeoutError" || (e as Error).name === "AbortError";

/** One chunk of audio, through the first provider that will take it.
 *
 *  EVERY provider is tried, always, even after a refusal that looks permanent — see `PERMANENT`. The
 *  cost of not short-circuiting is one instant HTTP rejection; the cost of short-circuiting wrongly
 *  is a meeting discarded while a working provider was never asked. */
export async function transcribeWith(
  providers: Provider[],
  file: string,
  vocab: string,
  opts: TryOptions = {},
): Promise<Served<string>> {
  const attempts: Attempt[] = [];
  const audio = await fs.readFile(file);

  for (const [i, p] of providers.entries()) {
    const wait = p.timeoutMs ?? DEFAULT_TRANSCRIBE_MS;
    const form = new FormData();
    form.append("file", new Blob([audio], { type: "audio/flac" }), path.basename(file));
    form.append("model", p.model);
    form.append("response_format", "verbose_json");
    // Vocabulary bias. Without it the transcriber hears "Plaud" as "plot" and "Tonoman" as
    // "tournament" — the exact words somebody later searches the second brain for. Sent even to a
    // provider that ignores it, because the alternative is a per-provider special case for a field
    // that costs nothing to send.
    if (vocab) form.append("prompt", vocab);

    try {
      const r = await fetch(`${p.baseUrl}/audio/transcriptions`, {
        method: "POST",
        headers: authHeaders(p),
        body: form,
        // A provider that ACCEPTS and then hangs is worse than one that refuses: without this the
        // activity parks for its whole start-to-close timeout and never reaches the next provider.
        signal: AbortSignal.timeout(wait),
      });
      if (!r.ok) {
        const body = (await r.text()).slice(0, 300);
        attempts.push(classifyAttempt(p.name, "transcribe", r.status, body, r.headers.get("retry-after")));
        continue;
      }
      const j = (await r.json()) as { text?: string };
      // SAID OUT LOUD when it was not the first choice. A fallback that never announces itself hides
      // a dead GPU while the paid provider quietly picks up the bill — the failure still "works",
      // which is why it can run for a month unnoticed.
      if (i > 0) {
        opts.log?.(`inference: transcribe fell through to ${p.name} — ${attempts.map((a) => a.message).join(" | ")}`);
      }
      return { value: j.text ?? "", provider: p };
    } catch (e) {
      const why = timedOut(e) ? `no response in ${Math.round(wait / 1000)}s` : ((e as Error).message ?? "transport error");
      attempts.push({ provider: p.name, kind: "transport", message: `${p.name} transcribe: ${why}` });
      opts.onDead?.(p.name);
    }
  }
  throw chooseFailure("transcribe", attempts);
}

/** A chat completion, through the first provider that will take it. Same rules; different endpoint.
 *
 *  This is what removes the 413. Summarising is not a transcription concern and never was — it was
 *  only on the transcription provider because that is where the key happened to be, and a 62-minute
 *  meeting does not fit in that tier's context at any price. */
export async function chatWith(
  providers: Provider[],
  body: Record<string, unknown>,
  opts: TryOptions = {},
): Promise<Served<string>> {
  const attempts: Attempt[] = [];

  for (const [i, p] of providers.entries()) {
    const wait = p.timeoutMs ?? DEFAULT_CHAT_MS;
    try {
      const r = await fetch(`${p.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders(p) },
        body: JSON.stringify({ ...body, model: p.model }),
        signal: AbortSignal.timeout(wait),
      });
      if (!r.ok) {
        const text = (await r.text()).slice(0, 300);
        attempts.push(classifyAttempt(p.name, "summarize", r.status, text, r.headers.get("retry-after")));
        continue;
      }
      const j = (await r.json()) as { choices?: { message?: { content?: string } }[] };
      if (i > 0) {
        opts.log?.(`inference: summarize fell through to ${p.name} — ${attempts.map((a) => a.message).join(" | ")}`);
      }
      return { value: j.choices?.[0]?.message?.content ?? "", provider: p };
    } catch (e) {
      const why = timedOut(e) ? `no response in ${Math.round(wait / 1000)}s` : ((e as Error).message ?? "transport error");
      attempts.push({ provider: p.name, kind: "transport", message: `${p.name} summarize: ${why}` });
      opts.onDead?.(p.name);
    }
  }
  throw chooseFailure("summarize", attempts);
}
