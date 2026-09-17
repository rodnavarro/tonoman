import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import * as recap from "./recap";
import * as calendar from "./calendar";
import type { CalEvent } from "./calendar";
import * as plaudapi from "./plaudapi";
import { recordingKey } from "./recordingkey";
import { accountFor, type TurnDeps } from "./activities";
import type { TalentOutcome } from "../talent-sdk";

// The capability plane — the runtime side of the Talent SDK's mediated capabilities (A15).
//
// A Talent is a spawned CLI that cannot reach into the worker. The three things it is NOT allowed to
// do itself — route transcription across the tenant's providers, spend the tenant's inference
// budget, write the tenant's git-backed second brain — it asks this server to do, over localhost.
// That is what keeps provider routing, metering and the brain the runtime's, never baked into a
// Talent, while the Talent stays portable.
//
// One server per worker, started at boot, closed over `deps`. `runTalent` mints a short-lived token
// per spawn that names the run (agent, item, user); every handler resolves the run's VoiceConfig
// from that token and delegates to the same cores Sapien's live pipeline uses. localhost + a random
// bearer is the whole auth story: the only caller is a subprocess on this host.

interface RunToken {
  agent: string;
  item: string;
  user?: string;
  expiresAt: number;
}

export interface CapabilityPlane {
  /** Base URL handed to a spawned Talent as TONOMAN_CAPABILITY_URL. */
  url: string;
  /** Issue a token scoped to one run; pass it to the Talent as TONOMAN_CAPABILITY_TOKEN. */
  mint(run: { agent: string; item: string; user?: string }): string;
  /** Drop a token once its child has exited. */
  revoke(token: string): void;
  /** Spawn a Talent CLI for one run against this plane and return its outcome. Used by the runTalent
   *  activity and the dev-run endpoint. */
  spawn(
    run: { agent: string; item: string; user?: string; talent?: string },
    opts?: { signal?: AbortSignal; onProgress?: (note: string) => void },
  ): Promise<TalentOutcome>;
  close(): Promise<void>;
}

function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

/** name → the Talent CLI's entrypoint, relative to the repo root (the worker's cwd). One entry while
 *  there is one built-in Talent; this becomes the loader's registry when a second arrives. */
const TALENT_ENTRY: Record<string, string> = {
  "meeting-recap": "src/talents/voice/plaud-and-calendar-meetings/index.ts",
};

/** Spawn a Talent CLI as a subprocess and collect its outcome. This is the core both the `runTalent`
 *  Temporal activity and the dev-run endpoint share: mint a scoped token, assemble the input (the
 *  item + this agent's config + the runtime context the Talent needs but must not hold — mission,
 *  journal, vocab), run `tsx <entry>` with the capability coordinates in its env, pipe the input on
 *  stdin, read the single outcome JSON on stdout and progress lines on stderr, then revoke the token.
 *  A cancellation (Temporal activity timeout/cancel) kills the child. */
async function runTalentProcess(
  deps: TurnDeps,
  baseUrl: string,
  mint: (r: RunToken) => string,
  revoke: (t: string) => void,
  run: { agent: string; item: string; user?: string; talent?: string },
  opts?: { signal?: AbortSignal; onProgress?: (note: string) => void },
): Promise<TalentOutcome> {
  const talent = run.talent ?? "meeting-recap";
  const entry = TALENT_ENTRY[talent];
  if (!entry) return { status: "failed", reason: `no CLI registered for talent ${talent}` };
  const voice = deps.voice?.(run.agent);
  if (!voice) return { status: "failed", reason: `no voice configuration for ${run.agent}` };

  const token = mint({ agent: run.agent, item: run.item, user: run.user, expiresAt: Date.now() + 6 * 60 * 60 * 1000 });
  try {
    const input = {
      item: run.item,
      user: run.user,
      config: {},
      // The tenant context the recap prompt needs — provided by the runtime, never held by the Talent.
      context: { mission: voice.mission ?? "", journal: voice.journal, vocab: voice.vocab, timezone: voice.timezone },
    };
    // The production image ships compiled `dist` and omits `tsx` and `src` (`npm ci --omit=dev`), so
    // `tsx src/…/index.ts` cannot run there. Prefer the compiled Talent (`node dist/…/index.js`), and
    // fall back to tsx on the TS source for local dev, which runs from a bind-mounted tree with no
    // build. `existsSync` is resolved against the worker's cwd, the same base the spawn uses.
    const distEntry = entry.replace(/^src[/\\]/, "dist/").replace(/\.ts$/, ".js");
    const compiled = existsSync(distEntry);
    const child = spawn(compiled ? "node" : "tsx", [compiled ? distEntry : entry], {
      env: { ...process.env, TONOMAN_CAPABILITY_URL: baseUrl, TONOMAN_CAPABILITY_TOKEN: token },
      stdio: ["pipe", "pipe", "pipe"],
    });
    // A spawn that never starts (the missing-`tsx` bug that crash-looped the cluster) emits 'error';
    // with no listener Node throws it uncaught and kills the whole worker. Capture it and turn it
    // into a failed outcome instead — one recording must never take the worker down.
    let spawnError: string | undefined;
    child.on("error", (e) => (spawnError = (e as Error).message));
    child.stdin.on("error", () => {}); // a dead child's stdin errors on write; swallow it
    const onAbort = (): void => void child.kill("SIGTERM");
    opts?.signal?.addEventListener("abort", onAbort);

    try {
      child.stdin.write(JSON.stringify(input));
      child.stdin.end();
    } catch {
      /* the child failed to spawn; the error handler above already has the reason */
    }

    let out = "";
    let err = "";
    let carry = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => {
      err += d.toString();
      carry += d.toString();
      const lines = carry.split("\n");
      carry = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("@progress ")) opts?.onProgress?.(line.slice("@progress ".length).trim());
        else if (line.trim()) console.log(`talent:${run.agent}:${talent} ${line}`);
      }
    });

    const code = await new Promise<number>((resolve) => {
      child.on("close", (c) => resolve(c ?? 0));
      child.on("error", () => resolve(-1)); // spawn failed to start — 'close' may never fire
    });
    opts?.signal?.removeEventListener("abort", onAbort);

    if (spawnError) return { status: "failed", reason: `could not start talent ${talent}: ${spawnError}` };
    const trimmed = out.trim();
    if (!trimmed) {
      return { status: "failed", reason: `talent exited ${code} with no outcome — ${err.slice(-400)}` };
    }
    return JSON.parse(trimmed) as TalentOutcome;
  } finally {
    revoke(token);
  }
}

export async function startCapabilityPlane(deps: TurnDeps): Promise<CapabilityPlane> {
  const tokens = new Map<string, RunToken>();
  let baseUrl = "";
  const mint = (run: RunToken): string => {
    const token = randomBytes(24).toString("hex");
    tokens.set(token, run);
    return token;
  };
  const revoke = (token: string): void => void tokens.delete(token);
  const spawnTalent: CapabilityPlane["spawn"] = (run, opts) =>
    runTalentProcess(deps, baseUrl, mint, revoke, run, opts);

  const server = http.createServer((req, res) => {
    void (async () => {
      const reply = (code: number, obj: unknown): void => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(obj));
      };

      const pathname = new URL(req.url ?? "/", "http://plane").pathname;

      // Dev harness: run a Talent end-to-end against this plane without the Temporal poll. Gated by
      // TONOMAN_TALENT_DEV so it never exists in a real deployment. This is the "develop locally"
      // path and the step-6 proof hook — it mints its own token, so it is the one route without one.
      if (process.env.TONOMAN_TALENT_DEV && req.method === "POST" && pathname === "/dev/run") {
        const b = await readJson(req);
        const outcome = await spawnTalent({
          agent: String(b.agent ?? ""),
          item: String(b.item ?? ""),
          user: b.user ? String(b.user) : undefined,
          talent: b.talent ? String(b.talent) : undefined,
        });
        return reply(200, outcome);
      }

      const auth = req.headers.authorization ?? "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      const run = tokens.get(token);
      if (!run || run.expiresAt < Date.now()) return reply(401, { error: "unauthorized" });

      const voice = deps.voice?.(run.agent);
      if (!voice) return reply(404, { error: `no voice configuration for ${run.agent}` });

      const body = req.method === "POST" ? await readJson(req) : {};

      try {
        // transcribe: the Talent resolved the audio URL with its own credential; the plane fetches,
        // segments and routes it through the TENANT's transcription chain (groq / local-gpu). Per-
        // user chunk cache, exactly like the live pipeline, so a retry resumes.
        if (req.method === "POST" && pathname === "/cap/transcribe") {
          const cacheDir =
            run.user && voice.chunkCacheDir
              ? path.join(voice.chunkCacheDir, encodeURIComponent(run.user))
              : voice.chunkCacheDir;
          const out = await recap.transcribeAudio(
            String(body.audioUrl ?? ""),
            String(body.label ?? run.item),
            // The cache is keyed by the recording's KEY, whatever the source calls the id today.
            recordingKey(String(body.cacheId ?? run.item)),
            voice.transcribe,
            typeof body.vocab === "string" ? body.vocab : voice.vocab,
            undefined,
            cacheDir,
          );
          return reply(200, out);
        }

        // infer: the reasoning runs on the AGENT'S OWN inference provider (the Claude Code harness /
        // its subscription), NOT a side model — a recap is the agent thinking about the meeting. The
        // prompt is the Talent's; the plane budgets the user message to a generous window (Claude is
        // large) and routes it through deps.infer. The Talent parses the returned text.
        if (req.method === "POST" && pathname === "/cap/infer") {
          if (!deps.infer) return reply(503, { error: "this runtime has no inference provider" });
          const text = await deps.infer(
            run.agent,
            {
              system: String(body.system ?? ""),
              user: recap.budgetTranscript(String(body.user ?? ""), 500_000),
            },
            // Whose item this is. The token names it, so a Talent cannot choose whose subscription pays.
            run.user,
          );
          return reply(200, { text });
        }

        // publish: file the artifact in the tenant's git-backed second brain. The Talent supplies the
        // content (rec, recap, transcript, candidates, by); the repo, push credential, journal and
        // timezone are the runtime's, resolved here. Returns where it landed so the Talent can report.
        if (req.method === "POST" && pathname === "/cap/publish") {
          const rec = body.rec as recap.Recording;
          const r = body.recap as recap.Recap;
          const published = await recap.publish(
            voice.brainDir,
            rec,
            r,
            String(body.transcript ?? ""),
            voice.pushUrl,
            voice.journal,
            (body.candidates as CalEvent[]) ?? [],
            (body.by as string[]) ?? [],
            voice.timezone,
            // WHOSE recap — the per-person account this run was polled from. The brain is still keyed
            // by agent today, but the page now carries the owner so a later per-user split is a
            // re-file, not a reconstruction. Undefined on the shared path (Sapien), so unchanged.
            run.user,
          );
          const route = recap.resolveRoute(voice.journal, r?.route);
          // The same resolution `publish` used, re-run after the write — the page now carries this
          // recording's id, so it resolves to exactly where it landed, suffix and all.
          const where = await recap.pathsForUnique(
            voice.brainDir,
            voice.journal,
            rec,
            route,
            r?.highlights?.[0] ?? r?.summary,
          );
          return reply(200, { published, path: where.page, route });
        }

        // calendar candidates around a recording. TRANSITIONAL: calendar is a `requires` credential,
        // so the clean shape is the Talent fetching the feed itself via credential('calendar'). Until
        // the ICS parsing is ported into the Talent, the plane resolves candidates from the tenant's
        // configured feeds and applies the same padded window the live pipeline does.
        if (req.method === "POST" && pathname === "/cap/calendar-candidates") {
          if (!voice.calendars?.length) return reply(200, []);
          const w = calendar.windowFor(Number(body.from ?? 0), Number(body.to ?? 0), voice.calendarPadMinutes);
          const cands = await calendar.gather(voice.calendars, w.from, w.to, {
            exclude: voice.calendarExclude,
            log: (m: string) => console.log(m),
          });
          return reply(200, cands);
        }

        // credential: a fresh, usable credential for a kind the Talent declared in `requires`. For
        // Plaud the plane resolves (and refreshes) the OAuth bearer from the tokenstore and hands the
        // Talent a ready {token, base} — so the Talent only needs the Plaud API, never the tokenstore,
        // and can re-fetch across a long run. (The legacy captured-bearer path returns tokenJson.)
        if (req.method === "GET" && pathname.startsWith("/cap/credential/")) {
          const kind = decodeURIComponent(pathname.slice("/cap/credential/".length));
          if (kind === "plaud") {
            const creds = accountFor(voice, run.user).creds;
            if (creds.cliAgent) {
              const token = await plaudapi.accessToken(creds.cliAgent, creds.cliUser);
              return reply(200, { creds: { token, base: plaudapi.API_BASE } });
            }
            return reply(200, { creds: { tokenJson: creds.tokenJson } });
          }
          return reply(404, { error: `no credential of kind ${kind}` });
        }

        return reply(404, { error: "no such capability" });
      } catch (e) {
        return reply(500, { error: String((e as Error)?.message ?? e) });
      }
    })();
  });

  // A fixed port only when asked (dev, so the dev-run endpoint is reachable by `podman exec curl`);
  // 0 = an ephemeral port in a real deployment, since the only caller is a child on this host.
  const wantPort = Number(process.env.TONOMAN_CAPABILITY_PORT) || 0;
  await new Promise<void>((resolve) => server.listen(wantPort, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}`;

  return {
    url: baseUrl,
    // Public mint stamps the standard 6-hour expiry; internal spawns pass their own RunToken.
    mint(run) {
      return mint({ ...run, expiresAt: Date.now() + 6 * 60 * 60 * 1000 });
    },
    revoke,
    spawn: spawnTalent,
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
