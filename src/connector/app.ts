// The Tonoman app connector (channel-app): the third channel, peer to Telegram and Teams.
// It is what the Tonoman client applications (web / mobile / desktop) talk to — the
// "control panel" surface, as opposed to a consumer chat platform.
//
// Transport choice: SSE + POST, NOT WebSocket. Tonoman ships with ZERO runtime
// dependencies, and a spec-correct RFC-6455 server is ~150 lines of framing code we would
// then own forever. Server→client streaming is the only duplex need here, and that is
// exactly what Server-Sent Events are for: the browser gets progressive turn output over a
// long-lived GET, and client→server messages ride ordinary POSTs. It also traverses
// ingress-nginx cleanly (one `proxy_buffering off`) where WebSocket upgrade needs more.
//
//   GET  /api/agents                  → the roster this gateway serves
//   POST /api/media                   → upload a scan/receipt; returns its shared-mount path
//   POST /api/chat/{conv}/messages    → send a message (202; the turn runs async)
//   GET  /api/chat/{conv}/stream      → SSE: this conversation's live turn output
//   GET  /api/healthz                 → liveness, token-free
//
// Media is written to the SAME shared mount Telegram uses, so `Envelope.mediaPaths` carries
// it to the agent through the existing path with no harness or agent change: for a remote
// (k8s-split) agent httpRunner base64s the file over the wire (split-media-carried); for a
// co-located agent the container reads the mount directly. A scanned PDF is therefore
// indistinguishable, to the agent, from a photo sent over Telegram.
//
// See docs/scenarios/contracts/channel-app.md.

import { promises as fs } from "node:fs";
import * as http from "node:http";
import * as crypto from "node:crypto";
import * as path from "node:path";
import type { Connector, Envelope, Reply } from "../core/contracts";
import type { TokenVerifier, VerifiedClaims } from "../cloudauth";

/** Per-upload cap. Must stay at or below httpRunner's MAX_MEDIA_BYTES (20MB) — a file the
 * gateway accepts but the runner refuses to ship is a dead end the user can't diagnose. */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/** How often an idle SSE stream emits a comment line. Proxies (and iOS Safari on a
 * backgrounded tab) drop a connection that goes quiet; a comment is not an event, so the
 * client's parser ignores it while the socket stays warm. */
const SSE_KEEPALIVE_MS = 15_000;

export interface AppConnectorOptions {
  /** port for the app API listener (the gateway host process owns it). */
  port: number;
  /** host dir uploads land in — the host side of the agent's shared mount. */
  mediaDir: string;
  /** container-visible path for mediaDir. Defaults to mediaDir (same-filesystem case). */
  mediaMount?: string;
  /** the agent this gateway serves, for GET /api/agents. */
  agent: { name: string; role?: string };
  /** verifies the Bearer token minted by Tonoman Cloud. When absent the API is OPEN —
   * only ever acceptable for local development, and we log loudly at startup. */
  verifier?: TokenVerifier;
  /** browser origins allowed to call this API. The client is served from the cloud's
   * origin and talks to the gateway DIRECTLY (the cloud is a directory, not a relay), so
   * this is a genuine cross-origin call and needs a real allowlist. */
  allowedOrigins?: string[];
}

/** A message parked for `receive()` to yield. */
interface Inbound {
  conversation: string;
  user: string;
  text: string;
  mediaPaths: string[];
  claims?: VerifiedClaims;
}

/** One connected browser tab listening to a conversation. */
interface Subscriber {
  res: http.ServerResponse;
  conversation: string;
}

export class AppConnector implements Connector {
  private readonly inbox: Inbound[] = [];
  private wake: (() => void) | null = null;
  private readonly subs = new Set<Subscriber>();
  /** monotonic id for messages we tell the client to render/edit in place. */
  private seq = 0;
  /** the port actually bound — meaningful when options.port is 0 (tests, ephemeral). */
  public boundPort = 0;

  constructor(private readonly o: AppConnectorOptions) {}

  name(): string {
    return "app";
  }

  private mount(): string {
    return this.o.mediaMount || this.o.mediaDir;
  }

  // --- inbound -------------------------------------------------------------

  async *receive(signal: AbortSignal): AsyncIterable<Envelope> {
    await fs.mkdir(this.o.mediaDir, { recursive: true });
    const server = http.createServer((req, res) => void this.route(req, res));
    await new Promise<void>((resolve, reject) => {
      server.on("error", reject);
      server.listen(this.o.port, "0.0.0.0", () => {
        this.boundPort = (server.address() as { port: number }).port;
        resolve();
      });
    });
    if (!this.o.verifier) {
      console.warn("app: NO token verifier configured — the app API is UNAUTHENTICATED. Development only.");
    }
    console.log(`app: api on http://0.0.0.0:${this.o.port}/api (agent "${this.o.agent.name}")`);

    const keepalive = setInterval(() => {
      for (const s of this.subs) s.res.write(": keepalive\n\n");
    }, SSE_KEEPALIVE_MS);
    if (typeof keepalive.unref === "function") keepalive.unref();

    const closeAll = () => {
      clearInterval(keepalive);
      for (const s of this.subs) s.res.end();
      this.subs.clear();
      server.close();
      this.wake?.();
    };
    signal.addEventListener("abort", closeAll, { once: true });

    try {
      while (!signal.aborted) {
        const next = this.inbox.shift();
        if (!next) {
          await new Promise<void>((resolve) => (this.wake = resolve));
          this.wake = null;
          continue;
        }
        yield {
          channel: this.name(),
          conversation: next.conversation,
          user: next.user,
          // The cloud verified this email against its IdP (Google/Zitadel), so unlike a
          // Telegram display name it is NOT spoofable — the agent may treat it as fact.
          identity: next.claims
            ? { name: next.claims.name || next.claims.email || next.user, email: next.claims.email, verified: true }
            : undefined,
          text: next.text,
          mediaPaths: next.mediaPaths,
        };
      }
    } finally {
      closeAll();
    }
  }

  private push(m: Inbound): void {
    this.inbox.push(m);
    this.wake?.();
  }

  // --- outbound ------------------------------------------------------------

  reply(conversation: string): Reply {
    return new AppReply(this, conversation);
  }

  /** Fans one SSE event out to every tab watching `conversation`. Dead sockets are
   * dropped rather than retried — the client reconnects and replays from history. */
  emit(conversation: string, event: Record<string, unknown>): void {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const s of this.subs) {
      if (s.conversation !== conversation) continue;
      try {
        s.res.write(payload);
      } catch {
        this.subs.delete(s);
      }
    }
  }

  nextId(): string {
    return `m${++this.seq}`;
  }

  // --- HTTP ----------------------------------------------------------------

  private cors(req: http.IncomingMessage, res: http.ServerResponse): void {
    const origin = req.headers.origin;
    const allowed = this.o.allowedOrigins ?? [];
    if (origin && (allowed.includes(origin) || allowed.includes("*"))) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Headers", "authorization,content-type,x-filename");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
      res.setHeader("Access-Control-Max-Age", "86400");
    }
  }

  private async route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    this.cors(req, res);
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }
    const url = new URL(req.url || "/", "http://localhost");
    const p = url.pathname;

    if (p === "/api/healthz") {
      json(res, 200, { ok: true, agent: this.o.agent.name });
      return;
    }

    // Everything below is authenticated. The token is minted by Tonoman Cloud and scoped
    // to THIS gateway; we verify it against the cloud's JWKS (no shared secret, no user
    // database on the gateway — see docs/architecture.md §7).
    let claims: VerifiedClaims | undefined;
    if (this.o.verifier) {
      const tok = bearer(req);
      if (!tok) {
        json(res, 401, { error: "missing bearer token" });
        return;
      }
      try {
        claims = await this.o.verifier.verify(tok);
      } catch (e) {
        json(res, 401, { error: `invalid token: ${(e as Error).message}` });
        return;
      }
    }

    try {
      if (p === "/api/agents" && req.method === "GET") {
        json(res, 200, { agents: [{ name: this.o.agent.name, role: this.o.agent.role }] });
        return;
      }
      if (p === "/api/media" && req.method === "POST") {
        await this.uploadMedia(req, res);
        return;
      }
      const chat = /^\/api\/chat\/([^/]+)\/(messages|stream)$/.exec(p);
      if (chat) {
        const conv = decodeURIComponent(chat[1]);
        if (chat[2] === "messages" && req.method === "POST") {
          await this.postMessage(req, res, conv, claims);
          return;
        }
        if (chat[2] === "stream" && req.method === "GET") {
          this.openStream(req, res, conv);
          return;
        }
      }
      json(res, 404, { error: "not found" });
    } catch (e) {
      console.error(`app: ${req.method} ${p}: ${(e as Error).message}`);
      json(res, 500, { error: (e as Error).message });
    }
  }

  /** Accepts one file as a raw body (`x-filename` names it) and lands it on the shared
   * mount. Raw beats multipart here: multipart parsing is another dependency-shaped hole,
   * and the client is ours — it always sends exactly one file. */
  private async uploadMedia(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const raw = await readBody(req, MAX_UPLOAD_BYTES);
    if (raw === null) {
      json(res, 413, { error: `upload exceeds ${MAX_UPLOAD_BYTES} bytes` });
      return;
    }
    if (raw.length === 0) {
      json(res, 400, { error: "empty upload" });
      return;
    }
    const name = safeName(String(req.headers["x-filename"] || "scan.pdf"));
    // Prefix with a short random so two scans named scan.pdf never collide on the mount.
    const file = `${crypto.randomBytes(4).toString("hex")}-${name}`;
    await fs.writeFile(path.join(this.o.mediaDir, file), raw);
    console.log(`app: media ${file} (${raw.length} bytes)`);
    // The path the AGENT will see, which is the mount path — not our host path.
    json(res, 200, { path: `${this.mount()}/${file}`, bytes: raw.length });
  }

  private async postMessage(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    conversation: string,
    claims?: VerifiedClaims,
  ): Promise<void> {
    const raw = await readBody(req, 1024 * 1024);
    if (raw === null) {
      json(res, 413, { error: "message too large" });
      return;
    }
    let body: { text?: string; mediaPaths?: string[] };
    try {
      body = JSON.parse(raw.toString("utf8") || "{}");
    } catch {
      json(res, 400, { error: "bad json" });
      return;
    }
    const text = typeof body.text === "string" ? body.text : "";
    // Only accept paths we ourselves handed out from /api/media. Otherwise this field is a
    // read-anything primitive: the agent will Read whatever path it is given.
    const mediaPaths = (Array.isArray(body.mediaPaths) ? body.mediaPaths : []).filter((m) => this.ownsPath(m));
    if (!text.trim() && mediaPaths.length === 0) {
      json(res, 400, { error: "empty message" });
      return;
    }
    this.push({
      conversation,
      user: claims?.email || claims?.sub || "app-user",
      text,
      mediaPaths,
      claims,
    });
    json(res, 202, { accepted: true });
  }

  /** True when `p` is a file directly inside our media mount (no traversal, no nesting). */
  private ownsPath(p: unknown): boolean {
    if (typeof p !== "string") return false;
    const prefix = `${this.mount()}/`;
    if (!p.startsWith(prefix)) return false;
    const rest = p.slice(prefix.length);
    return rest.length > 0 && rest === safeName(rest);
  }

  private openStream(req: http.IncomingMessage, res: http.ServerResponse, conversation: string): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // ingress-nginx buffers proxied responses by default, which would hold the whole
      // turn back and deliver it as one lump at the end — the exact opposite of streaming.
      "X-Accel-Buffering": "no",
    });
    res.write(": connected\n\n");
    const sub: Subscriber = { res, conversation };
    this.subs.add(sub);
    req.on("close", () => this.subs.delete(sub));
  }
}

/** Streams one turn into the app over SSE. The client renders `message` as a new bubble
 * and `update` as an in-place edit of that bubble — the same progressive-edit fidelity
 * Telegram gets from editMessageText, so the shared streamer needs no app-specific path. */
class AppReply implements Reply {
  constructor(
    private readonly conn: AppConnector,
    private readonly conversation: string,
  ) {}

  async send(text: string): Promise<string> {
    const id = this.conn.nextId();
    this.conn.emit(this.conversation, { type: "message", id, text });
    return id;
  }

  async update(msgID: string, text: string): Promise<void> {
    this.conn.emit(this.conversation, { type: "update", id: msgID, text });
  }

  async finalize(msgID: string, text: string): Promise<void> {
    this.conn.emit(this.conversation, { type: "final", id: msgID, text });
  }

  canEdit(): boolean {
    return true;
  }

  async working(status?: string): Promise<void> {
    this.conn.emit(this.conversation, { type: "working", status });
  }

  async settle(): Promise<void> {
    this.conn.emit(this.conversation, { type: "settled" });
  }

  async note(id: string | undefined, text: string | null): Promise<string> {
    const nid = id ?? this.conn.nextId();
    this.conn.emit(this.conversation, { type: "note", id: nid, text });
    return nid;
  }
}

// --- helpers ---------------------------------------------------------------

function json(res: http.ServerResponse, code: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(s) });
  res.end(s);
}

function bearer(req: http.IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (!h || !h.toLowerCase().startsWith("bearer ")) return null;
  const t = h.slice(7).trim();
  return t || null;
}

/** Reads a request body, returning null if it exceeds `cap`. Counts bytes as they arrive
 * (not after buffering) so an oversized upload can't exhaust memory before we reject it. */
async function readBody(req: http.IncomingMessage, cap: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let dead = false;
    req.on("data", (c: Buffer) => {
      if (dead) return;
      total += c.length;
      if (total > cap) {
        dead = true;
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => !dead && resolve(Buffer.concat(chunks)));
    req.on("error", () => !dead && resolve(Buffer.alloc(0)));
  });
}

/** Reduces a client-supplied filename to a safe basename. Directory components are
 * stripped, not escaped — the client never has a say in WHERE a file lands. */
export function safeName(n: string): string {
  const base = n.split(/[\\/]/).pop() || "file";
  const clean = base.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_");
  return clean.slice(0, 100) || "file";
}
