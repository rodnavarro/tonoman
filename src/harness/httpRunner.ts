// The gateway-side turn-runner for a REMOTE agent (k8s split). It implements the same
// TurnRunner contract as the local claude-code Runner, but instead of `podman exec`-ing a
// co-located container it POSTs the turn to the agent runtime server (src/agent/server.ts)
// over HTTP and streams the NDJSON TurnEvents back. Because the gateway depends only on
// TurnRunner, this is a drop-in: Router / streamer / TurnQueue / connector are unchanged.
//
// Design notes (validated):
//  - The system prompt travels as CONTENT, not a path: the gateway holds the identity file,
//    the pod cannot see it. We read it here and ship it in the body (else the agent runs with
//    no persona, silently).
//  - model + maxTurns ride the body; `model` is a mutable field so `/model` takes effect on the
//    NEXT turn (an in-flight turn keeps the model it began with) — same semantics as local.
//  - Abort is intentional: on signal-abort we stop yielding and emit NO error (the Router
//    decides commit/discard). Every OTHER failure surfaces as exactly ONE terminal error event,
//    mirroring the local Runner so the streamer behaves identically.
//  - No idle-timeout dance / undici dispatcher needed: the server heartbeats a keepalive line
//    every ~15s, so the response body never goes idle long enough to trip fetch's body timeout.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { Spec, RunnerParams } from "../harness";
import type { TurnEvent, TurnRequest, TurnRunner } from "../core/contracts";
import { IMAGE, CONFIG_HOME, IDENTITY_HOME } from "./claudecode";
import type { BackendMode } from "./claudecode";

/** The harness key used in agent config for a remote (HTTP-driven) claude-code agent. */
export const KIND = "claude-code-http";

/** Per-file cap for inbound media shipped over the wire (split-media-carried). Receipts/cards are
 * a few MB; this bounds one turn's body. The runtime's readBody cap must exceed base64(this). */
export const MAX_MEDIA_BYTES = 20 * 1024 * 1024;

export interface HttpRunnerOptions {
  /** base URL of the agent runtime server, e.g. http://atlas-agent.prod-atlas.svc:8080 */
  url: string;
  model?: string;
  maxTurns?: number;
  /** initial auth backend (backend-*); the gateway flips it live via setBackend, effect next turn. */
  backend?: BackendMode;
  /** shared bearer token (AGENT_RUNTIME_TOKEN); sent as `Authorization: Bearer <token>`. */
  token?: string;
  /** injectable transport for tests; defaults to global fetch. */
  fetch?: typeof fetch;
}

function clip(s: string, n = 200): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n) + "…" : one;
}

/** Decode one NDJSON line into a normalized TurnEvent. `keepalive` lines → null (skipped);
 * the `error` kind's stringified message is rehydrated into an Error (mirror of encodeEvent). */
export function decodeEvent(line: string): TurnEvent | null {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(line);
  } catch {
    return null; // stray / partial line
  }
  if (!o || typeof o !== "object") return null;
  if (o.kind === "keepalive") return null;
  if (o.kind === "error") return { kind: "error", err: new Error(typeof o.err === "string" ? o.err : "remote error") };
  return o as unknown as TurnEvent;
}

/** Read a fetch Response body as NDJSON lines, tolerating chunk boundaries mid-line. */
async function* readNdjson(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim()) yield line;
    }
  }
  if (buf.trim()) yield buf;
}

export class HttpRunner implements TurnRunner {
  private model?: string;
  private backend?: BackendMode;
  constructor(private readonly o: HttpRunnerOptions) {
    if (!o.url) throw new Error("httpRunner: empty url");
    this.model = o.model;
    this.backend = o.backend;
  }

  getModel(): string | undefined {
    return this.model;
  }
  setModel(model: string | undefined): void {
    this.model = model; // effect next turn (snapshotted into the body at run() time)
  }
  /** Current auth backend (backend-switch-live). */
  getBackend(): BackendMode | undefined {
    return this.backend;
  }
  /** Switch the auth backend from the NEXT turn on (backend-switch-live) — snapshotted into the
   * /turn body at run() time, so an in-flight turn keeps the backend it began with. */
  setBackend(backend: BackendMode | undefined): void {
    this.backend = backend;
  }

  /** Injectable fetch (tests pass a fake); defaults to global fetch. */
  private get fetch(): typeof fetch {
    return (this.o as { fetch?: typeof fetch }).fetch ?? fetch;
  }

  /** Read each gateway-side media file and base64 it for the wire (split-media-carried). Keyed by
   * basename — the runtime writes it back under its own media dir at the same name, matching the
   * path the prompt already references. A missing/oversize file is skipped + logged (never-silent),
   * not fatal: the text turn still runs. */
  private async readMedia(paths: string[]): Promise<{ name: string; b64: string }[]> {
    const out: { name: string; b64: string }[] = [];
    for (const p of paths) {
      try {
        const buf = await fs.readFile(p);
        if (buf.length > MAX_MEDIA_BYTES) {
          console.error(`httpRunner: media ${p} is ${buf.length}B > ${MAX_MEDIA_BYTES}B cap — skipped`);
          continue;
        }
        out.push({ name: path.basename(p), b64: buf.toString("base64") });
      } catch (e) {
        console.error(`httpRunner: read media ${p}: ${(e as Error).message}`);
      }
    }
    return out;
  }

  async *run(req: TurnRequest, signal?: AbortSignal): AsyncIterable<TurnEvent> {
    // System prompt as CONTENT (the pod can't read a gateway-side path).
    let systemPrompt: string | undefined;
    if (req.systemPromptFile) {
      try {
        systemPrompt = await fs.readFile(req.systemPromptFile, "utf8");
      } catch (e) {
        yield { kind: "error", err: new Error(`httpRunner: read system prompt ${req.systemPromptFile}: ${(e as Error).message}`) };
        return;
      }
    }

    // Inbound media across the k8s split: the gateway and agent are SEPARATE containers with no
    // shared mount, so a file the connector downloaded is invisible to the agent by path alone.
    // Ship the bytes: read each gateway-side media file, base64 it, and carry it in the body.
    // The runtime re-materializes it at the SAME basename under its own media dir, so the path the
    // prompt already references (buildPrompt) resolves agent-side. (split-media-carried.)
    const media = await this.readMedia(req.mediaPaths ?? []);

    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.o.token) headers["authorization"] = `Bearer ${this.o.token}`;
    const body = JSON.stringify({
      prompt: req.prompt,
      systemPrompt,
      model: this.model,
      maxTurns: this.o.maxTurns,
      backend: this.backend, // snapshot the backend into the body (backend-switch-live)
      sessionId: req.sessionId,
      sessionNew: req.sessionNew,
      media: media.length ? media : undefined,
    });

    let res: Response;
    try {
      res = await this.fetch(`${this.o.url.replace(/\/$/, "")}/turn`, { method: "POST", headers, body, signal });
    } catch (e) {
      if (signal?.aborted) return; // intentional abort → no error event
      yield { kind: "error", err: new Error(`httpRunner: connect ${this.o.url}: ${(e as Error).message}`) };
      return;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      yield { kind: "error", err: new Error(`httpRunner: agent ${res.status} ${clip(text)}`) };
      return;
    }
    if (!res.body) {
      yield { kind: "error", err: new Error("httpRunner: agent returned no response body") };
      return;
    }

    let sawTerminal = false;
    try {
      for await (const line of readNdjson(res.body)) {
        const ev = decodeEvent(line);
        if (!ev) continue; // keepalive / stray
        if (ev.kind === "done" || ev.kind === "error") sawTerminal = true;
        yield ev;
      }
    } catch (e) {
      if (signal?.aborted) return; // aborted mid-stream → intentional, no error
      yield { kind: "error", err: new Error(`httpRunner: stream: ${(e as Error).message}`) };
      return;
    }
    // Stream ended cleanly but with no done/error line (e.g. the pod was killed) → one terminal
    // error so the router never hangs. An intentional abort already returned above.
    if (!sawTerminal && !signal?.aborted) {
      yield { kind: "error", err: new Error("httpRunner: stream ended with no result") };
    }
  }
}

/** The remote claude-code harness plug. Turn-driven like claude-code, but the runner reaches
 * the agent over HTTP. It deliberately omits the podman-local capabilities (ephemeral /btw,
 * in-sandbox login/status/logout, credFile) — those are gated off for remote agents in the
 * gateway; auth is a pod-side op and /btw has no remote path yet. */
export function spec(): Spec {
  return {
    kind: KIND,
    image: IMAGE, // parity for tooling that reads a harness image; remote lifecycle is k8s' job
    configHome: CONFIG_HOME,
    identityHome: IDENTITY_HOME,
    remote: true, // gateway skips podman lifecycle/broker; health probes HTTP (see gateway gating)
    newRunner: (p: RunnerParams) =>
      new HttpRunner({ url: p.url ?? "", model: p.model, maxTurns: p.maxTurns, backend: p.backend, token: process.env.AGENT_RUNTIME_TOKEN }),
  };
}
