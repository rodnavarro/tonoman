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

    if (req.method !== "POST" || (req.url ?? "").split("?")[0] !== "/api/wake") {
      return send(404, { error: "not found" });
    }
    if (req.headers.authorization !== `Bearer ${o.token}`) {
      return send(401, { error: "unauthorized" });
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
