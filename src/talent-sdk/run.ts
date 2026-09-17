import type { TalentManifest, TalentRun, TalentContext, TalentInput, TalentOutcome } from './types';

// The bootstrap a Talent's entrypoint calls: `runCli(manifest, run)`. It owns the whole process
// boundary so the Talent's `run` never touches env, argv or stdout. It reads the input on stdin and
// the capability coordinates from the environment, builds the context (HTTP clients to the
// capability plane, progress/log on stderr), calls `run`, and writes exactly one thing to stdout —
// the outcome JSON. A thrown error becomes a `failed` outcome rather than a crash, so the runtime
// always gets a structured result to record.

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function capBase(): { url: string; token: string } {
  const url = process.env.TONOMAN_CAPABILITY_URL;
  if (!url) {
    throw new Error(
      'TONOMAN_CAPABILITY_URL is not set — a Talent runs inside the Tonoman runtime or its dev harness',
    );
  }
  return { url, token: process.env.TONOMAN_CAPABILITY_TOKEN ?? '' };
}

async function callCap<T>(method: 'GET' | 'POST', route: string, body?: unknown): Promise<T> {
  const { url, token } = capBase();
  const res = await fetch(`${url}${route}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = (text ? JSON.parse(text) : {}) as Record<string, unknown>;
  if (!res.ok) throw new Error(`capability ${route} → ${res.status}: ${String(json.error ?? text)}`);
  return json as T;
}

/** PURE: the Talent's input from what the runtime wrote on stdin.
 *
 *  `context` was dropped here: the runtime sent the mission, the journal and its routes, the vocab
 *  and the tenant's timezone, and the Talent received none of it. Every recap then ran with no
 *  routing, no alignment and no spelling rules, and filed to `unclassified` whatever it was. */
export function inputFrom(parsed: Partial<TalentInput>): TalentInput {
  return {
    item: String(parsed.item ?? ''),
    config: (parsed.config as Record<string, unknown>) ?? {},
    user: parsed.user,
    ...(parsed.context ? { context: parsed.context } : {}),
  };
}

export async function runCli(manifest: TalentManifest, run: TalentRun): Promise<void> {
  const progress = (note: string): void => void process.stderr.write(`@progress ${note}\n`);
  const log = (msg: string): void => void process.stderr.write(`${msg}\n`);

  try {
    const rawInput = await readStdin();
    const parsed = (rawInput ? JSON.parse(rawInput) : {}) as Partial<TalentInput>;
    const input = inputFrom(parsed);
    const creds: Record<string, unknown> = process.env.TONOMAN_TALENT_CREDS
      ? (JSON.parse(process.env.TONOMAN_TALENT_CREDS) as Record<string, unknown>)
      : {};

    const ctx: TalentContext = {
      input,
      creds,
      credential: (kind) =>
        callCap<{ creds: unknown }>('GET', `/cap/credential/${encodeURIComponent(kind)}`).then((r) => r.creds),
      cap: {
        transcribe: (i) => callCap('POST', '/cap/transcribe', i),
        infer: (i) => callCap('POST', '/cap/infer', i),
        publish: (p) => callCap('POST', '/cap/publish', p),
        calendarCandidates: (i) => callCap('POST', '/cap/calendar-candidates', i),
        calendarEvents: (i) => callCap('POST', '/cap/calendar-events', i),
      },
      progress,
      log,
    };

    log(`talent ${manifest.name}@${manifest.version} — item ${input.item}`);
    const outcome = await run(ctx);
    process.stdout.write(JSON.stringify(outcome));
  } catch (e) {
    const outcome: TalentOutcome = { status: 'failed', reason: String((e as Error)?.message ?? e) };
    process.stdout.write(JSON.stringify(outcome));
  }
}
