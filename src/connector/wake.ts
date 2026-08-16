// Letting a system start the conversation.
//
// Everything in the gateway is built for a person speaking first. Plenty of
// useful work is the other way round: a job finishes and the agent should say
// something about it. This wraps any connector so an authenticated HTTP call
// produces an ordinary `Envelope` — which means it inherits session resume, turn
// queueing, /steer and streamed replies with no downstream change at all. The
// gateway's loop does not know a wake happened.
//
// Two deliberate choices:
//
//   * The caller addresses a PERSON ("rod"), not a conversation id. A channel id
//     is an implementation detail of Teams that no caller should have to carry,
//     and it changes when the conversation does.
//
//   * The wake carries an INSTRUCTION, not finished text. The agent composes the
//     message itself, so what it said is in its own session history — which is
//     what makes a follow-up like "drop that second point" resolvable. A gateway
//     that relayed prepared text would break exactly that.
import http from "node:http";
import type { Connector, Envelope, Reply } from "../core/contracts";
import type { ConvStore } from "./convstore";

export interface WakeOptions {
  /** Shared secret, presented as `Authorization: Bearer …`. Same pattern as
   *  AGENT_RUNTIME_TOKEN. Absent = the endpoint is not served at all. */
  token?: string;
  /** Own port, so the wake does not depend on a connector running a webhook. */
  port?: number;
  /** Resolves a person to a conversation. */
  store: ConvStore<unknown>;
  /** Default sender label on the produced envelope. */
  user?: string;
}

interface WakeBody {
  person?: string;
  text?: string;
  user?: string;
}

/**
 * Wrap `inner` so wakes appear alongside its own inbound messages.
 * `reply()` and everything else delegate untouched.
 */
export function withWake(inner: Connector, o: WakeOptions): Connector {
  return {
    name: () => inner.name(),
    reply: (conversation: string): Reply => inner.reply(conversation),
    registerCommands: inner.registerCommands?.bind(inner),

    async *receive(signal: AbortSignal): AsyncIterable<Envelope> {
      if (!o.token) {
        // Not configured: behave exactly as the bare connector, rather than
        // serving an unauthenticated endpoint that can make the agent talk.
        yield* inner.receive(signal);
        return;
      }

      const queue: Envelope[] = [];
      let wake: (() => void) | undefined;
      const push = (e: Envelope) => {
        queue.push(e);
        wake?.();
      };

      const port = o.port ?? 3980;
      const server = http.createServer((req, res) => {
        void handle(req, res, o, inner.name(), push);
      });
      server.on("error", (e) => console.error(`wake: server: ${(e as Error).message}`));
      server.listen(port, () => console.log(`wake: listening on :${port}/api/wake`));
      const close = () => server.close();
      signal.addEventListener("abort", close, { once: true });

      // Drain the inner connector in the background so a quiet channel never
      // starves the wake queue, and vice versa.
      const inbound = (async () => {
        for await (const env of inner.receive(signal)) push(env);
      })().catch((e) => console.error(`wake: inner connector: ${(e as Error).message}`));

      try {
        while (!signal.aborted) {
          while (queue.length) yield queue.shift()!;
          await new Promise<void>((resolve) => {
            wake = resolve;
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
        }
      } finally {
        signal.removeEventListener("abort", close);
        server.close();
        await inbound;
      }
    },
  };
}

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  o: WakeOptions,
  channel: string,
  push: (e: Envelope) => void,
): Promise<void> {
  if (req.method !== "POST" || !(req.url ?? "").startsWith("/api/wake")) {
    res.writeHead(req.method === "GET" ? 405 : 404).end();
    return;
  }

  const auth = req.headers["authorization"];
  const presented = typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")
    ? auth.slice(7).trim()
    : "";
  if (!presented || presented !== o.token) {
    res.writeHead(401).end(JSON.stringify({ error: "unauthorized" }));
    return;
  }

  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let parsed: WakeBody;
    try {
      parsed = JSON.parse(body || "{}") as WakeBody;
    } catch {
      res.writeHead(400).end(JSON.stringify({ error: "invalid json" }));
      return;
    }

    const person = (parsed.person ?? "").trim();
    const text = (parsed.text ?? "").trim();
    if (!person || !text) {
      res.writeHead(400).end(JSON.stringify({ error: "person and text are required" }));
      return;
    }

    const target = o.store.resolve(person);
    if (!target) {
      // 404 rather than a silent success: the caller is expected to RETRY and
      // to surface a failure loudly. A dropped wake means someone never hears
      // the thing the agent was asked to tell them.
      res.writeHead(404).end(
        JSON.stringify({
          error: `no known conversation for '${person}'`,
          hint: "they must have messaged the agent at least once",
        }),
      );
      return;
    }

    push({
      channel,
      conversation: target.conversation,
      user: parsed.user ?? o.user ?? "system",
      text,
      mediaPaths: [],
    });
    res.writeHead(202).end(JSON.stringify({ queued: true, conversation: target.conversation }));
  });
}
