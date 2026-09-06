// `tonoman worker` — the durable runtime.
//
// It is the same runtime as `tonoman up`, with Temporal between the message and the turn. The
// connectors are the same connectors and the harness is the same harness; what changes is that a
// turn is a workflow, so it survives a restart, it has an identity, and it can be interrupted
// rather than raced.
//
// This lives in Tonoman OSS on purpose. Durable turns and interruption are runtime concerns — an
// operator running Tonoman on their own machine wants both. Multi-tenancy is what Tonoman Cloud
// adds, and all it changes here is where the roster came from.
//
// One process holds the connectors AND serves the task queue. Socket Mode is a long-lived outbound
// WebSocket that something has to hold anyway; making that the same process that runs turns removes
// a hop and a deployment.

import { Client, Connection } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import * as path from "node:path";
import type { Config, AgentConfig } from "../config";
import type { Connector, TurnEvent } from "../core/contracts";
import { SlackConnector } from "../connector/slack";
import { defaultHarnesses } from "../gateway";
import { makeActivities, type TurnRunReq } from "./activities";
import { conversationWorkflow, messageSignal, type Inbound } from "./workflows";

export interface WorkerOptions {
  address: string;
  namespace: string;
  taskQueue: string;
  maxConcurrentTurns?: number;
  /** Where the compiled workflows live. Overridable for tests. */
  workflowsPath?: string;
}

export function workerOptionsFrom(env: NodeJS.ProcessEnv): WorkerOptions {
  return {
    address: env.TEMPORAL_ADDRESS ?? "127.0.0.1:7233",
    namespace: env.TEMPORAL_NAMESPACE ?? "default",
    taskQueue: env.TEMPORAL_TASK_QUEUE ?? "tonoman-turns",
    // One or two turns per worker. Each spawns a claude process; admitting more trades a queue for
    // OOM kills on a small node, and Temporal already holds the excess safely.
    maxConcurrentTurns: Number(env.MAX_CONCURRENT_TURNS ?? 2),
  };
}

/** Builds one connector + runner per agent in the roster. An agent whose channel has no connector
 *  is skipped with a reason rather than failing the worker — one bad row must not silence the rest. */
function wire(cfg: Config): Map<string, { cfg: AgentConfig; conn: Connector; run: (r: TurnRunReq) => AsyncIterable<TurnEvent> }> {
  const harnesses = defaultHarnesses();
  const out = new Map<string, { cfg: AgentConfig; conn: Connector; run: (r: TurnRunReq) => AsyncIterable<TurnEvent> }>();
  for (const a of cfg.agents ?? []) {
    const channel = a.channel ?? (a.slack ? "slack" : a.teams ? "teams" : "telegram");
    if (channel !== "slack") {
      console.error(`worker: skipping ${a.name} — channel "${channel}" has no worker connector yet`);
      continue;
    }
    const appToken = a.slack?.app_token || process.env.SLACK_APP_TOKEN || "";
    const botToken = a.slack?.bot_token || process.env.SLACK_BOT_TOKEN || "";
    if (!appToken || !botToken) {
      console.error(`worker: skipping ${a.name} — missing ${!botToken ? "bot" : "app"} token`);
      continue;
    }
    const conn = new SlackConnector({ appToken, botToken, allowedUsers: a.slack?.allowed_users });

    const spec = harnesses.lookup(a.harness ?? "claude-code");
    if (!spec?.newRunner) {
      console.error(`worker: skipping ${a.name} — harness "${a.harness}" cannot run turns`);
      continue;
    }
    // No container: the pod is the sandbox (an agent is a row, not a container).
    const runner = spec.newRunner({ container: a.container, model: a.model, maxTurns: a.max_turns, url: a.url });

    out.set(a.name, {
      cfg: a,
      conn,
      run: (r: TurnRunReq) => runner.run({ prompt: r.prompt, systemPromptFile: r.systemPromptFile }),
    });
  }
  return out;
}

export async function run(cfg: Config, o: WorkerOptions, signal: AbortSignal): Promise<void> {
  const wired = wire(cfg);
  if (wired.size === 0) {
    // Loudly: a worker with no connectors looks perfectly healthy while answering nobody.
    console.error("worker: NO agents have a usable channel binding — nothing will be answered.");
  }

  const deps = { agent: (name: string) => wired.get(name) };
  const activities = makeActivities(deps);

  const nativeConn = await NativeConnection.connect({ address: o.address });
  const worker = await Worker.create({
    connection: nativeConn,
    namespace: o.namespace,
    taskQueue: o.taskQueue,
    workflowsPath: o.workflowsPath ?? path.join(__dirname, "workflows.js"),
    activities,
    maxConcurrentActivityTaskExecutions: o.maxConcurrentTurns ?? 2,
  });
  const serving = worker.run();
  console.log(`worker: serving ${o.taskQueue} on ${o.address}/${o.namespace} — ${wired.size} agent(s)`);

  const conn = await Connection.connect({ address: o.address });
  const client = new Client({ connection: conn, namespace: o.namespace });

  // Ingress: each connector yields envelopes; each becomes a signal. The connector does nothing
  // else — the durability boundary starts at signalWithStart.
  const pumps: Promise<void>[] = [];
  for (const [name, a] of wired) {
    pumps.push(
      (async () => {
        for await (const env of a.conn.receive(signal)) {
          const first: Inbound = { text: env.text, user: env.user, ts: String(Date.now()) };
          try {
            // One call whether or not the conversation is already running. Temporal serializes
            // signals per workflow id, so ordering is free and two people typing at once cannot
            // interleave two turns.
            await client.workflow.signalWithStart(conversationWorkflow, {
              workflowId: `${name}:${env.channel}:${env.conversation}`,
              taskQueue: o.taskQueue,
              args: [{ agent: name, conversation: env.conversation, channel: env.channel, first }],
              signal: messageSignal,
              signalArgs: [first],
            });
          } catch (e) {
            console.error(`worker: signal failed for ${env.conversation}: ${(e as Error).message}`);
          }
        }
      })(),
    );
  }

  signal.addEventListener("abort", () => worker.shutdown(), { once: true });
  await Promise.all([serving, ...pumps]);
  await conn.close();
  await nativeConn.close();
  console.log("worker: stopped");
}
