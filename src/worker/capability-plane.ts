import { commandFor, ownGroup, runBegan, stopAll, type TurnUser } from "../harness/launch";
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
import { accountFor, type TurnDeps, type VoiceConfig } from "./activities";
import type { SkillOutcome } from "../skill-sdk";
import { pagePathTrouble, publishPageToBrain, publishRecapToBrain } from "../brains/skillpublish";

// The capability plane — the runtime side of the Skill SDK's mediated capabilities (A15).
//
// A Skill is a spawned CLI that cannot reach into the worker. The three things it is NOT allowed to
// do itself — route transcription across the tenant's providers, spend the tenant's inference
// budget, write the tenant's git-backed second brain — it asks this server to do, over localhost.
// That is what keeps provider routing, metering and the brain the runtime's, never baked into a
// Skill, while the Skill stays portable.
//
// One server per worker, started at boot, closed over `deps`. `runSkill` mints a short-lived token
// per spawn that names the run (agent, item, user); every handler resolves the run's VoiceConfig
// from that token and delegates to the same cores Sapien's live pipeline uses. localhost + a random
// bearer is the whole auth story: the only caller is a subprocess on this host.

interface RunToken {
  agent: string;
  item: string;
  user?: string;
  skill?: string;
  expiresAt: number;
}

export interface CapabilityPlane {
  /** Base URL handed to a spawned Skill as TONOMAN_CAPABILITY_URL. */
  url: string;
  /** Issue a token scoped to one run; pass it to the Skill as TONOMAN_CAPABILITY_TOKEN. */
  mint(run: { agent: string; item: string; user?: string; skill?: string }): string;
  /** Drop a token once its child has exited. */
  revoke(token: string): void;
  /** Spawn a Skill CLI for one run against this plane and return its outcome. Used by the runSkill
   *  activity and the dev-run endpoint. */
  spawn(
    run: { agent: string; item: string; user?: string; skill?: string; instance?: string },
    opts?: { signal?: AbortSignal; onProgress?: (note: string) => void },
  ): Promise<SkillOutcome>;
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

/** PURE: the command, words and environment that start a Skill's program. As the run's own user
 *  the worker's environment is scrubbed of its secrets first — a Skill asks the runtime for what it
 *  needs (SKILL-ASKS-THE-RUNTIME), so all it is told is where to ask and the run's token. */
export function skillCommand(runAs: TurnUser | undefined, bin: string, args: string[], workerEnv: NodeJS.ProcessEnv, baseUrl: string, token: string): { cmd: string; args: string[]; env: NodeJS.ProcessEnv } {
  return commandFor(runAs, bin, args, workerEnv, { TONOMAN_CAPABILITY_URL: baseUrl, TONOMAN_CAPABILITY_TOKEN: token });
}

/** name → the Skill CLI's entrypoint, relative to the repo root (the worker's cwd). One entry while
 *  there is one built-in Skill; this becomes the loader's registry when a second arrives. */
const SKILL_ENTRY: Record<string, string> = {
  "meeting-recap": "src/skills/voice/plaud-and-calendar-meetings/index.ts",
  "agenda-brief": "src/skills/calendar/agenda-brief/index.ts",
  "drop-watch": "src/skills/lorealistar/drop-watch/index.ts",
};

/** Spawn a Skill CLI as a subprocess and collect its outcome. This is the core both the `runSkill`
 *  Temporal activity and the dev-run endpoint share: mint a scoped token, assemble the input (the
 *  item + this agent's config + the runtime context the Skill needs but must not hold — mission,
 *  journal, vocab), run `tsx <entry>` with the capability coordinates in its env, pipe the input on
 *  stdin, read the single outcome JSON on stdout and progress lines on stderr, then revoke the token.
 *  A cancellation (Temporal activity timeout/cancel) kills the child. */
/** Skills that have nothing to do with recordings, and so need no recording flow to run. */
const NEEDS_NO_RECORDINGS = new Set(["drop-watch"]);

async function runSkillProcess(
  deps: TurnDeps,
  baseUrl: string,
  mint: (r: RunToken) => string,
  revoke: (t: string) => void,
  run: { agent: string; item: string; user?: string; skill?: string; instance?: string },
  opts?: { signal?: AbortSignal; onProgress?: (note: string) => void },
  /** The brains each run filed into, by token — set by /cap/publish, read once the run ends. */
  filedIn: Map<string, string[]> = new Map(),
): Promise<SkillOutcome> {
  const skill = run.skill ?? "meeting-recap";
  const entry = SKILL_ENTRY[skill];
  if (!entry) return { status: "failed", reason: `no program registered for skill ${skill}` };
  // A Skill that has nothing to do with recordings runs on an agent with no recording flow
  // (SKILL-NEEDS-NO-RECORDINGS); what it is handed of the tenant's context is what there is.
  const voice = deps.voice?.(run.agent);
  if (!voice && !NEEDS_NO_RECORDINGS.has(skill)) return { status: "failed", reason: `no voice configuration for ${run.agent}` };

  const token = mint({ agent: run.agent, item: run.item, user: run.user, skill, expiresAt: Date.now() + 6 * 60 * 60 * 1000 });
  try {
    const input = {
      item: run.item,
      user: run.user,
      // The grant's saved config (an agenda brief's times, a recap's output channel). It was always
      // `{}`, so a Skill could declare config fields and never receive a value.
      // This instance's settings (SKILL-SEVERAL-INSTANCES); the first instance's when none is named.
      config: deps.skillConfig?.(run.agent, run.instance ?? skill) ?? {},
      // The tenant context the recap prompt needs — provided by the runtime, never held by the Skill.
      context: {
        mission: voice?.mission ?? "",
        journal: voice?.journal,
        vocab: voice?.vocab,
        timezone: voice?.timezone,
        calendarRoutes: voice?.calendarRoutes ?? {},
        // Who the run is on behalf of, for a Skill that addresses someone (the agenda brief).
        notifyUser: voice?.notifyUser,
      },
    };
    // The production image ships compiled `dist` and omits `tsx` and `src` (`npm ci --omit=dev`), so
    // `tsx src/…/index.ts` cannot run there. Prefer the compiled Skill (`node dist/…/index.js`), and
    // fall back to tsx on the TS source for local dev, which runs from a bind-mounted tree with no
    // build. `existsSync` is resolved against the worker's cwd, the same base the spawn uses.
    const distEntry = entry.replace(/^src[/\\]/, "dist/").replace(/\.ts$/, ".js");
    const compiled = existsSync(distEntry);
    // As the run's own Linux user when turns run as theirs: a Skill is started on an agent's behalf
    // too. When that user cannot be had the run fails, rather than go out as the worker.
    const runAs = deps.turnUser ? await deps.turnUser(run.agent, run.user) : undefined;
    const start = skillCommand(runAs, compiled ? "node" : "tsx", [compiled ? distEntry : entry], process.env, baseUrl, token);
    const grouped = !!ownGroup(runAs).detached;
    // Reserved before it starts and released exactly once, on a start that failed as on an exit.
    const hold = await runBegan(runAs);
    const release = hold.release;
    let child;
    try {
      child = spawn(start.cmd, start.args, { env: start.env, stdio: ["pipe", "pipe", "pipe"], ...ownGroup(runAs) });
    } catch (e) {
      release();
      throw e;
    }
    // A Skill's browser, or anything else it started, ends with the run.
    child.once("exit", release);
    child.once("error", release);
    hold.started(child.pid);
    // A spawn that never starts (the missing-`tsx` bug that crash-looped the cluster) emits 'error';
    // with no listener Node throws it uncaught and kills the whole worker. Capture it and turn it
    // into a failed outcome instead — one recording must never take the worker down.
    let spawnError: string | undefined;
    child.on("error", (e) => (spawnError = (e as Error).message));
    child.stdin.on("error", () => {}); // a dead child's stdin errors on write; swallow it
    const onAbort = (): void => stopAll(child, grouped);
    if (opts?.signal?.aborted) onAbort();
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
        else if (line.trim()) console.log(`skill:${run.agent}:${skill} ${line}`);
      }
    });

    const code = await new Promise<number>((resolve) => {
      child.on("close", (c) => resolve(c ?? 0));
      child.on("error", () => resolve(-1)); // spawn failed to start — 'close' may never fire
    });
    opts?.signal?.removeEventListener("abort", onAbort);

    if (spawnError) return { status: "failed", reason: `could not start skill ${skill}: ${spawnError}` };
    const trimmed = out.trim();
    if (!trimmed) {
      return { status: "failed", reason: `skill exited ${code} with no outcome — ${err.slice(-400)}` };
    }
    const outcome = JSON.parse(trimmed) as SkillOutcome;
    // Which brains this run filed into — the runtime's record, never the Skill's say-so — so the
    // announcement is delivered only where they may be read (BRAIN-PRIVATE-CONFIRMATIONS).
    const filed = filedIn.get(token);
    return filed?.length ? { ...outcome, brains: filed } : outcome;
  } finally {
    revoke(token);
    filedIn.delete(token);
  }
}

/** File a meeting's recap in the tenant's second brain — into a brain when brains decide where this
 *  skill files (BRAIN-SKILL-TARGET), else the voice flow's git checkout. The content is the caller's;
 *  the repo, push credential, journal and timezone are the runtime's. Shared by the Skill plane and
 *  the `tonoman meeting-recap file` tool, so a recap filed by a turn lands exactly where one filed by
 *  the Skill did. */
export async function publishRecap(
  deps: TurnDeps,
  voice: VoiceConfig,
  agent: string,
  user: string | undefined,
  skill: string,
  p: { rec: recap.Recording; recap: recap.Recap; transcript: string; candidates: CalEvent[]; by: string[] },
): Promise<{ ok: true; published: boolean; path: string; route?: string; brain?: string; brainId?: string } | { ok: false; status: number; error: string }> {
  const target = deps.skillBrain ? await deps.skillBrain.target(agent, user, skill) : undefined;
  if (target && "error" in target) return { ok: false, status: 403, error: `Nothing was filed: ${target.error}.` };
  if (target) {
    const filed = await publishRecapToBrain(deps.skillBrain!.store, target, {
      rec: p.rec,
      recap: p.recap,
      transcript: p.transcript,
      journal: voice.journal,
      candidates: p.candidates,
      by: p.by,
      timezone: voice.timezone,
      owner: user,
    });
    if (!filed.result.ok) return { ok: false, status: 502, error: `Nothing was filed in ${target.name}: ${filed.result.detail}.` };
    return { ok: true, published: filed.result.sha !== null, path: filed.page, route: filed.route, brain: target.name, brainId: target.id };
  }
  const published = await recap.publish(
    voice.brainDir,
    p.rec,
    p.recap,
    p.transcript,
    voice.pushUrl,
    voice.journal,
    p.candidates,
    p.by,
    voice.timezone,
    // WHOSE recap — the per-person account it came from; undefined on the shared path, so unchanged.
    user,
  );
  const route = recap.resolveRoute(voice.journal, p.recap?.route);
  // The same resolution `publish` used, re-run after the write — the page now carries this
  // recording's id, so it resolves to exactly where it landed, suffix and all.
  const where = await recap.pathsForUnique(voice.brainDir, voice.journal, p.rec, route, recap.recapSlugHint(p.recap ?? {}), p.recap?.meeting);
  return { ok: true, published, path: where.page, route };
}

export async function startCapabilityPlane(deps: TurnDeps): Promise<CapabilityPlane> {
  const tokens = new Map<string, RunToken>();
  const filedIn = new Map<string, string[]>();
  let baseUrl = "";
  const mint = (run: RunToken): string => {
    const token = randomBytes(24).toString("hex");
    tokens.set(token, run);
    return token;
  };
  const revoke = (token: string): void => void tokens.delete(token);
  const spawnSkill: CapabilityPlane["spawn"] = (run, opts) =>
    runSkillProcess(deps, baseUrl, mint, revoke, run, opts, filedIn);

  const server = http.createServer((req, res) => {
    void (async () => {
      const reply = (code: number, obj: unknown): void => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(obj));
      };

      const pathname = new URL(req.url ?? "/", "http://plane").pathname;

      // Dev harness: run a Skill end-to-end against this plane without the Temporal poll. Gated by
      // TONOMAN_SKILL_DEV so it never exists in a real deployment. This is the "develop locally"
      // path and the step-6 proof hook — it mints its own token, so it is the one route without one.
      if (process.env.TONOMAN_SKILL_DEV && req.method === "POST" && pathname === "/dev/run") {
        const b = await readJson(req);
        const outcome = await spawnSkill({
          agent: String(b.agent ?? ""),
          item: String(b.item ?? ""),
          user: b.user ? String(b.user) : undefined,
          skill: b.skill ? String(b.skill) : undefined,
        });
        return reply(200, outcome);
      }

      const auth = req.headers.authorization ?? "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      const run = tokens.get(token);
      if (!run || run.expiresAt < Date.now()) return reply(401, { error: "unauthorized" });

      const body = req.method === "POST" ? await readJson(req) : {};

      // What needs no recording flow comes first (SKILL-NEEDS-NO-RECORDINGS).
      try {
        // One page the Skill wrote, into the brain the run is pointed at (SKILL-FILES-A-PAGE).
        if (req.method === "POST" && pathname === "/cap/page") {
          const trouble = pagePathTrouble(String(body.path ?? ""));
          if (trouble) return reply(400, { error: trouble });
          const content = String(body.content ?? "");
          if (!content || content.length > 200_000) return reply(400, { error: "a page has something in it, and not more than a page's worth" });
          const target = deps.skillBrain ? await deps.skillBrain.target(run.agent, run.user, run.skill ?? "") : undefined;
          if (!target) return reply(409, { error: "Nothing was filed: this run has no brain to file into." });
          if ("error" in target) return reply(403, { error: `Nothing was filed: ${target.error}.` });
          const filed = await publishPageToBrain(deps.skillBrain!.store, target, { path: String(body.path), content, note: body.note ? String(body.note) : undefined });
          if (!filed.ok) return reply(502, { error: `Nothing was filed in ${target.name}: ${filed.detail}.` });
          filedIn.set(token, [...new Set([...(filedIn.get(token) ?? []), target.id])]);
          return reply(200, { filed: true, path: String(body.path), brain: target.name });
        }
        // What LOREALISTAR said about one drop, for the person this run is for — and nothing of their
        // login (DROPS-LOGIN-SEALED). Only ever that person's: the run's own user, not one it names.
        if (req.method === "POST" && pathname === "/cap/lorealistar-drop") {
          if (!run.user) return reply(400, { error: "a drop is somebody's: this run is for nobody" });
          const found = await deps.lorealistar?.drop(run.agent, run.user, String(body.id ?? ""));
          return reply(200, found ? { drop: found.drop, seen: found.seen } : {});
        }
      } catch (e) {
        return reply(500, { error: String((e as Error)?.message ?? e) });
      }

      const voice = deps.voice?.(run.agent);
      if (!voice) return reply(404, { error: `no voice configuration for ${run.agent}` });

      try {
        // transcribe: the Skill resolved the audio URL with its own credential; the plane fetches,
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
            deps.transcriptionMeter?.(run.agent, run.user),
          );
          return reply(200, out);
        }

        // infer: the reasoning runs on the AGENT'S OWN inference provider (the Claude Code harness /
        // its subscription), NOT a side model — a recap is the agent thinking about the meeting. The
        // prompt is the Skill's; the plane budgets the user message to a generous window (Claude is
        // large) and routes it through deps.infer. The Skill parses the returned text.
        if (req.method === "POST" && pathname === "/cap/infer") {
          if (!deps.infer) return reply(503, { error: "this runtime has no inference provider" });
          const text = await deps.infer(
            run.agent,
            {
              system: String(body.system ?? ""),
              user: recap.budgetTranscript(String(body.user ?? ""), 500_000),
            },
            // Whose item this is. The token names it, so a Skill cannot choose whose subscription pays.
            run.user,
          );
          return reply(200, { text });
        }

        // publish: file the artifact in the tenant's git-backed second brain. The Skill supplies the
        // content (rec, recap, transcript, candidates, by); the repo, push credential, journal and
        // timezone are the runtime's, resolved here. Returns where it landed so the Skill can report.
        if (req.method === "POST" && pathname === "/cap/publish") {
          const out = await publishRecap(deps, voice, run.agent, run.user, run.skill ?? "meeting-recap", {
            rec: body.rec as recap.Recording,
            recap: body.recap as recap.Recap,
            transcript: String(body.transcript ?? ""),
            candidates: (body.candidates as CalEvent[]) ?? [],
            by: (body.by as string[]) ?? [],
          });
          if (!out.ok) return reply(out.status, { error: out.error });
          if (out.brainId) filedIn.set(token, [...new Set([...(filedIn.get(token) ?? []), out.brainId])]);
          return reply(200, { published: out.published, path: out.path, route: out.route, ...(out.brain ? { brain: out.brain } : {}) });
        }

        // calendar candidates around a recording. TRANSITIONAL: calendar is a `requires` credential,
        // so the clean shape is the Skill fetching the feed itself via credential('calendar'). Until
        // the ICS parsing is ported into the Skill, the plane resolves candidates from the tenant's
        // configured feeds and applies the same padded window the live pipeline does.
        if (req.method === "POST" && pathname === "/cap/calendar-candidates") {
          if (!voice.calendars?.length) return reply(200, []);
          const w = calendar.windowFor(Number(body.from ?? 0), Number(body.to ?? 0), voice.calendarPadMinutes);
          const cands = await calendar.gather(voice.calendars, w.from, w.to, {
            exclude: voice.calendarExclude,
            google: deps.googleCalendar ? (f, a, b) => deps.googleCalendar!(run.agent, f, a, b) : undefined,
            log: (m: string) => console.log(m),
          });
          return reply(200, cands);
        }

        // calendar events: every entry in [from, to) across the agent's calendars, no padding — for a
        // Skill that reasons about a day (the agenda brief) rather than one recording.
        if (req.method === "POST" && pathname === "/cap/calendar-events") {
          if (!voice.calendars?.length) return reply(200, []);
          const events = await calendar.gather(voice.calendars, Number(body.from ?? 0), Number(body.to ?? 0), {
            exclude: voice.calendarExclude,
            google: deps.googleCalendar ? (f, a, b) => deps.googleCalendar!(run.agent, f, a, b) : undefined,
            log: (m: string) => console.log(m),
          });
          return reply(
            200,
            events.map((e) => ({ summary: e.summary, start: e.start, end: e.end, attendees: e.attendees, source: e.source })),
          );
        }

        // credential: a fresh, usable credential for a kind the Skill declared in `requires`. For
        // Plaud the plane resolves (and refreshes) the OAuth bearer from the tokenstore and hands the
        // Skill a ready {token, base} — so the Skill only needs the Plaud API, never the tokenstore,
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
    spawn: spawnSkill,
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
