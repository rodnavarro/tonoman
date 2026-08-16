// The Microsoft Teams connector (A1, channel-teams): the second channel, peer to
// Telegram. Unlike Telegram's getUpdates long-poll, Bot Framework PUSHES activities
// to a webhook (POST /api/messages), so receive() runs a small HTTP listener IN THE
// GATEWAY HOST PROCESS (not the container) and bridges each inbound activity into the
// neutral Envelope stream. Outbound replies POST activities back to the captured
// serviceUrl with the bot's client-credentials token. Replies stream live via the
// Teams `streaminfo` protocol (TeamsReply) for personal chats. The router/harness
// never see any of this — they speak only core/contracts.
//
// References: hermes' Teams adapter (typing-refresh, single-final send, bot-token
// mint/cache, conversationReference capture) and openclaw's @openclaw/msteams (inbound
// JWKS JWT validation, the streaminfo streaming protocol). See
// docs/scenarios/contracts/channel-teams.md.

import { promises as fs } from "node:fs";
import * as http from "node:http";
import * as crypto from "node:crypto";
import * as path from "node:path";
import type { Connector, Envelope, Reply } from "../core/contracts";
import { Roster, resolveIdentity, refusalNotice } from "../identity";
import { ConvStore } from "./convstore";

/** Bot Framework hosts we will send a bearer token to (SSRF guard, teams-outbound-token). */
const DEFAULT_SERVICE_HOSTS = ["smba.trafficmanager.net", "smba.infra.gov.teams.microsoft.us"];
/** OpenID metadata for the Bot Framework (Azure public cloud) — yields the JWKS uri. */
const BF_OPENID_CONFIG = "https://login.botframework.com/v1/.well-known/openidconfiguration";
/** Past this many ms of streaming, stop emitting chunks; finalize delivers the whole
 * answer (teams-stream-fallback — openclaw's 45s guardrail). */
const DEFAULT_MAX_STREAM_AGE_MS = 90_000;
/** During a post-text idle gap (a long tool runs between streamed chunks), re-emit a streaming
 * keepalive on the heartbeat if the last stream activity is older than this — so Teams' typing
 * indicator + "stop" control stay live instead of freezing (teams-stream-keepalive). Kept just under
 * the 4s heartbeat so a quiet tick always refreshes, but a tick right after a real chunk doesn't double-post. */
const STREAM_KEEPALIVE_MS = 2_500;
/** A "message"-cue status trace only appears once a turn has run this long — so a quick reply
 * never flashes a status message (teams-working-status). */
const STATUS_DELAY_MS = 4_000;
/** Render the status trace as a subtle gray Adaptive Card (the gray look needs a card — markdown
 * can't color text). Flip to false for a plain italic line (markdown, no gray box) — the one-flag
 * fallback if the card's box reads too heavy in the Teams client. */
const STATUS_TRACE_AS_CARD = true;

/** A whimsical "thinking" verb à la Claude's "Cogitating…/Thought for…" — shown gerund while the
 * turn runs, past-tense in the settled trace. Stored as explicit forms (no fragile -ing/-ed rules). */
export interface MysticVerb {
  ing: string; // present (active): "Cogitating"
  ed: string; // past (settled): "Cogitated"
}
const MYSTIC_VERBS: MysticVerb[] = [
  { ing: "Cogitating", ed: "Cogitated" },
  { ing: "Ruminating", ed: "Ruminated" },
  { ing: "Pondering", ed: "Pondered" },
  { ing: "Percolating", ed: "Percolated" },
  { ing: "Marinating", ed: "Marinated" },
  { ing: "Moonwalking", ed: "Moonwalked" },
  { ing: "Noodling", ed: "Noodled" },
  { ing: "Conjuring", ed: "Conjured" },
  { ing: "Finagling", ed: "Finagled" },
  { ing: "Wrangling", ed: "Wrangled" },
  { ing: "Mulling", ed: "Mulled" },
  { ing: "Ideating", ed: "Ideated" },
  { ing: "Tinkering", ed: "Tinkered" },
  { ing: "Vibing", ed: "Vibed" },
  { ing: "Scheming", ed: "Schemed" },
];
function randomMysticVerb(): MysticVerb {
  return MYSTIC_VERBS[Math.floor(Math.random() * MYSTIC_VERBS.length)];
}

export interface ConnectorOptions {
  appId: string; // the bot's Entra app (client) id — also the inbound token audience
  appPassword: string; // the bot's client secret
  tenantId: string; // Entra tenant for the client-credentials token
  allowedUser?: string; // allow-list: sender AAD object id; empty = accept all
  roster?: Roster; // email→person roster (identity-roster); recognize senders by verified email
  restrictToRoster?: boolean; // only roster emails may use the bot; others get a deterministic refusal
  mediaDir?: string; // host dir to download attachments into
  mediaMount?: string; // container-visible path for mediaDir
  port?: number; // webhook listen port; default 3978
  serviceHosts?: string[]; // serviceUrl host allow-list; default DEFAULT_SERVICE_HOSTS
  loginBase?: string; // token authority; default https://login.microsoftonline.com
  maxStreamAgeMs?: number; // stop re-emitting streaming updates past this age (stay under Teams' ~2min limit); default 90s
  workingCue?: "message" | "card"; // liveness-cue style (teams-working-informative); default "message"
  fetchImpl?: typeof fetch; // injectable for tests
  now?: () => number; // injectable clock (ms)
  pickVerb?: () => MysticVerb; // injectable mystic-verb picker (tests); default random
  // Injectable inbound-token validator (teams-inbound-auth). Defaults to a real
  // Bot Framework JWKS/RS256 validator; tests pass a fake.
  validateToken?: (authHeader: string | undefined) => Promise<boolean>;
  // Where conversationReferences are kept. Supply a file-backed store and the
  // agent can still message first after a restart; omit it and refs live only
  // in memory, which is fine for tests and silently fatal in production.
  convStore?: ConvStore<ConvRef>;
}

/** What we capture from an inbound activity to address a reply later
 * (teams-conversation-reference). */
export interface ConvRef {
  serviceUrl: string;
  conversationId: string;
  conversationType: string; // "personal" | "groupChat" | "channel"
  fromId: string;
  fromAad: string;
  botId: string;
  channelId: string;
  tenantId: string;
}

export class TeamsConnector implements Connector {
  private tokenCache?: { value: string; exp: number };
  private readonly refs: ConvStore<ConvRef>;
  private readonly emailCache = new Map<string, { value: string; exp: number }>(); // fromId → resolved email
  private readonly validate: (authHeader: string | undefined) => Promise<boolean>;

  constructor(private readonly o: ConnectorOptions) {
    if (!o.appId || !o.appPassword || !o.tenantId) throw new Error("teams: appId/appPassword/tenantId required");
    this.refs = o.convStore ?? new ConvStore<ConvRef>();
    this.validate =
      o.validateToken ?? createBotFrameworkJwtValidator({ appId: o.appId, fetchImpl: o.fetchImpl, now: o.now });
  }

  name(): string {
    return "teams";
  }

  private now(): number {
    return (this.o.now ?? Date.now)();
  }
  private fetch(): typeof fetch {
    return this.o.fetchImpl ?? fetch;
  }
  private hosts(): string[] {
    return this.o.serviceHosts ?? DEFAULT_SERVICE_HOSTS;
  }

  /** Webhook listener (teams-webhook-listener): a small HTTP server in the gateway host
   * process. Each POST /api/messages is JWT-validated (teams-inbound-auth), ACK'd 200, and
   * its normalized envelope pushed into the iterable the gateway's inbound loop drains. */
  async *receive(signal: AbortSignal): AsyncIterable<Envelope> {
    // Default 3979 (NOT 3978) so a tonoman-native Teams agent can run on the same host as a
    // billing-style hermes service agent, which publishes 3978 (RUNBOOK §6).
    const port = this.o.port ?? 3979;
    const queue: Envelope[] = [];
    let wake: (() => void) | undefined;
    const push = (e: Envelope) => {
      queue.push(e);
      wake?.();
    };

    const server = http.createServer((req, res) => {
      void this.onRequest(req, res, push);
    });
    server.on("error", (e) => console.error(`teams: webhook server: ${(e as Error).message}`));
    server.listen(port, () => console.log(`teams: webhook listening on :${port}/api/messages`));

    // Fail-loud config check: mint a bot token at boot so an outbound-auth misconfig (bad
    // secret, missing service principal → AADSTS7000229) surfaces in the log at `tonoman up`
    // — not as a silent no-reply on the first message. botToken() logs the detail on failure.
    void this.botToken()
      .then(() => console.log("teams: bot token OK — outbound auth ready"))
      .catch(() => {
        /* botToken already logged the actionable cause */
      });

    const close = () => server.close();
    signal.addEventListener("abort", close, { once: true });
    try {
      while (!signal.aborted) {
        while (queue.length) yield queue.shift()!;
        await new Promise<void>((resolve) => {
          wake = resolve;
          const onAbort = () => resolve();
          signal.addEventListener("abort", onAbort, { once: true });
        });
      }
    } finally {
      signal.removeEventListener("abort", close);
      server.close();
    }
  }

  /** Handles one webhook request: read JSON, validate the BF token, normalize, ACK. The
   * HTTP plumbing is thin; the routing logic is in validate()/normalize() (both unit-tested
   * without a socket). */
  private async onRequest(req: http.IncomingMessage, res: http.ServerResponse, push: (e: Envelope) => void): Promise<void> {
    if (req.method !== "POST" || !(req.url ?? "").startsWith("/api/messages")) {
      res.writeHead(req.method === "GET" ? 405 : 404).end();
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const ok = await this.validate(req.headers["authorization"] as string | undefined);
        if (!ok) {
          res.writeHead(401).end();
          return;
        }
        const activity = JSON.parse(body || "{}");
        res.writeHead(200).end(); // ACK immediately — the reply is delivered async to serviceUrl
        const env = await this.normalize(activity);
        if (env) push(env);
      } catch (e) {
        if (!res.headersSent) res.writeHead(200).end();
        console.error(`teams: inbound: ${(e as Error).message}`);
      }
    });
  }

  /** Turns a Bot Framework "message" activity into a neutral envelope, applying the
   * allow-list, capturing the conversationReference, and downloading any attachment. */
  async normalize(activity: TeamsActivity): Promise<Envelope | null> {
    if (activity?.type !== "message") return null; // ignore typing/conversationUpdate/etc.
    const ref = this.captureRef(activity);
    if (!ref) return null;
    if (this.o.allowedUser && this.o.allowedUser !== ref.fromAad && this.o.allowedUser !== ref.fromId) {
      return null; // teams-allowlist
    }
    const displayName = activity.from?.name || ref.fromAad || ref.fromId;
    // identity-roster: resolve the sender's EMAIL from Teams and match it against the mounted roster,
    // so recognition is keyed on a verified address, not a spoofable display name.
    const email = await this.resolveEmail(ref); // undefined if unresolvable (non-fatal)
    const identity = resolveIdentity(this.o.roster, email, displayName);
    // A verified email is the most durable way to name this person, so it joins
    // the store's aliases — that is what lets a caller wake "rod@example.com"
    // or just "rod" without knowing anything about Teams.
    if (email) this.refs.put(ref.conversationId, ref, [email, email.split("@")[0]]);
    if (this.o.restrictToRoster && !identity.verified) {
      // Deterministic refusal (identity-roster-restrict): no turn, no LLM, but never silent.
      try {
        await this.sendNotice(ref, refusalNotice(email));
      } catch (e) {
        console.error(`teams: failed to send roster refusal: ${(e as Error).message}`);
      }
      return null;
    }
    const env: Envelope = {
      channel: this.name(),
      conversation: ref.conversationId,
      user: displayName,
      identity,
      text: stripMentions(activity.text || ""),
      mediaPaths: [],
    };
    for (const att of activity.attachments ?? []) {
      const d = resolveAttachment(att, this.o.serviceHosts ?? DEFAULT_SERVICE_HOSTS);
      if (!d) continue;
      try {
        env.mediaPaths.push(await this.downloadAttachment(d.url, d.name, d.auth));
      } catch (e) {
        // Non-fatal (the text turn still runs), but NEVER silent — a swallowed download is
        // exactly the "the agent says it sees nothing" bug. Log it for the operator.
        console.error(`teams: attachment download failed (${att.contentType ?? "?"}): ${(e as Error).message}`);
      }
    }
    return env;
  }

  /** Captures + stores the conversationReference for a conversation (teams-conversation-reference). */
  captureRef(activity: TeamsActivity): ConvRef | null {
    const conv = activity.conversation;
    const serviceUrl = activity.serviceUrl;
    if (!conv?.id || !serviceUrl) return null;
    const ref: ConvRef = {
      serviceUrl: serviceUrl.endsWith("/") ? serviceUrl : serviceUrl + "/",
      conversationId: conv.id,
      conversationType: conv.conversationType || "personal",
      fromId: activity.from?.id || "",
      fromAad: activity.from?.aadObjectId || "",
      botId: activity.recipient?.id || "",
      channelId: activity.channelId || "msteams",
      tenantId: conv.tenantId || activity.channelData?.tenant?.id || this.o.tenantId,
    };
    // Store every name this person answers to, so a caller can address them as
    // a person rather than carrying an opaque Teams conversation id.
    this.refs.put(ref.conversationId, ref, [
      ref.fromAad,
      ref.fromId,
      activity.from?.name ?? "",
      (activity.from?.name ?? "").split(" ")[0],
    ]);
    return ref;
  }

  reply(conversation: string): Reply {
    const ref = this.refs.get(conversation);
    return new TeamsReply(this, ref, {
      maxStreamAgeMs: this.o.maxStreamAgeMs ?? DEFAULT_MAX_STREAM_AGE_MS,
      cue: this.o.workingCue ?? "message",
      now: () => this.now(),
      pickVerb: this.o.pickVerb,
    });
  }

  registerCommands(): Promise<void> {
    // Teams has no runtime command-menu API (commands are declared in the app manifest's
    // commandLists). Nothing to register at runtime — best-effort no-op.
    return Promise.resolve();
  }

  // --- outbound transport ----------------------------------------------------

  /** Mints + caches the bot's client-credentials token (teams-outbound-token), refreshed
   * ~1 min early. */
  async botToken(): Promise<string> {
    const cached = this.tokenCache;
    if (cached && cached.exp > this.now()) return cached.value;
    const base = this.o.loginBase ?? "https://login.microsoftonline.com";
    const resp = await this.fetch()(`${base}/${this.o.tenantId}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: this.o.appId,
        client_secret: this.o.appPassword,
        scope: "https://api.botframework.com/.default",
      }).toString(),
    });
    const j = (await resp.json()) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
    if (!j.access_token) {
      // Surface the cause LOUDLY (the stream consumer swallows reply errors for turn-safety,
      // so without this an outbound-auth misconfig is a silent no-reply). AADSTS7000229 =
      // the app has no service principal in the tenant (`az ad sp create --id <appId>`).
      const detail = j.error_description?.split(/[\r\n.]/)[0] || j.error || `HTTP ${resp.status}`;
      console.error(
        `teams: BOT TOKEN MINT FAILED — ${detail}. Check the bot app's client secret and that its ` +
          `service principal exists in the tenant (az ad sp create --id <appId>; AADSTS7000229 = missing SP).`,
      );
      throw new Error(`teams: token mint failed (${j.error ?? resp.status})`);
    }
    this.tokenCache = { value: j.access_token, exp: this.now() + Math.max(60, (j.expires_in ?? 3600) - 60) * 1000 };
    return j.access_token;
  }

  /** POSTs a new activity to {serviceUrl}v3/conversations/{id}/activities. Returns the created
   * activity id (used as the streamId, or to later update/delete a status message). */
  async postActivity(ref: ConvRef, activity: Record<string, unknown>): Promise<string> {
    return this.activityRequest("POST", ref, "", activity);
  }

  /** PUTs (edits) an existing activity in place — used to update the mid-turn status message. */
  async updateActivity(ref: ConvRef, activityId: string, activity: Record<string, unknown>): Promise<string> {
    return this.activityRequest("PUT", ref, activityId, activity);
  }

  /** DELETEs an activity — used to remove the status message once the reply has finalized. */
  async deleteActivity(ref: ConvRef, activityId: string): Promise<void> {
    await this.activityRequest("DELETE", ref, activityId);
  }

  /** Shared Bot Framework activity REST call. Validates the serviceUrl host (SSRF), attaches the
   * bot bearer, retries transient failures + honors Retry-After, and logs any failed outbound
   * (else it vanishes into the consumer's turn-safety swallow). POST/PUT carry the activity body;
   * DELETE has none. Returns the activity id from the response (POST/PUT), or "". */
  private async activityRequest(method: "POST" | "PUT" | "DELETE", ref: ConvRef, activityId: string, activity?: Record<string, unknown>): Promise<string> {
    const host = hostOf(ref.serviceUrl);
    if (!host || !this.hosts().includes(host)) throw new Error(`teams: serviceUrl host not allowed: ${host}`);
    let url = `${ref.serviceUrl}v3/conversations/${encodeURIComponent(ref.conversationId)}/activities`;
    if (activityId) url += `/${encodeURIComponent(activityId)}`;
    const payload = activity
      ? {
          ...activity,
          from: { id: ref.botId },
          recipient: { id: ref.fromId },
          conversation: { id: ref.conversationId },
          channelData: { tenant: { id: ref.tenantId } }, // proactive sends 403 without the tenant
        }
      : undefined;
    const maxAttempts = 3;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const token = await this.botToken();
        const resp = await this.fetch()(url, {
          method,
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          ...(payload ? { body: JSON.stringify(payload) } : {}),
        });
        if (resp.status === 429 || resp.status >= 500) {
          const ra = Number(resp.headers.get("Retry-After")) || attempt;
          if (attempt === maxAttempts) throw new Error(`teams: ${method} ${resp.status}`);
          await delay(Math.min(10_000, ra * 1000 || 250 * attempt));
          continue;
        }
        if (!resp.ok) {
          const body = await resp.text().catch(() => "");
          const hint =
            resp.status === 401 || resp.status === 403
              ? " — bot not authorized to reply (check app credential + service principal, and that the bot is in the conversation)"
              : "";
          console.error(`teams: OUTBOUND ${resp.status} ${method} ${String(activity?.type ?? "activity")} to ${host}${hint} ${body.slice(0, 200)}`);
          throw new Error(`teams: ${method} failed ${resp.status}`);
        }
        const j = (await resp.json().catch(() => ({}))) as { id?: string };
        return j.id ?? "";
      } catch (e) {
        lastErr = e;
        if (!(e instanceof TypeError) || attempt === maxAttempts) throw e; // only transport blips retry
        await delay(250 * attempt);
      }
    }
    throw lastErr;
  }

  /** Resolves the sender's email via the Teams members roster API (identity-email-resolve), reusing
   * the bot token. Cached per fromId for 10 min (identity-email-cached). Non-fatal: any failure
   * returns undefined so the turn still runs (identity-email-nonfatal). Skipped entirely when no
   * roster is configured (nothing to match against). */
  private async resolveEmail(ref: ConvRef): Promise<string | undefined> {
    if (!this.o.roster) return undefined;
    if (!ref.fromId) return undefined;
    const cached = this.emailCache.get(ref.fromId);
    if (cached && cached.exp > this.now()) return cached.value || undefined;
    const host = hostOf(ref.serviceUrl);
    if (!host || !this.hosts().includes(host)) return undefined; // SSRF guard, same as outbound
    try {
      const url = `${ref.serviceUrl}v3/conversations/${encodeURIComponent(ref.conversationId)}/members/${encodeURIComponent(ref.fromId)}`;
      const token = await this.botToken();
      const resp = await this.fetch()(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!resp.ok) {
        console.error(`teams: member lookup ${resp.status} for identity resolution`);
        return undefined;
      }
      const m = (await resp.json().catch(() => ({}))) as { email?: string; userPrincipalName?: string };
      const email = (m.email || m.userPrincipalName || "").trim();
      this.emailCache.set(ref.fromId, { value: email, exp: this.now() + 10 * 60 * 1000 });
      return email || undefined;
    } catch (e) {
      console.error(`teams: member lookup failed for identity resolution: ${(e as Error).message}`);
      return undefined;
    }
  }

  /** Posts a plain, one-off message activity (no streaming) — used for the deterministic roster
   * refusal (identity-roster-restrict). */
  private async sendNotice(ref: ConvRef, text: string): Promise<void> {
    await this.activityRequest("POST", ref, "", { type: "message", text });
  }

  private async downloadAttachment(url: string, name: string | undefined, auth: boolean): Promise<string> {
    if (!this.o.mediaDir) throw new Error("teams: no mediaDir configured");
    // Only inline Bot Framework images get the bot token; a file.download.info downloadUrl is
    // pre-authenticated and must be fetched WITHOUT it (teams-media-inbound).
    const headers: Record<string, string> = auth ? { Authorization: `Bearer ${await this.botToken()}` } : {};
    const resp = await this.fetch()(url, { headers });
    if (!resp.ok) throw new Error(`teams: attachment ${resp.status}`);
    await fs.mkdir(this.o.mediaDir, { recursive: true });
    const buf = Buffer.from(await resp.arrayBuffer());
    // Name the file by what it ACTUALLY is: sniff the magic bytes first (authoritative), then a
    // TRUSTED extension from the supplied name (bogus ones like ".net" from a URL host are rejected),
    // else ".bin". This is what `claude`'s Read keys on to treat it as an image/PDF vs. text.
    const nameExt = path.extname(name || "").toLowerCase();
    const ext = sniffExtension(buf) || (KNOWN_MEDIA_EXT.has(nameExt) ? nameExt : "") || ".bin";
    const file = `${crypto.randomUUID()}${ext}`;
    await fs.writeFile(path.join(this.o.mediaDir, file), buf);
    return this.o.mediaMount ? `${this.o.mediaMount}/${file}` : path.join(this.o.mediaDir, file);
  }
}

/** Streams a reply over the Teams `streaminfo` protocol (teams-stream-progressive):
 * first chunk → typing+streaminfo(streaming, seq1) capturing the streamId; subsequent →
 * typing+streaminfo(streaming, seq++) with the grown prefix; finalize → message+streaminfo
 * (final), always sent to close the stream. For a group/channel conversation canEdit()=false
 * so the consumer block-sends (teams-stream-fallback). */
class TeamsReply implements Reply {
  private streamId = "";
  private streamStarted = false; // any streaminfo activity (informative OR streaming) sent → stream exists, finalize must close it
  private textStarted = false; // a real text/streaming chunk sent → working() stops (chunks carry liveness)
  private finalized = false;
  private streamCapped = false; // past the age cap: STOP re-emitting streaming updates (stay under Teams' limit), switch to a plain typing bubble. No partial is posted — finalize delivers ONE message (teams-stream-keepalive).
  private lastText = ""; // last text streamed via send()/update() — used to close cleanly on reset()/cap
  private seq = 0; // monotonic across informative + streaming activities (Teams requires increasing streamSequence)
  private streamStart = 0; // set at the first TEXT chunk — the age cap measures streaming, not the working cue
  private lastStreamAt = 0; // clock of the last streaming/keepalive post — the heartbeat keepalive throttles on it
  private workingStart = -1; // -1 = unset (0 is a valid clock value, so don't use it as the sentinel)
  private lastWorkingLabel = "";
  private lastTool = ""; // the most recent tool line (🔧 …), persisted so it coexists with the ticking cue
  private statusMsgId = ""; // the separate status trace (working_cue: "message")
  private verb?: MysticVerb; // the turn's mystic verb (picked once, lazily)
  // working() is fired-and-forgotten from TWO places at once (the router's ~4s heartbeat AND each
  // tool-narration event). Without serialization, two calls both see statusMsgId==="" before the
  // first postActivity resolves and BOTH post a status trace — the second is tracked+settled, the
  // first orphaned as a dangling "…ing…". opChain serializes every working()/settle() so exactly
  // one trace is created; `settled` latches it so a late heartbeat can't resurrect one post-settle.
  private opChain: Promise<void> = Promise.resolve();
  private settled = false;
  constructor(
    private readonly c: TeamsConnector,
    private readonly ref: ConvRef | undefined,
    private readonly opts: { maxStreamAgeMs: number; cue: "message" | "card"; now: () => number; pickVerb?: () => MysticVerb },
  ) {}

  /** Progressive streaming only for personal (1:1) chats (teams-stream-progressive);
   * a group/channel block-sends (teams-stream-fallback). */
  canEdit(): boolean {
    return this.ref?.conversationType === "personal";
  }

  /** The consumer calls send() in two roles: the FIRST streaming chunk (personal — may CONTINUE
   * a stream the working() informative cue already opened), or a plain block/extra message (group
   * chat, or a chunk after finalize). We disambiguate so a block/extra send is always a real
   * `message`, never a stray streaming typing activity that would never finalize. */
  async send(text: string): Promise<string> {
    if (!this.ref) return "";
    if (!this.canEdit() || this.finalized || this.textStarted) {
      return this.c.postActivity(this.ref, { type: "message", text, textFormat: "markdown" });
    }
    this.textStarted = true;
    this.streamStarted = true;
    this.streamStart = this.opts.now();
    this.lastStreamAt = this.streamStart;
    this.lastText = text;
    this.seq += 1; // continues the working() informative stream if one was opened (else starts at 1)
    const id = await this.c.postActivity(this.ref, {
      type: "typing",
      text,
      entities: [streamInfo("streaming", this.streamId || undefined, this.seq)],
    });
    if (!this.streamId) this.streamId = id || "";
    return this.streamId || "stream";
  }

  async update(_msgID: string, text: string): Promise<void> {
    if (!this.ref || !this.textStarted || this.finalized) return;
    this.lastText = text; // always keep the freshest prefix — finalize delivers the full answer from it
    if (this.streamCapped) return; // past the cap: stop streaming; liveness rides the typing bubble + status trace
    if (this.opts.now() - this.streamStart > this.opts.maxStreamAgeMs) {
      // Past the age cap: STOP re-emitting streaming updates so we stay under Teams' ~2min limit. We do NOT
      // post a partial (a streamed-final message has no editable id, so it can't be grown — that split a
      // long answer into a frozen partial + a duplicate full). The transient preview simply stops growing;
      // finalize delivers ONE message. Liveness continues via the typing bubble (teams-stream-keepalive).
      this.streamCapped = true;
      return;
    }
    this.seq += 1;
    this.lastStreamAt = this.opts.now();
    await this.c.postActivity(this.ref, {
      type: "typing",
      text,
      entities: [streamInfo("streaming", this.streamId || undefined, this.seq)],
    });
  }

  /** The universal closer: always delivers a final `message` (so the answer ALWAYS lands).
   * If a stream is open it closes it with a streaminfo-`final`; if that POST is rejected
   * (protocol mismatch / stale stream) it falls back to a PLAIN message — openclaw's
   * graceful degradation, so a wrong streaminfo guess can never leave the bot mute. */
  async finalize(_msgID: string, text: string): Promise<void> {
    if (!this.ref) return;
    this.finalized = true;
    try {
      if (this.streamStarted) {
        try {
          await this.c.postActivity(this.ref, {
            type: "message",
            text,
            textFormat: "markdown",
            entities: [streamInfo("final", this.streamId || undefined)],
          });
          console.log(`teams: stream finalized — ${text.length} chars (streamId ${this.streamId || "none"})`);
          return;
        } catch {
          /* streaminfo close failed → fall through to a plain message so the answer still lands */
        }
      }
      await this.c.postActivity(this.ref, { type: "message", text, textFormat: "markdown" });
      console.log(`teams: delivered ${text.length} chars as a plain message`);
    } finally {
      await this.settle(); // settle the status trace (working_cue: "message") to a final footer; the reply stays
    }
  }

  /** Close any in-flight stream + reset the streaming cursors so the NEXT send() opens a FRESH
   * stream (teams-stream-reset). The gateway calls this before re-running a turn on the same reply
   * (the resume-miss self-heal): a second stream continuing the first would 403 (ContentStreamNotAllowed).
   * Best-effort — if a stream was open it's closed with a streaminfo-`final` carrying the last streamed
   * text so it never hangs. The status trace (verb/statusMsgId) is left intact so the working cue
   * continues across the retry. */
  async reset(): Promise<void> {
    if (!this.ref) return;
    if (this.streamStarted && !this.finalized) {
      try {
        await this.c.postActivity(this.ref, {
          type: "message",
          text: this.lastText || "…",
          textFormat: "markdown",
          entities: [streamInfo("final", this.streamId || undefined)],
        });
      } catch {
        /* best-effort close */
      }
    }
    this.streamId = "";
    this.streamStarted = false;
    this.textStarted = false;
    this.finalized = false;
    this.streamCapped = false;
    this.seq = 0;
    this.streamStart = 0;
    this.lastText = "";
  }

  /** Post / edit / remove a STANDALONE plain message (a status notice like the queue footer),
   * addressed by id and free of the streaminfo stream state — so the gateway can drive it across
   * reply instances (teams-notice). This honors the contract's stateless send/edit-by-id semantics
   * that the streaming send() can't (its id is a streamId, not an editable activity, and it opens
   * an unfinalized stream). text=null deletes. Best-effort: a dropped notice never costs a turn. */
  async note(id: string | undefined, text: string | null): Promise<string> {
    if (!this.ref) return "";
    try {
      if (id && text === null) {
        // "Remove" means SETTLE, not DELETE: a bot-deleted Teams activity leaves a "This message was
        // deleted" tombstone (teams-no-delete-tombstone). Edit the notice (e.g. the queue footer) to a
        // subtle past-tense line instead — the queued message was picked up, the answer streams below.
        await this.c.updateActivity(this.ref, id, { type: "message", text: "🗂 Picked up your queued message.", textFormat: "markdown" });
        return "";
      }
      if (id) { await this.c.updateActivity(this.ref, id, { type: "message", text, textFormat: "markdown" }); return id; }
      return (await this.c.postActivity(this.ref, { type: "message", text: text ?? "", textFormat: "markdown" })) || "";
    } catch {
      return id ?? "";
    }
  }

  /** Settles the status trace once the reply has landed (working_cue: "message"): instead of
   * DELETING it (which leaves Teams' "This message was deleted" quirk), edits it in place to a
   * final past-tense trace — "Cogitated for 34 seconds" — kept as a subtle gray-italic footer, à
   * la Claude's "Thought for…". Fail-soft: if the edit is rejected the last active form stays
   * (still truthful — the reply is already delivered). No-op if no trace was created (quick reply). */
  async settle(): Promise<void> {
    // Serialize behind any pending working() and latch `settled` so a late heartbeat tick can't
    // re-create the trace after we've settled it (which would leave a fresh dangling "…ing…").
    this.opChain = this.opChain.then(() => this.settleImpl()).catch(() => {});
    return this.opChain;
  }

  private async settleImpl(): Promise<void> {
    if (this.settled) return;
    this.settled = true;
    if (!this.ref || !this.statusMsgId || !this.verb) return;
    const id = this.statusMsgId;
    this.statusMsgId = "";
    const elapsed = this.opts.now() - this.workingStart;
    try {
      await this.c.updateActivity(this.ref, id, statusActivity(statusSettledText(this.verb, elapsed)));
    } catch {
      /* leave the last active form rather than deleting — best-effort */
    }
  }

  /** Liveness cue (teams-working-informative / teams-working-status). The plain typing bubble
   * always shows pre-text (familiar "…typing"; carries no streaminfo, so it's orthogonal to the
   * stream). The labeled "🤖 working…" cue then takes one of two forms (config `working_cue`):
   *  - "message" (default): a SEPARATE gray-italic status trace, created pre-text after a short
   *    delay (so a quick reply never flashes one, and it sits ABOVE the answer like Claude's
   *    "Thought for…") and updated with a mystic verb + elapsed for the WHOLE turn — including a
   *    mid-turn quiet gap after text has started — then SETTLED (not deleted) to a final
   *    past-tense footer when the reply finalizes (`settleStatus`).
   *  - "card": an `informative` streaminfo update — a labeled bar that establishes the stream so
   *    the first text chunk continues it. Pre-text only (it can't resume mid-stream).
   * Elapsed-aware + deduped by label; all posts best-effort. */
  async working(status?: string): Promise<void> {
    // Serialize on opChain so concurrent calls (heartbeat + tool narration) never both create a
    // status trace (the dangling-"…ing…" double-post). Once settled, skip entirely.
    this.opChain = this.opChain.then(() => (this.settled ? undefined : this.workingImpl(status))).catch(() => {});
    return this.opChain;
  }

  private async workingImpl(status?: string): Promise<void> {
    if (!this.ref || this.finalized) return;
    const now = this.opts.now();
    if (this.workingStart < 0) this.workingStart = now;
    const elapsed = now - this.workingStart;
    // A concrete tool status (gw-tool-narration) overrides the generic mystic-verb cue.
    const label = status ?? workingLabel(elapsed);

    // (1) the classic typing bubble — pre-text only (once the reply streams, it shows its own activity).
    if (!this.textStarted) {
      try {
        await this.c.postActivity(this.ref, { type: "typing" });
      } catch {
        /* typing bubble is best-effort */
      }
    }
    if (!this.canEdit()) return; // group: just the bubble (no streaming stream / status to manage)

    // (1b) POST-TEXT liveness (teams-stream-keepalive). A streamed chunk was assumed to "carry
    // liveness", but a long tool gap between chunks leaves the stream idle — Teams expires the typing
    // indicator and freezes the "stop" control (the mid-turn freeze). The 4s heartbeat fires even when
    // NO new text arrives, so keep the stream alive here: re-emit a streaming keepalive (the last prefix,
    // seq++) while under the age cap; on crossing the cap STOP streaming (stay under Teams' limit — no
    // partial posted, finalize delivers one message) and keep a plain typing bubble alive instead.
    if (this.textStarted && this.streamStarted) {
      if (this.streamCapped) {
        try {
          await this.c.postActivity(this.ref, { type: "typing" }); // "…" stays alive; streaming has stopped
        } catch {
          /* bubble best-effort */
        }
      } else if (now - this.streamStart > this.opts.maxStreamAgeMs) {
        this.streamCapped = true; // stop streaming from here; next tick shows the plain typing bubble
      } else if (now - this.lastStreamAt >= STREAM_KEEPALIVE_MS) {
        this.seq += 1;
        this.lastStreamAt = now;
        try {
          await this.c.postActivity(this.ref, {
            type: "typing",
            text: this.lastText,
            entities: [streamInfo("streaming", this.streamId || undefined, this.seq)],
          });
        } catch {
          /* keepalive best-effort */
        }
      }
      // fall through: the "message" cue also refreshes its gray status trace (verb/elapsed + last tool)
    }

    if (this.opts.cue === "card") {
      // informative streaminfo card — pre-text only (establishes the stream).
      if (this.textStarted) return;
      if (this.streamStarted && label === this.lastWorkingLabel) return; // dedup by step
      this.lastWorkingLabel = label;
      this.seq += 1;
      try {
        const id = await this.c.postActivity(this.ref, {
          type: "typing",
          text: label,
          entities: [streamInfo("informative", this.streamId || undefined, this.seq)],
        });
        if (!this.streamId) this.streamId = id || "";
        this.streamStarted = true;
      } catch {
        /* informative cue is best-effort */
      }
      return;
    }

    // cue === "message": ONE gray-italic status trace with up to two lines — the LAST tool
    // (🔧, gw-tool-narration) and the ticking 🤖 elapsed cue — so they COEXIST instead of one
    // overwriting the other. A tool status (status set) remembers its line and shows immediately;
    // the generic-only cue keeps its short delay and never opens a trace BELOW an in-flight answer.
    if (status) this.lastTool = status;
    const haveTool = this.lastTool !== "";
    if (!haveTool && !this.statusMsgId) {
      if (this.textStarted) return; // generic-only footer under a streaming answer → skip
      if (elapsed < STATUS_DELAY_MS) return; // delay so a quick reply never flashes one
    }
    if (!this.verb) this.verb = (this.opts.pickVerb ?? randomMysticVerb)();
    const lines: string[] = [];
    if (haveTool) lines.push(this.lastTool); // 🔧 last tool (persists while elapsed ticks)
    lines.push(statusActiveText(this.verb, elapsed)); // 🤖 verb… Ns
    const text = lines.join("\n");
    if (text === this.lastWorkingLabel && this.statusMsgId) return; // dedup by step
    this.lastWorkingLabel = text;
    try {
      if (!this.statusMsgId) {
        this.statusMsgId = (await this.c.postActivity(this.ref, statusActivity(text))) || "";
      } else {
        await this.c.updateActivity(this.ref, this.statusMsgId, statusActivity(text));
      }
    } catch {
      /* status trace is best-effort */
    }
  }
}

/** The labeled liveness cue text. It counts **exact seconds in the first minute** (`🤖 working…` →
 * `(1s)` → `(2s)` → …) so a watcher sees it clearly ticking, then **steps every 10s** after a minute
 * (`(1m)`, `(1m10s)`, …) so a long wait doesn't churn. Deduped by this label, so it re-posts exactly
 * when the label changes (bounded by the ~4s heartbeat — these are Teams REST posts, zero model cost). */
function workingLabel(elapsedMs: number): string {
  const e = compactElapsed(elapsedMs);
  return e ? `🤖 working… (${e})` : "🤖 working…";
}

/** Active status-trace text (working_cue: "message") — the 🤖 bot marker + the mystic verb in
 * gerund + a compact elapsed that counts exact seconds under a minute (clearly moving) then steps
 * every 10s after (so it re-posts on each step, deduped). Under 1s the count is omitted. */
function statusActiveText(verb: MysticVerb, elapsedMs: number): string {
  const e = compactElapsed(elapsedMs);
  return e ? `🤖 ${verb.ing}… ${e}` : `🤖 ${verb.ing}…`;
}
/** Exact seconds in the first minute ("5s", "47s") so the cue is visibly moving; after a minute,
 * 10s steps ("1m", "1m10s", "2m30s") so a long wait doesn't churn. */
function compactElapsed(ms: number): string {
  if (ms < 1_000) return "";
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  const m = Math.floor(ms / 60_000);
  const s10 = Math.floor((ms % 60_000) / 10_000) * 10;
  return s10 ? `${m}m${s10}s` : `${m}m`;
}
/** Settled status-trace text — the verb in past tense + total elapsed ("Cogitated for 34 seconds"
 * / "… for 2 minutes"), à la Claude's "Thought for…". */
function statusSettledText(verb: MysticVerb, elapsedMs: number): string {
  if (elapsedMs < 60_000) {
    const s = Math.max(1, Math.round(elapsedMs / 1000));
    return `${verb.ed} for ${s} second${s === 1 ? "" : "s"}`;
  }
  const m = Math.round(elapsedMs / 60_000);
  return `${verb.ed} for ${m} minute${m === 1 ? "" : "s"}`;
}

/** The status-trace activity (working_cue: "message"). A subtle gray-italic line: by default a
 * minimal Adaptive Card (RichTextBlock + TextRun, `italic`+`isSubtle` — first-class properties, no
 * markdown-color gamble), since markdown text can't be colored. With STATUS_TRACE_AS_CARD=false it
 * degrades to a plain italic markdown line (no gray box) — the one-flag fallback. */
function statusActivity(text: string): Record<string, unknown> {
  if (!STATUS_TRACE_AS_CARD) {
    return { type: "message", text: `_${text}_`, textFormat: "markdown" };
  }
  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        content: {
          type: "AdaptiveCard",
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          version: "1.4",
          body: [
            {
              type: "RichTextBlock",
              spacing: "None",
              inlines: [{ type: "TextRun", text, italic: true, isSubtle: true, size: "Small" }],
            },
          ],
        },
      },
    ],
  };
}

/** A Bot Framework `streaminfo` entity — streamId only after the first chunk, streamSequence
 * present for streaming/informative but NOT for final (matches openclaw's tested shape). */
function streamInfo(streamType: "streaming" | "informative" | "final", streamId?: string, streamSequence?: number): Record<string, unknown> {
  const e: Record<string, unknown> = { type: "streaminfo", streamType };
  if (streamId) e.streamId = streamId;
  if (streamSequence != null) e.streamSequence = streamSequence;
  return e;
}

// --- inbound JWT validation (teams-inbound-auth) -----------------------------

/** Builds a Bot Framework inbound-token validator: fetches the BF OpenID metadata + JWKS,
 * verifies the RS256 signature against the kid, and checks audience(=appId)/exp/nbf. Keys
 * are cached. Fail-closed: any error → false. (openclaw createBotFrameworkJwtValidator.) */
export function createBotFrameworkJwtValidator(o: {
  appId: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  jwksUri?: string;
  /** Accepted token issuers (defense-in-depth on an internet-exposed listener). Defaults to
   * the Bot Framework issuer; pass others for gov/sovereign clouds. */
  issuers?: string[];
}): (authHeader: string | undefined) => Promise<boolean> {
  const doFetch = o.fetchImpl ?? fetch;
  const now = o.now ?? Date.now;
  const issuers = o.issuers ?? ["https://api.botframework.com"];
  let keys: Map<string, crypto.KeyObject> | undefined;
  let keysExp = 0;

  const loadKeys = async (): Promise<Map<string, crypto.KeyObject>> => {
    if (keys && keysExp > now()) return keys;
    let jwksUri = o.jwksUri;
    if (!jwksUri) {
      const cfg = (await (await doFetch(BF_OPENID_CONFIG)).json()) as { jwks_uri?: string };
      jwksUri = cfg.jwks_uri;
    }
    if (!jwksUri) throw new Error("no jwks_uri");
    const jwks = (await (await doFetch(jwksUri)).json()) as { keys: JwkKey[] };
    const m = new Map<string, crypto.KeyObject>();
    for (const k of jwks.keys) {
      if (k.kid) m.set(k.kid, crypto.createPublicKey({ key: k as crypto.JsonWebKey, format: "jwk" }));
    }
    keys = m;
    keysExp = now() + 24 * 3600 * 1000; // refresh daily
    return m;
  };

  return async (authHeader: string | undefined): Promise<boolean> => {
    try {
      const tok = (authHeader || "").replace(/^Bearer\s+/i, "").trim();
      const [h64, p64, s64] = tok.split(".");
      if (!h64 || !p64 || !s64) return false;
      const header = JSON.parse(b64urlToBuf(h64).toString("utf8")) as { kid?: string; alg?: string };
      const payload = JSON.parse(b64urlToBuf(p64).toString("utf8")) as { aud?: string; iss?: string; exp?: number; nbf?: number };
      if (header.alg !== "RS256" || !header.kid) return false;
      if (payload.aud !== o.appId) return false; // audience = the bot's app id
      if (!payload.iss || !issuers.includes(payload.iss)) return false; // issuer allow-list
      const t = Math.floor(now() / 1000);
      if (payload.exp && t > payload.exp) return false;
      if (payload.nbf && t < payload.nbf - 300) return false;
      const key = (await loadKeys()).get(header.kid);
      if (!key) return false;
      const v = crypto.createVerify("RSA-SHA256");
      v.update(`${h64}.${p64}`);
      v.end();
      return v.verify(key, b64urlToBuf(s64));
    } catch {
      return false; // fail-closed
    }
  };
}

// --- helpers -----------------------------------------------------------------

function hostOf(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}
function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
function b64urlToBuf(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}
/** Strips Teams `<at>Name</at>` mention markup so the agent sees plain text. */
export function stripMentions(s: string): string {
  return s.replace(/<at>.*?<\/at>/g, "").replace(/\s+/g, " ").trim();
}

// --- Bot Framework activity shapes (only the fields we route on) -------------

interface JwkKey {
  kid?: string;
  kty?: string;
  n?: string;
  e?: string;
}
export interface TeamsActivity {
  type?: string; // "message" | "typing" | "conversationUpdate" | ...
  text?: string;
  serviceUrl?: string;
  channelId?: string;
  from?: { id?: string; name?: string; aadObjectId?: string };
  recipient?: { id?: string; name?: string };
  conversation?: { id?: string; conversationType?: string; tenantId?: string };
  channelData?: { tenant?: { id?: string } };
  attachments?: TeamsAttachment[];
}

/** One Bot Framework attachment. A FILE picked in a 1:1 chat arrives as
 * `application/vnd.microsoft.teams.file.download.info`, whose real bytes live at
 * `content.downloadUrl` (a pre-authenticated SharePoint URL — NO auth header). An inline
 * IMAGE arrives as `image/*` with a `contentUrl` on a Bot Framework host that DOES need the
 * bot token. (teams-media-inbound.) */
export interface TeamsAttachment {
  contentType?: string;
  contentUrl?: string;
  name?: string;
  content?: { downloadUrl?: string; fileType?: string; fileName?: string; uniqueId?: string };
}

/** How to fetch one inbound attachment: the URL, a filename for the on-disk copy, and whether
 * to attach the bot bearer token. Returns null for a non-downloadable attachment (a card, an
 * HTML body part, or a file.download.info with no downloadUrl). Pure + testable — the auth
 * decision (the security-sensitive part) is settled here, off the network. */
export function resolveAttachment(att: TeamsAttachment, serviceHosts: string[] = DEFAULT_SERVICE_HOSTS): { url: string; name: string; auth: boolean } | null {
  const type = (att.contentType || "").toLowerCase();
  // Cards / HTML body parts carry no file to download.
  if (type.startsWith("application/vnd.microsoft.card")) return null;
  if ((type === "text/html" || type === "text/plain") && !att.contentUrl) return null;
  // File attachment (1:1 chat): the pre-authed downloadUrl is fetched WITHOUT the bot token
  // (sending it would 401, and the URL already carries its own auth).
  if (type === "application/vnd.microsoft.teams.file.download.info") {
    const url = att.content?.downloadUrl;
    if (!url) return null;
    const ftype = (att.content?.fileType || "").replace(/^\./, "");
    const name = att.name || att.content?.fileName || (att.content?.uniqueId && ftype ? `${att.content.uniqueId}.${ftype}` : "document");
    return { url, name, auth: false };
  }
  if (!att.contentUrl) return null;
  // Inline image on a Bot Framework host → bot token (else it 401s). Any other contentUrl
  // (or a non-BF host we won't hand a token to) is fetched unauthenticated.
  let host = "";
  try {
    host = new URL(att.contentUrl).hostname;
  } catch {
    return null;
  }
  const auth = type.startsWith("image/") && serviceHosts.includes(host);
  // Filename drives the on-disk extension, which is how `claude`'s Read decides image vs. text.
  // Teams often omits `name` for an inline image, so fall back to a synthetic name whose extension
  // comes from the contentType (NOT the hostname — "attachment-…trafficmanager.net" saved a JPEG as
  // ".net", so Read couldn't tell it was an image).
  const name = att.name || `attachment${extForContentType(type)}`;
  return { url: att.contentUrl, name, auth };
}

/** Map an image contentType to a file extension so a downloaded inline image is named `.jpg`/`.png`
 * (what `claude`'s Read keys on), not a bogus extension pulled from the URL host. "" if unknown. */
function extForContentType(type: string): string {
  const m: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/heic": ".heic",
    "application/pdf": ".pdf",
  };
  return m[type] ?? "";
}

/** Media extensions we'll trust from a supplied filename (so a bogus one like ".net" — pulled from a
 * URL host — never reaches disk). Anything else falls back to content sniffing or ".bin". */
const KNOWN_MEDIA_EXT = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic", ".heif", ".bmp", ".tif", ".tiff", ".pdf"]);

/** Detect a file's real extension from its MAGIC BYTES — the durable answer to "what is this file",
 * independent of whatever Teams put in the name/contentType/URL (a JPEG mislabeled `.net` confused
 * `claude`'s Read). Returns "" if unrecognized, so the caller falls back to a trusted name ext / .bin. */
export function sniffExtension(buf: Buffer): string {
  const b = (i: number): number => (i < buf.length ? buf[i] : -1);
  const ascii = (off: number, s: string): boolean => buf.toString("latin1", off, off + s.length) === s;
  if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return ".jpg";
  if (b(0) === 0x89 && ascii(1, "PNG")) return ".png";
  if (ascii(0, "GIF8")) return ".gif";
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return ".webp";
  if (ascii(0, "%PDF")) return ".pdf";
  if (ascii(4, "ftyp") && (ascii(8, "heic") || ascii(8, "heix") || ascii(8, "mif1") || ascii(8, "heif"))) return ".heic";
  if (b(0) === 0x42 && b(1) === 0x4d) return ".bmp";
  if ((b(0) === 0x49 && b(1) === 0x49 && b(2) === 0x2a) || (b(0) === 0x4d && b(1) === 0x4d && b(2) === 0x00)) return ".tiff";
  return "";
}
