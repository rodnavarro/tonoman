// Letting a SYSTEM start the conversation.
//
// Everything else here is a person typing and an agent answering. The voice flow inverts that: a
// recording finishes, and the agent has to say something nobody asked for — "I've got your meeting,
// I'm processing it", and later the highlights. Without this the whole flow ends in a file nobody
// is told about.
//
// A woken turn becomes an ordinary message, so it is indistinguishable downstream from a typed one:
// same workflow, same conversation key, same history. The alternative — a special "notification"
// path that posts directly — would mean two ways for an agent to speak and two things to keep
// consistent.
//
// Cluster-internal only, and gated on a token that must be present or the endpoint is not served at
// all. Not served is safer than served-without-a-check: a missing environment variable should
// remove the capability, never quietly open it.

import * as http from "node:http";

export interface WakeRequest {
  /** Roster name of the agent to speak, e.g. "murphy-nelly". */
  agent: string;
  /** Who to speak TO: a Slack user id. The agent opens (or reuses) a DM with them. */
  user?: string;
  /** Or an explicit conversation key, when the caller already knows one. */
  conversation?: string;
  /** What to say, as if the person had asked for it. */
  text: string;
  /** When true the text is posted verbatim instead of being run as a turn. For the "I've got your
   *  meeting" acknowledgement, where spending an LLM turn to relay a known sentence is waste. */
  verbatim?: boolean;
}

/** What the Hub asks for when somebody presses "run now" on a Talent (W4).
 *
 *  It is the SAME run `!talent` starts and the same run a schedule starts — one per-item workflow,
 *  one `talent_run` row, one dedup id — differing only in `trigger`, which is what makes "who asked
 *  for this" answerable afterwards. A second mechanism would have meant a second thing to keep in
 *  step with the first, which is how the poll and the on-demand path came to disagree once already. */
export interface TalentRunRequest {
  /** The agent, as the REGISTRY names it: its guid. (The worker's own local name is accepted too —
   *  on a registry roster they are the same string, and on a file roster there is no guid at all.) */
  agent: string;
  /** Which Talent, by name. */
  talent: string;
  /** The one item to run it on — a recording id, or whatever that Talent's items are keyed by. */
  item: string;
  /** WHO the run is for: a Slack user id. It decides who is told, and — on an agent where everybody
   *  brings their own subscription — whose login pays for the inference. */
  user: string;
  /** Re-run an item that is already filed, instead of the run being a no-op. */
  force?: boolean;
  /** WHO asked, as an opaque account id from the Hub. Recorded on the run, never interpreted here:
   *  this worker has no user table and should not pretend to. */
  requestedBy?: string;
}

export interface WakeDeps {
  /** Open (or reuse) a DM with a user and return the conversation key. */
  dmFor(agent: string, userId: string): Promise<string | undefined>;
  /** Say something verbatim in a conversation. */
  say(agent: string, conversation: string, text: string): Promise<void>;
  /** Run `text` as though the person had sent it.
   *
   *  `user` is who the agent is SPEAKING TO, and it matters: a woken turn has no human sender, so
   *  passing a placeholder makes the agent believe it is talking to a stranger and — correctly —
   *  refuse to discuss anything specific. Observed: the highlights DM came back as "I don't think
   *  we've met, who are you?". The recipient's own id is the right answer, because the message is
   *  addressed to them. */
  ask(agent: string, conversation: string, text: string, user?: string): Promise<void>;
  /** Whether this agent exists in the roster. */
  has(agent: string): boolean;
  /** The worker's own key for an agent the CALLER named — a registry guid from the Hub, or a local
   *  name. Undefined when it serves no such agent, which is what makes the endpoint answer 404
   *  rather than quietly starting nothing. Optional: a deployment without it falls back to `has`. */
  resolveAgent?(nameOrGuid: string): string | undefined;
  /** Start a Talent on one item now (W4). The same function `!talent` calls, so the two triggers
   *  cannot drift apart. `started: false` is the normal answer for an item already in flight or
   *  already done — reported, not an error. */
  runTalent?(
    agent: string,
    talent: string,
    item: string,
    user?: string,
    force?: boolean,
    o?: { trigger?: "schedule" | "command" | "hub"; requestedBy?: string },
  ): Promise<{ started: boolean; message: string; workflowId?: string }>;
  /** Re-fetch the roster and apply the difference NOW, instead of waiting for the next poll tick.
   *  Optional: a worker with reload disabled (no reloadRoster, or ROSTER_RELOAD_SECONDS=0) does not
   *  offer it, and `POST /api/reload` answers 404 there. The Hub's API pokes this after a write so an
   *  edit reaches the running agent in about a second rather than up to a poll interval later. */
  reload?(): void;
}

/** PURE: validate a wake body, returning the request or the reason it is not one. Unit-tested —
 *  this is an endpoint other systems call, so its errors should say what is wrong. */
export function parseWake(body: unknown): { ok: true; req: WakeRequest } | { ok: false; error: string } {
  const b = (body ?? {}) as Partial<WakeRequest>;
  if (!b.agent) return { ok: false, error: "agent is required" };
  if (!b.text) return { ok: false, error: "text is required" };
  if (!b.user && !b.conversation) return { ok: false, error: "one of user or conversation is required" };
  return {
    ok: true,
    req: { agent: b.agent, user: b.user, conversation: b.conversation, text: b.text, verbatim: b.verbatim === true },
  };
}

/** PURE: validate a talent-run body, returning the request or the reason it is not one. Unit-tested
 *  for the same reason `parseWake` is: another system calls this, and an error that does not say
 *  what is wrong turns a typo into an afternoon. Every field is checked by NAME, so a caller that
 *  sends `talentName` is told which field is missing rather than getting a run of `undefined`. */
export function parseTalentRun(body: unknown): { ok: true; req: TalentRunRequest } | { ok: false; error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const str = (k: string): string => (typeof b[k] === "string" ? (b[k] as string).trim() : "");
  for (const k of ["agent", "talent", "item", "user"]) {
    if (!str(k)) return { ok: false, error: `${k} is required` };
  }
  // `force` and `requestedBy` are the only optional fields, and a wrong TYPE on either is a caller
  // bug worth naming: `force: "true"` silently doing nothing is the kind of thing that gets
  // rediscovered a week later as "the re-run button doesn't work".
  if (b.force !== undefined && typeof b.force !== "boolean") return { ok: false, error: "force must be a boolean" };
  if (b.requestedBy !== undefined && typeof b.requestedBy !== "string") {
    return { ok: false, error: "requestedBy must be a string" };
  }
  return {
    ok: true,
    req: {
      agent: str("agent"),
      talent: str("talent"),
      item: str("item"),
      user: str("user"),
      force: b.force === true,
      requestedBy: str("requestedBy") || undefined,
    },
  };
}

export interface WakeServerOptions {
  port: number;
  /** Bearer token. Without it the server is not started at all. */
  token: string;
  deps: WakeDeps;
}

/** Serves POST /api/wake until `signal` aborts. Returns false when no token was configured, so the
 *  caller can log that the capability is off rather than assume it is on. */
export function serveWake(o: WakeServerOptions, signal: AbortSignal): boolean {
  if (!o.token) return false;

  const server = http.createServer((req, res) => {
    const send = (code: number, body: unknown): void => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(`${JSON.stringify(body)}\n`);
    };

    const route = (req.url ?? "").split("?")[0];
    const ROUTES = ["/api/wake", "/api/reload", "/api/talent-run"];
    if (req.method !== "POST" || !ROUTES.includes(route)) {
      return send(404, { error: "not found" });
    }
    if (req.headers.authorization !== `Bearer ${o.token}`) {
      return send(401, { error: "unauthorized" });
    }

    // Reload NOW, on demand — the Hub's API pokes this after a write so an edit reaches the running
    // agent in about a second. Bodyless and idempotent: it re-fetches the whole roster and applies
    // the diff, exactly what the poll timer does, so a double poke is a no-op. 404 when the worker
    // has reload disabled, so the API can tell "not supported" from "not authorised".
    if (route === "/api/reload") {
      if (!o.deps.reload) return send(404, { error: "reload is not enabled on this worker" });
      o.deps.reload();
      return send(202, { accepted: true });
    }

    let raw = "";
    req.on("data", (c) => {
      raw += c;
      // A wake is a sentence, not an upload.
      if (raw.length > 64_000) req.destroy();
    });
    req.on("end", () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw || "{}");
      } catch {
        return send(400, { error: "invalid json" });
      }

      // Run a Talent on one item, asked for from the Hub (W4). UNLIKE /api/wake this answers with
      // the outcome rather than 202-and-then: the caller is a person who just pressed a button and
      // is owed "started" or "already running" now, and starting a workflow is a fast call — it is
      // the RUN that is slow, and that is Temporal's to carry, not this connection's.
      if (route === "/api/talent-run") {
        if (!o.deps.runTalent) return send(404, { error: "this worker cannot run a Talent on demand" });
        const t = parseTalentRun(parsed);
        if (!t.ok) return send(400, { error: t.error });
        // The Hub names an agent by its registry guid; this worker keys its own map by whatever the
        // roster called it. Resolving rather than assuming is what lets the endpoint answer a clean
        // 404 for an agent this worker does not serve, instead of starting a workflow for a name
        // nothing will ever pick up.
        const key = o.deps.resolveAgent?.(t.req.agent) ?? (o.deps.has(t.req.agent) ? t.req.agent : undefined);
        if (!key) return send(404, { error: `no such agent "${t.req.agent}"` });
        void (async () => {
          try {
            const r = await o.deps.runTalent!(key, t.req.talent, t.req.item, t.req.user, t.req.force, {
              trigger: "hub",
              requestedBy: t.req.requestedBy,
            });
            // 409, not 200-with-a-flag: "already running or already done" is a conflict with the
            // state of that item, and a caller that only reads the status code should not read it
            // as a fresh run. The message says which, in words.
            send(r.started ? 200 : 409, { started: r.started, message: r.message, workflowId: r.workflowId });
          } catch (e) {
            console.error(`talent-run: ${key} ${t.req.talent} failed to start: ${(e as Error).message}`);
            send(500, { started: false, message: `couldn't start it — ${(e as Error).message.slice(0, 200)}` });
          }
        })();
        return;
      }

      const v = parseWake(parsed);
      if (!v.ok) return send(400, { error: v.error });
      const { agent, user, conversation, text, verbatim } = v.req;
      if (!o.deps.has(agent)) return send(404, { error: `no such agent "${agent}"` });

      // Answer immediately and do the work after: the caller is a pipeline, not a person, and it
      // should not hold a connection open for the length of an LLM turn.
      send(202, { accepted: true });

      void (async () => {
        try {
          const conv = conversation ?? (user ? await o.deps.dmFor(agent, user) : undefined);
          if (!conv) {
            console.error(`wake: ${agent} could not resolve a conversation for user=${user}`);
            return;
          }
          if (verbatim) await o.deps.say(agent, conv, text);
          else await o.deps.ask(agent, conv, text, user);
        } catch (e) {
          console.error(`wake: ${agent} failed: ${(e as Error).message}`);
        }
      })();
    });
  });

  server.listen(o.port, "0.0.0.0", () => console.log(`wake: listening on :${o.port}`));
  signal.addEventListener("abort", () => server.close(), { once: true });
  return true;
}
