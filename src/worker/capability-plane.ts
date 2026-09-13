import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import * as recap from "./recap";
import type { CalEvent } from "./calendar";
import { budgetFor } from "./inference";
import { accountFor, type TurnDeps } from "./activities";

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

export async function startCapabilityPlane(deps: TurnDeps): Promise<CapabilityPlane> {
  const tokens = new Map<string, RunToken>();

  const server = http.createServer((req, res) => {
    void (async () => {
      const reply = (code: number, obj: unknown): void => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(obj));
      };

      const auth = req.headers.authorization ?? "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      const run = tokens.get(token);
      if (!run || run.expiresAt < Date.now()) return reply(401, { error: "unauthorized" });

      const voice = deps.voice?.(run.agent);
      if (!voice) return reply(404, { error: `no voice configuration for ${run.agent}` });

      const pathname = new URL(req.url ?? "/", "http://plane").pathname;
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
            String(body.cacheId ?? run.item),
            voice.transcribe,
            typeof body.vocab === "string" ? body.vocab : voice.vocab,
            undefined,
            cacheDir,
          );
          return reply(200, out);
        }

        // infer: one JSON-mode completion through the tenant's SUMMARISE chain. The prompt is the
        // Talent's; the plane budgets the user message to the provider's window (the Talent does not
        // know the providers) and routes it. The Talent parses the returned text against its schema.
        if (req.method === "POST" && pathname === "/cap/infer") {
          const raw = await recap.inferJson(
            voice.summarize,
            String(body.system ?? ""),
            recap.budgetTranscript(String(body.user ?? ""), budgetFor(voice.summarize)),
          );
          return reply(200, { text: raw });
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
          );
          const route = recap.resolveRoute(voice.journal, r?.route);
          const where = recap.pathsFor(voice.journal, rec, route, r?.highlights?.[0] ?? r?.summary);
          return reply(200, { published, path: where.page, route });
        }

        // credential: a fresh, usable credential for a kind the Talent declared in `requires`. Plaud
        // is resolved per run (the member's own account when per-person, else the shared one), so the
        // Talent can re-fetch across a long run rather than hold a token that expires under it.
        if (req.method === "GET" && pathname.startsWith("/cap/credential/")) {
          const kind = decodeURIComponent(pathname.slice("/cap/credential/".length));
          if (kind === "plaud") return reply(200, { creds: accountFor(voice, run.user).creds });
          return reply(404, { error: `no credential of kind ${kind}` });
        }

        return reply(404, { error: "no such capability" });
      } catch (e) {
        return reply(500, { error: String((e as Error)?.message ?? e) });
      }
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    mint(run) {
      const token = randomBytes(24).toString("hex");
      // Generous but bounded: long enough for a 112-minute transcription, gone when the child exits.
      tokens.set(token, { ...run, expiresAt: Date.now() + 6 * 60 * 60 * 1000 });
      return token;
    },
    revoke(token) {
      tokens.delete(token);
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
