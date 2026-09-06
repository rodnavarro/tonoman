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
import { httpAuthOps } from "../authflow";
import * as gate from "./authgate";
import * as secondbrain from "./secondbrain";
import { promises as fsp } from "node:fs";
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

/** Resolve `<secret>:<key>` from the mounted secret tree — the same contract the control plane
 *  uses. Returns "" when absent; the caller decides whether that is fatal. A ref comes from a
 *  database edited through a web form, so anything that could climb out of the mount is refused
 *  rather than read. */
async function resolveRef(ref: string | null | undefined): Promise<string> {
  if (!ref) return "";
  const i = ref.indexOf(":");
  if (i < 0) return "";
  const secret = ref.slice(0, i);
  const key = ref.slice(i + 1);
  if (!/^[A-Za-z0-9._-]+$/.test(secret) || !/^[A-Za-z0-9._-]+$/.test(key)) return "";
  const dir = process.env.TONOMAN_SECRETS_DIR ?? "/etc/tonoman/secrets";
  try {
    return (await fsp.readFile(path.join(dir, secret, key), "utf8")).trim();
  } catch {
    return "";
  }
}

/** Builds one connector + runner per agent in the roster. An agent whose channel has no connector
 *  is skipped with a reason rather than failing the worker — one bad row must not silence the rest. */
function wire(cfg: Config): Map<string, { cfg: AgentConfig; conn: Connector; context?: string; run: (r: TurnRunReq) => AsyncIterable<TurnEvent> }> {
  const harnesses = defaultHarnesses();
  const out = new Map<string, { cfg: AgentConfig; conn: Connector; context?: string; run: (r: TurnRunReq) => AsyncIterable<TurnEvent> }>();
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

  /** Pull every granted source and refresh the agent's context note.
   *
   *  Run once before serving, then on a timer. The timer is not a nicety: the whole point of the
   *  voice flow is that a meeting recorded minutes ago is something the agent can talk about, and a
   *  checkout taken only at boot would mean the answer is "I don't know" until somebody restarts a
   *  pod. */
  const syncAll = async (): Promise<void> => {
    for (const [name, a] of wired) {
    const sources = (a.cfg.secondbrain ?? []).map((s) => ({
      id: s.id,
      label: s.label,
      repoUrl: s.repo_url,
      branch: s.branch,
      subpath: s.subpath,
      authKind: s.auth_kind,
      secretRef: s.secret_ref,
      readOnly: s.read_only,
    }));
      if (sources.length === 0) continue;
      const ready = await secondbrain
        .sync(sources, {
          root: path.join(process.env.TONOMAN_STATE_ROOT ?? "/root/.tonoman", "secondbrain", name),
          resolveRef,
          // Quiet on the timer: one line per source per minute is noise, and a failure still logs.
          log: (s) => {
            if (!a.context || /failed/.test(s)) console.log(s);
          },
        })
        .catch((e) => {
          console.error(`worker: ${name} second-brain sync failed: ${(e as Error).message}`);
          return [] as { dir: string; label: string }[];
        });
      a.context = secondbrain.contextNote(ready);
    }
  };

  await syncAll();
  const syncEvery = Number(process.env.SECONDBRAIN_SYNC_SECONDS ?? 60) * 1000;
  const syncTimer = setInterval(() => {
    void syncAll().catch(() => {});
  }, syncEvery);
  signal.addEventListener("abort", () => clearInterval(syncTimer), { once: true });

  const deps = { agent: (name: string) => wired.get(name) };
  const activities = makeActivities(deps);

  // The agent asks for its OWN credential, through its own runtime. The login endpoints live in
  // the sidecar sharing this pod's credential volume, so the code goes from a Slack modal to the
  // process that owns the credential and nowhere else — it never transits the control plane.
  const authBase = process.env.AGENT_RUNTIME_URL ?? "http://127.0.0.1:8080";
  const authDeps: gate.AuthGateDeps = {
    ops: (name) => (wired.has(name) ? httpAuthOps(authBase, process.env.AGENT_RUNTIME_TOKEN) : undefined),
    conn: (name) => wired.get(name)?.conn as SlackConnector | undefined,
    setAuthState: async (name, state) => {
      const a = wired.get(name);
      const api = process.env.TONOMANCLOUD_API_URL;
      if (!a?.cfg.guid || !api) return; // a file roster has no registry to tell
      const r = await fetch(`${api}/v1/system/agents/${a.cfg.guid}/auth-state`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${process.env.TONOMANCLOUD_API_TOKEN ?? ""}`,
        },
        body: JSON.stringify({ authState: state }),
      });
      if (!r.ok) throw new Error(`auth-state ${r.status}`);
      // Reflect it locally too, so the very next message is not gated again while the roster
      // cache is still warm.
      a.cfg.auth_state = state === "ok" ? "ok" : "error";
      console.log(`worker: ${name} auth_state -> ${state}`);
    },
  };

  // Interactions are wired per connector below, at construction.
  for (const [name, a] of wired) {
    (a.conn as SlackConnector).setInteractionHandler?.((it) => {
      void gate
        .handleInteraction(authDeps, name, it)
        .then((msg) => console.log(`worker: ${name} interaction — ${msg}`))
        .catch((e) => console.error(`worker: ${name} interaction failed: ${(e as Error).message}`));
    });
  }

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
          // The registry says this agent has no working inference, so there is nothing to run.
          // Ask in the channel instead of spending a turn to discover the same thing — and ask
          // because of a FACT about the agent, not because a file was missing.
          if (a.cfg.auth_state && a.cfg.auth_state !== "ok") {
            const asked = await gate.ask(authDeps, name, a.cfg.name ?? name, env.conversation).catch((e) => {
              console.error(`worker: auth prompt failed for ${name}: ${(e as Error).message}`);
              return false;
            });
            if (asked) console.log(`worker: ${name} asked for an inference login (auth_state=${a.cfg.auth_state})`);
            continue;
          }
          const first: Inbound = { text: env.text, user: env.user, ts: String(Date.now()) };
          try {
            // One call whether or not the conversation is already running. Temporal serializes
            // signals per workflow id, so ordering is free and two people typing at once cannot
            // interleave two turns.
            // `first` is deliberately NOT in args. signalWithStart on a workflow that does not yet
            // exist does BOTH things: it starts the workflow with `args` and delivers the signal.
            // Passing the message in both places queued it twice and answered every first message
            // of a conversation twice — observed, not theorised. The signal is the only carrier.
            await client.workflow.signalWithStart(conversationWorkflow, {
              workflowId: `${name}:${env.channel}:${env.conversation}`,
              taskQueue: o.taskQueue,
              args: [{ agent: name, conversation: env.conversation, channel: env.channel }],
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
