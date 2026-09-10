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

import { Client, Connection, ScheduleOverlapPolicy } from "@temporalio/client";
import type { Duration } from "@temporalio/common";
import { NativeConnection, Worker } from "@temporalio/worker";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import type { Config, AgentConfig } from "../config";
import type { Connector, TurnEvent, TurnRunner, TurnUsage } from "../core/contracts";
import { SlackConnector } from "../connector/slack";
import * as cmds from "./commands";
import * as plaudcli from "./plaudcli";
import * as claudecode from "../harness/claudecode";
import * as plaudauth from "./plaudauth";
import * as tokenstore from "./tokenstore";
import * as plaudgate from "./plaudgate";
import * as icsgate from "./icsgate";
import {
  parseStatusMode,
  remoteAccountUsageCached,
  renderStatus,
  type StatusMode,
  type UsageWindow,
} from "../statusline";
import { httpAuthOps } from "../authflow";
import * as gate from "./authgate";
import * as secondbrain from "./secondbrain";
import * as recapFloor from "./recap";
import { describe as describeVoice, voiceSettings } from "./flowcfg";
import * as flowcfg from "./flowcfg";
import * as inference from "./inference";
import * as calendar from "./calendar";
import { serveWake } from "./wake";
import { promises as fsp } from "node:fs";
import { defaultHarnesses } from "../gateway";
import { makeActivities, type TurnRunReq, type VoiceConfig } from "./activities";
import type { Step } from "./skill";
import { conversationWorkflow, messageSignal, plaudPollWorkflow, type Inbound, type PollInput } from "./workflows";
import { planReload } from "./reload";

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
    // Where Temporal loads the workflow code from. It defaults beside this file, which is right in
    // the image — `dist/worker/workflows.js` sits next to `dist/worker/worker.js`.
    //
    // Running from SOURCE it is wrong: the sibling is `workflows.ts`, and Temporal's bundler is
    // handed a path that does not exist. That failure reads as a Temporal problem rather than as a
    // path one, so this is an env var rather than something to rediscover.
    workflowsPath: env.TEMPORAL_WORKFLOWS_PATH || undefined,
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

const GROQ_V1 = "https://api.groq.com/openai/v1";
const trimSlash = (u: string): string => u.replace(/[/]+$/, "");

/** The registry's provider rows, with each key ref resolved. The ONLY place a ref becomes a
 *  credential, which is what lets `providerSpecs` stay pure.
 *
 *  A row whose `key_ref` is named but resolves to nothing is DROPPED, not sent unauthenticated. An
 *  unmounted secret is a deployment fault, and turning it into a 401 from Groq spends an attempt to
 *  produce a message that blames the wrong thing. */
async function providersFrom(specs: flowcfg.ProviderSpec[], who: string): Promise<inference.Provider[]> {
  const out: inference.Provider[] = [];
  for (const sp of specs) {
    const apiKey = sp.keyRef ? await resolveRef(sp.keyRef) : "";
    if (sp.keyRef && !apiKey) {
      console.log(`worker: ${who} provider ${sp.name} skipped — ${sp.keyRef} is empty or unmounted`);
      continue;
    }
    out.push({
      name: sp.name,
      baseUrl: sp.url,
      model: sp.model,
      apiKey: apiKey || undefined,
      timeoutMs: sp.timeoutMs,
      maxChars: sp.maxChars,
      biasesWithPrompt: sp.biases,
    });
  }
  return out;
}

/** What a tenant with no provider rows gets. GROQ, AND GROQ ONLY.
 *
 *  This is the line where a product differs from one person's setup. A local server at
 *  `host.containers.internal:8181` is meaningful on exactly one laptop, resolves nowhere in a
 *  cluster, and would be somebody else's meetings going to a machine they have never heard of — so
 *  it is included only when a deployment explicitly names one, and a tenant that wants it puts it
 *  in its own rows. */
function envTranscribe(env: NodeJS.ProcessEnv): inference.Provider[] {
  const model = env.GROQ_MODEL || "whisper-large-v3-turbo";
  const out: inference.Provider[] = [];
  // A SECOND key is not redundancy for its own sake: a rotated or exhausted first key otherwise
  // kills every meeting while a working key sits unused in the same deployment.
  for (const [name, apiKey] of [
    ["groq", env.GROQ_API_KEY],
    ["groq-2", env.GROQ_API_KEY_2],
  ] as const) {
    if (apiKey) out.push({ name, baseUrl: GROQ_V1, model, apiKey, biasesWithPrompt: true });
  }
  if (env.WHISPER_LOCAL_URL) {
    out.push({
      name: env.WHISPER_LOCAL_NAME || "local-whisper",
      baseUrl: trimSlash(env.WHISPER_LOCAL_URL),
      model: env.WHISPER_LOCAL_MODEL || "whisper-1",
      // faster-whisper's OpenAI-compatible server accepts `prompt` and ignores it. Saying so here is
      // what stops the recap page claiming a vocabulary-corrected transcript it never got.
      biasesWithPrompt: false,
    });
  }
  return out;
}

/** Who summarises. A SEPARATE list from transcription, because the constraint is different: the
 *  transcription tier's 8000-token context cannot summarise a 62-minute meeting at any price, and
 *  that is the 413 that made yesterday's longest recordings impossible rather than slow.
 *
 *  Groq stays BEHIND whatever is configured, so a deployment that sets nothing keeps working
 *  exactly as it did. */
function envSummarize(env: NodeJS.ProcessEnv): inference.Provider[] {
  const out: inference.Provider[] = [];
  if (env.SUMMARY_BASE_URL && env.SUMMARY_MODEL) {
    out.push({
      name: env.SUMMARY_NAME || "summary",
      baseUrl: trimSlash(env.SUMMARY_BASE_URL),
      model: env.SUMMARY_MODEL,
      apiKey: env.SUMMARY_API_KEY || undefined,
    });
  }
  if (env.GROQ_API_KEY) {
    out.push({
      name: "groq",
      baseUrl: GROQ_V1,
      model: env.GROQ_TEXT_MODEL || "openai/gpt-oss-120b",
      apiKey: env.GROQ_API_KEY,
    });
  }
  return out;
}

/**
 * One credential out of the registry, by ref, as a raw string.
 *
 * `resolveRef` reads a MOUNTED Kubernetes secret, which is the arrangement customer credentials
 * were moved off — a path is a property of the pod, and one pod serves every tenant it has agents
 * for. A connection's `secret_ref` names a row in the registry's `secret` table instead, and the
 * decryption happens on the far side of this call: the worker never holds the key.
 *
 * Empty rather than throwing. A connection whose credential cannot be read is one calendar that
 * will not match, and the recap still has to be filed.
 */
async function registrySecret(guid: string | undefined, ref: string | undefined): Promise<string> {
  const baseUrl = process.env.TONOMANCLOUD_API_URL;
  if (!baseUrl || !guid || !ref) return "";
  try {
    const r = await fetch(`${baseUrl}/v1/system/agents/${guid}/secrets/${encodeURIComponent(ref)}`, {
      headers: { authorization: `Bearer ${process.env.TONOMANCLOUD_API_TOKEN ?? ""}` },
    });
    // 404 is "not connected", which is a state rather than a failure. Anything else is worth a line
    // — a 500 here means the KEK is wrong or the row is unreadable, and silently treating that as
    // "no calendar" would hide a real fault behind a plausible absence.
    if (r.status === 404) return "";
    if (!r.ok) {
      console.error(`registry: secret ${ref} for ${guid} returned HTTP ${r.status}`);
      return "";
    }
    const j = (await r.json()) as { value?: string };
    return j.value ?? "";
  } catch (e) {
    console.error(`registry: secret ${ref} for ${guid} failed — ${(e as Error).message}`);
    return "";
  }
}

/** Tools withheld from every turn this worker runs.
 *
 *  The default is not empty, deliberately. The pod is the sandbox AND it holds the credential that
 *  buys the inference, so anything that can execute or write is a way for a customer-facing turn to
 *  reach the platform's own secrets. Reading and searching are what a second brain needs; a shell
 *  is not. Override with CLAUDE_CODE_DISALLOWED_TOOLS when an agent genuinely needs more, and
 *  understand what is being handed over. */
const DEFAULT_DISALLOWED = ["Bash", "Write", "Edit", "NotebookEdit", "WebFetch", "Task"];

function disallowedTools(): string[] {
  const env = (process.env.CLAUDE_CODE_DISALLOWED_TOOLS ?? "").trim();
  if (!env) return DEFAULT_DISALLOWED;
  // An explicit "none" is how an operator says they mean it, rather than an empty string that
  // could just as easily be an unset variable.
  if (env.toLowerCase() === "none") return [];
  return env.split(",").map((s) => s.trim()).filter(Boolean);
}

/** One wired agent: the roster row, its channel, its harness, and the second-brain note the turn
 *  is given. The runner is kept alongside `run` because the model knob (`!model`) lives on it. */
interface Wired {
  cfg: AgentConfig;
  conn: Connector;
  context?: string;
  runner: TurnRunner;
  run: (r: TurnRunReq) => AsyncIterable<TurnEvent>;
  /** Stops THIS agent's ingress pump on its own, chained to the worker-wide signal so shutdown still
   *  stops everything. Live reload aborts it to retire a removed agent's connector without touching
   *  any other; undefined until the pump is started. */
  abort?: AbortController;
}

/** The human-facing name for an agent whose stable key (`cfg.name`) is now a guid: the tenant-
 *  prefixed display name a person reads in a log or types into TONOMAN_AGENTS. Falls back to the
 *  bare name for a file roster with no tenant. */
function agentLabel(a: AgentConfig): string {
  return a.tenant ? `${a.tenant}-${a.displayName ?? a.name}` : (a.displayName ?? a.name);
}

/** Builds one connector + runner per agent in the roster. An agent whose channel has no connector
 *  is skipped with a reason rather than failing the worker — one bad row must not silence the rest. */
/** PURE: which agents this process is willing to serve.
 *
 *  Empty means all of them, which is every deployment today. A list means THIS worker takes only
 *  those, and it exists for one reason: to make a worker runnable on a laptop against the real
 *  cluster without stealing another tenant's agent.
 *
 *  Two workers cannot share an agent. Slack delivers a Socket Mode event to exactly ONE of the
 *  connections holding that app token, so two processes with the same agent answer alternately and
 *  unpredictably — which looks like a flaky bug rather than like two workers. Splitting by agent is
 *  what makes "run the one I am changing locally, leave the customer's on the cluster" safe rather
 *  than a coin flip.
 *
 *  Names are the tenant-prefixed display names — `axiplex-sapien`, `murphy-nelly` — because that is
 *  what the logs say and what somebody will copy. `wire()` also matches an agent's guid and its bare
 *  display name, so the guid a boot log prints works here too. */
export function agentsAllowed(names: string | undefined): Set<string> {
  return new Set(
    (names ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** Build a new runner for one agent. Split out because live reload rebuilds a runner in place — when
 *  `max_turns` or the runtime `url` changes, both of which the harness bakes in at construction — while
 *  keeping the agent's connector, so no socket reconnects. */
function newRunnerFor(a: AgentConfig, harnesses: ReturnType<typeof defaultHarnesses>): TurnRunner | null {
  const spec = harnesses.lookup(a.harness ?? "claude-code");
  if (!spec?.newRunner) return null;
  // No container: the pod is the sandbox (an agent is a row, not a container).
  //
  // And because the pod is the sandbox, the tools it hands the model are the security boundary.
  // This pod holds the operator's Claude subscription credential, so a shell here can read the
  // account behind it — which is exactly what happened: asked who it was talking to, the agent
  // ran Bash, found the operator's email in the runtime, and told a customer about it. An agent
  // that answers from meetings and notes has no use for a shell anyway.
  return spec.newRunner({
    agent: a.name,
    container: a.container,
    model: a.model,
    maxTurns: a.max_turns,
    url: a.url,
    disallowedTools: disallowedTools(),
  });
}

/** Wrap a runner in the `run` closure the ingress uses — the model comes per turn (`!model`), so a
 *  reload that changes only the default model never has to touch the runner. */
function runClosure(runner: TurnRunner): Wired["run"] {
  return (r: TurnRunReq, signal?: AbortSignal) =>
    runner.run(
      {
        prompt: r.prompt,
        systemPromptFile: r.systemPromptFile,
        model: r.model,
        sessionId: r.sessionId,
        sessionNew: r.sessionNew,
      },
      signal,
    );
}

/** Build the connector + runner for ONE agent, or return null with a logged reason. Shared by the
 *  boot wiring and by live reload (which wires a newly-added or structurally-changed agent), so the
 *  skip rules — channel, tokens, harness — are decided in exactly one place. The `only` filter is
 *  NOT here: it is a boot-time concern of `wire()`, and reload applies it separately. */
function wireOne(a: AgentConfig, harnesses: ReturnType<typeof defaultHarnesses>): Wired | null {
  const label = agentLabel(a);
  const channel = a.channel ?? (a.slack ? "slack" : a.teams ? "teams" : "telegram");
  if (channel !== "slack") {
    console.error(`worker: skipping ${label} — channel "${channel}" has no worker connector yet`);
    return null;
  }
  const appToken = a.slack?.app_token || process.env.SLACK_APP_TOKEN || "";
  const botToken = a.slack?.bot_token || process.env.SLACK_BOT_TOKEN || "";
  if (!appToken || !botToken) {
    console.error(`worker: skipping ${label} — missing ${!botToken ? "bot" : "app"} token`);
    return null;
  }
  const conn = new SlackConnector({ appToken, botToken, allowedUsers: a.slack?.allowed_users });

  const runner = newRunnerFor(a, harnesses);
  if (!runner) {
    console.error(`worker: skipping ${label} — harness "${a.harness}" cannot run turns`);
    return null;
  }
  return { cfg: a, conn, runner, run: runClosure(runner) };
}

function wire(cfg: Config, only: Set<string> = new Set()): Map<string, Wired> {
  const harnesses = defaultHarnesses();
  const out = new Map<string, Wired>();
  for (const a of cfg.agents ?? []) {
    // `a.name` is now the stable guid (registry roster). What a person reads in a log or types into
    // TONOMAN_AGENTS is the tenant-prefixed display name (`label`) while the machine keys off `a.name`.
    const label = agentLabel(a);
    if (
      only.size > 0 &&
      !only.has(a.name.toLowerCase()) &&
      !only.has(label.toLowerCase()) &&
      !only.has((a.displayName ?? "").toLowerCase())
    ) {
      // Said out loud rather than skipped quietly: "why is my agent not answering" is otherwise
      // answered only by remembering an environment variable somebody set days ago.
      console.log(`worker: not serving ${label} — TONOMAN_AGENTS does not list it`);
      continue;
    }
    const w = wireOne(a, harnesses);
    if (w) out.set(a.name, w);
  }
  return out;
}

/** The harness session each conversation is continuing in.
 *
 *  Keyed by AGENT and conversation, not by conversation alone. A Slack conversation key is a thread
 *  timestamp: unique inside one workspace and nowhere else — and this worker serves two tenants in
 *  two different workspaces. Keyed by the thread alone, Sapien would eventually resume Nelly's
 *  conversation, which is the same shape of mistake as a worker-wide notify channel, with a
 *  customer's transcript on the other end of it.
 *
 *  In memory, deliberately. The session's transcript is a file on THIS pod's disk, so the id and
 *  the thing it names have one lifetime; persisting the id would only outlive the file it points
 *  at, and turn a restart from "forgets" into "fails". What it costs is memory across a deploy —
 *  the next message in a thread starts fresh, which is exactly today's behaviour and no worse. */
export function sessionStore(
  dir: string = path.join(process.env.TONOMAN_STATE_ROOT ?? "/root/.tonoman", "sessions"),
  newId: () => string = randomUUID,
): {
  claim: (agent: string, conversation: string) => Promise<{ id: string; isNew: boolean }>;
  reset: (agent: string, conversation: string) => Promise<{ id: string; isNew: boolean }>;
} {
  /** One file per conversation, under the agent that owns it — which is also what keeps two agents
   *  in two workspaces from colliding on a thread timestamp that is only unique within one of
   *  them. The conversation key is encoded because it contains `/`. */
  const fileFor = (agent: string, conversation: string): string =>
    path.join(dir, encodeURIComponent(agent), `${encodeURIComponent(conversation)}.json`);

  /** Hand out this conversation's session AND record that it is now in use — so `--session-id`
   *  (create) is used exactly once per id and every later turn resumes it. Claiming rather than
   *  peeking is what keeps that invariant true even for a turn that dies before writing anything;
   *  the resume miss that follows is repairable, a duplicate create is not. */
  const claim = async (agent: string, conversation: string): Promise<{ id: string; isNew: boolean }> => {
    const f = fileFor(agent, conversation);
    try {
      const j = JSON.parse(await fsp.readFile(f, "utf8")) as { uuid?: string };
      if (j.uuid) return { id: j.uuid, isNew: false };
    } catch {
      /* no pointer yet, or an unreadable one → mint a new session rather than fail the turn */
    }
    const made = { id: newId(), isNew: true };
    try {
      await fsp.mkdir(path.dirname(f), { recursive: true });
      await fsp.writeFile(f, JSON.stringify({ uuid: made.id, started: true }), "utf8");
    } catch (e) {
      // A pointer we could not persist is this pod's problem only: the turn still runs, and the
      // next one starts a fresh session. Losing memory is the old behaviour; losing the turn is
      // not, so this never throws.
      console.error(`worker: could not persist session for ${agent} — ${(e as Error).message}`);
    }
    return made;
  };
  return {
    claim,
    /** Abandon this conversation's session and hand back a fresh one — the resume-miss repair, and
     *  what `!new` does. The transcript itself is left alone; it is simply no longer continued. */
    reset: async (agent: string, conversation: string) => {
      await fsp.rm(fileFor(agent, conversation), { force: true }).catch(() => {});
      return claim(agent, conversation);
    },
  };
}

export async function run(
  cfg: Config,
  o: WorkerOptions,
  signal: AbortSignal,
  /** Re-fetch the roster from the same control plane the boot used, applying the same env overrides.
   *  Provided by the CLI; when absent (a test, or a caller that opts out) the worker serves the boot
   *  roster forever, exactly as it did before live reload. */
  reloadRoster?: () => Promise<Config>,
): Promise<void> {
  const only = agentsAllowed(process.env.TONOMAN_AGENTS);
  if (only.size > 0) {
    console.log(`worker: serving only ${[...only].join(", ")} (TONOMAN_AGENTS)`);
  }
  const wired = wire(cfg, only);
  if (wired.size === 0) {
    // Loudly: a worker with no connectors looks perfectly healthy while answering nobody.
    console.error("worker: NO agents have a usable channel binding — nothing will be answered.");
  }

  // Where connected-account credentials live, decided once, here. Cloud when there is a registry
  // to talk to; the volume otherwise, so a self-hosted install does not change by upgrading.
  //
  // The guid lookup is the whole reason this is installed at boot rather than resolved per call:
  // the API addresses secrets by agent and derives the TENANT itself, so a worker can never name a
  // tenant it does not belong to. An agent with no guid has no registry, and falls through to the
  // volume rather than failing.
  const store = tokenstore.chooseStore(process.env, (name) => wired.get(name)?.cfg.guid);
  tokenstore.useStore(store);
  console.log(`worker: connected-account credentials live in ${store.where}`);

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
      a.context = secondbrain.contextNote(
        ready,
        a.cfg.timezone ?? "UTC",
        (a.cfg.connections ?? []).map((c) => ({
          kind: c.kind,
          alias: c.alias,
          label: c.label,
          status: c.status,
        })),
        a.cfg.displayName ?? "",
      );
    }
  };

  await syncAll();
  const syncEvery = Number(process.env.SECONDBRAIN_SYNC_SECONDS ?? 60) * 1000;
  // One sync at a time. A first clone of a large wiki takes longer than the interval, so the timer
  // fired again into a checkout git was still building and the two processes collided on
  // `.git/shallow.lock` — reported as "failed to sync" for a repository that was in fact fine.
  // Skipping a tick is free; the next one is a minute away.
  // One background mutation of `wired` at a time. syncAll clones checkouts and reads `a.cfg`; reload
  // (below) swaps `a.cfg` and rebuilds runners. Sharing one flag keeps a reload from swapping config
  // out from under a clone mid-iteration, and keeps two clones off the same `.git/shallow.lock` (the
  // collision that first taught the guard). A skipped tick is free; the next is a minute away.
  let busy = false;
  const syncTimer = setInterval(() => {
    if (busy) return;
    busy = true;
    void syncAll()
      .catch(() => {})
      .finally(() => {
        busy = false;
      });
  }, syncEvery);
  signal.addEventListener("abort", () => clearInterval(syncTimer), { once: true });

  // Open (or reuse) a DM and return the connector's conversation key. Shared by the wake endpoint
  // and by the voice flow — both need to address a person the agent has no inbound message from.
  const dmFor = async (name: string, userId: string): Promise<string | undefined> => {
    const a = wired.get(name);
    if (!a) return undefined;
    const j = await (a.conn as SlackConnector).call<{ channel?: { id?: string } }>("conversations.open", {
      users: userId,
    });
    const channel = j.channel?.id;
    return channel ? `${a.cfg.slack?.team_id ?? ""}/${channel}` : undefined;
  };

  // The Temporal client is needed by the activities (a woken turn is a signal), so it is created
  // before them rather than alongside the worker.
  const conn = await Connection.connect({ address: o.address });
  const client = new Client({ connection: conn, namespace: o.namespace });

  // The git push credential, resolved once at boot. Held in memory only; the checkout's remote on
  // disk stays credential-free.
  const voiceCreds = new Map<string, VoiceConfig>();
  /** Agents whose voice flow is off, so their schedule can be paused rather than left ticking. */
  const disabledFlows = new Set<string>();
  /** Work out one agent's voice configuration and record it, or say plainly why there is none.
   *
   *  A FUNCTION, not the body of the boot loop it used to be, because connecting an account is not
   *  a boot-time event. `!connect plaud` wrote a credential nine hours after this had already run,
   *  answered "connected", and then nothing polled: the flow had been filed under "waiting for a
   *  login" at boot and there was no second look until the process restarted. In the cluster that
   *  reads as a customer connecting their account and hearing nothing until the next deploy.
   *
   *  So the connect path calls this too. Idempotent by construction — it only writes the two
   *  collections above. */
  async function wireVoice(name: string, a: Wired): Promise<void> {
    // A recompute, not an accumulation: this runs again when an account is connected, and an
    // agent that has just stopped being "waiting for a login" must not stay in disabledFlows.
    voiceCreds.delete(name);
    disabledFlows.delete(name);
    const src = a.cfg.secondbrain?.[0];
    // Per agent, from the REGISTRY: which channel, which folder, which routes. The environment is
    // only a fallback for a tenant that has no rows yet — a deployment is the wrong place for
    // "where do Celine's meetings go".
    const voice = voiceSettings(a.cfg.flows?.voice, process.env);
    if (!voice.enabled) {
      console.log(`worker: ${name} voice flow is switched off (flow_property enabled=false)`);
      // Switching the flow off has to switch the SCHEDULE off. Left running it keeps firing into an
      // agent with no voice configuration — harmless, because the activity finds nothing to do, but
      // it fills the schedule list with executions that look like work and reports "off" in one
      // place while ticking in another.
      disabledFlows.add(name);
      return;
    }
    // Whose Plaud account this agent watches — from the registry, per tenant. An agent with no
    // credential is not misconfigured; it is a tenant whose person has not logged in yet, and
    // saying that plainly is the difference between "waiting for Celine" and "broken".
    const tokenJson = await resolveRef(voice.credentialRef);
    // Either credential counts. An agent that connected its own account through !connect needs no
    // mounted secret at all — which is the whole point of the connect flow, and the state every
    // tenant should end up in.
    const viaCli = await plaudcli.connected(name);
    if (!tokenJson && !viaCli) {
      console.log(
        `worker: ${name} voice flow is waiting for a Plaud login` +
          `${voice.credentialRef ? ` (credential ${voice.credentialRef} is empty or unmounted)` : " (no credential_ref row)"}`,
      );
      disabledFlows.add(name);
      return;
    }
    // WHO transcribes and WHO summarises, per tenant. Registry rows win outright; the environment
    // is the fallback for a tenant that has no rows yet. That order is the whole point: a
    // deployment stops being where "which model hears my meetings" lives.
    const rows = a.cfg.flows?.voice ?? {};
    const rowTranscribe = flowcfg.providerSpecs(rows, "transcribe");
    const rowSummarize = flowcfg.providerSpecs(rows, "summarize");
    const transcribe = rowTranscribe.length
      ? await providersFrom(rowTranscribe, name)
      : envTranscribe(process.env);
    const summarize = rowSummarize.length ? await providersFrom(rowSummarize, name) : envSummarize(process.env);
    if (transcribe.length === 0 || !src) {
      console.log(
        `worker: ${name} has no voice flow (needs a transcription provider — transcribe.* rows or GROQ_API_KEY — and a second-brain source)`,
      );
      return;
    }
    if (summarize.length === 0) {
      console.log(`worker: ${name} has no voice flow (needs a summariser — summarize.* rows or GROQ_API_KEY)`);
      return;
    }
    console.log(
      `worker: ${name} voice inference — transcribe ${transcribe.map((x) => x.name).join(" → ")}` +
        `, summarize ${summarize.map((x) => x.name).join(" → ")}`,
    );
    // How far back the poll may reach. "Not in the second brain" is NOT the same question as
    // "should be transcribed": without a floor the first poll backfills the customer's entire
    // Plaud history and announces each old meeting in Slack as if it had just happened.
    // Unset means "from today onwards" in the pod's own timezone, which is what switching the
    // feature on is meant to mean.
    // THE TENANT'S timezone, not the pod's. `-new Date().getTimezoneOffset()` read the worker's own
    // clock, so one pod's timezone silently decided what "from today onwards" meant for every
    // tenant on it — a deployment-wide default standing in for a customer's fact, which is exactly
    // the pattern this product exists to delete.
    const tzOffset = recapFloor.offsetMinutesFor(a.cfg.timezone ?? "UTC", Date.now());
    const floorMs = recapFloor.floorFor(voice.since || undefined, Date.now(), tzOffset);
    // Calendars this agent has been granted. `(kind, alias)` is the identity: the KIND is what
    // the platform knows how to read, the ALIAS is which one of them this is — so a work calendar
    // and a personal one coexist without either becoming a second connector.
    //
    // Only `connected` ones, and only those whose URL actually resolves. A calendar listed but
    // unreadable must not silently become "no calendar": it is logged by alias, never by URL,
    // because a published feed's link IS its credential.
    const calendars: calendar.CalendarFeed[] = [];
    for (const c of a.cfg.connections ?? []) {
      if (c.kind !== "ics") continue; // google and outlook arrive with the OAuth callback
      if (c.status && c.status !== "connected") {
        console.log(`worker: ${name} calendar ${c.kind}/${c.alias} is ${c.status}, skipping`);
        continue;
      }
      const url = await registrySecret(a.cfg.guid, c.secret_ref);
      if (!url) {
        console.log(`worker: ${name} calendar ${c.kind}/${c.alias} has no readable URL, skipping`);
        continue;
      }
      calendars.push({ kind: c.kind, alias: c.alias, url });
    }

    const token = await resolveRef(src.secret_ref);
    const pushUrl = token ? src.repo_url.replace("https://", `https://x-access-token:${token}@`) : src.repo_url;
    const dir = path.join(process.env.TONOMAN_STATE_ROOT ?? "/root/.tonoman", "secondbrain", name, src.id);
    // The granted skill that drives the voice flow, if any — the one whose trigger polls Plaud. The
    // steps and version are pinned here, off the roster, so a run started tonight keeps interpreting
    // the definition it began with even if the row is edited under it. Absent = this agent has no
    // voice skill granted, and `runner: skill` will fall back to hardcoded rather than do nothing.
    const voiceSkill = (a.cfg.skills ?? []).find(
      (s) => (s.trigger as { poll?: unknown } | undefined)?.poll === "plaud",
    );
    voiceCreds.set(name, {
      notifyChannel: voice.notifyChannel || undefined,
      notifyUser: voice.notifyUser || undefined,
      journal: voice.journal,
      pollSeconds: voice.pollSeconds,
      // An agent that has connected its own account through !connect reads from the third-party
      // API; one that has not is still on the mounted bearer. Per agent, so the two tenants can be
      // on different halves of this migration at the same time.
      creds: { tokenJson, cliAgent: viaCli ? name : undefined },
      calendars,
      calendarExclude: (voice.calendarExclude ?? []).filter(Boolean),
      calendarPadMinutes: voice.calendarPadMinutes,
      brainDir: src.subpath ? path.join(dir, src.subpath) : dir,
      // The state volume, not /tmp: a retry that resumes has to survive a pod restart, and /tmp in
      // a container does not. Per agent, because a recording id is only unique within an account.
      chunkCacheDir: path.join(process.env.TONOMAN_STATE_ROOT ?? "/root/.tonoman", "chunks", name),
      pushUrl,
      transcribe,
      summarize,
      // From the registry, per tenant. The roster already carries it, so this is not a second
      // round trip that can be stale on its own.
      mission: a.cfg.mission ?? "",
      timezone: a.cfg.timezone ?? "UTC",
      // Which runtime, and the skill to run when it is the interpreter. Default hardcoded (from
      // flowcfg), so the proven pipeline stays in charge until a tenant is deliberately armed.
      runner: voice.runner,
      skill: voiceSkill
        ? { name: voiceSkill.name, steps: voiceSkill.steps as Step[], version: voiceSkill.version }
        : undefined,
      floorMs,
      vocab:
        process.env.GROQ_PROMPT ??
        "Tonoman, Tonoman Cloud, Plaud, Murphy Business Sales, Celine, Rod Navarro, Axiplex, agentic AI, Slack, Temporal.",
    });
    console.log(
      // A connected account IS a credential, so the line must not still read "waiting for a login"
      // for an agent that is about to start polling. A flow reporting the opposite of what it is
      // doing is the failure mode this whole boot line exists to prevent.
      `worker: ${name} voice flow ready — ${describeVoice(viaCli ? { ...voice, credentialRef: `plaud-cli:${name}` } : voice)}` +
        `${viaCli ? " [connected account]" : ""}; ` +
        `brain at ${dir}; only recordings from ${new Date(floorMs).toISOString()} onwards` +
        // Said out loud, because a flow with no calendar and a flow whose calendar failed to
        // resolve look identical from the outside and are entirely different problems.
        (calendars.length
          ? `; calendars: ${calendars.map((c) => `${c.kind}/${c.alias}`).join(", ")}`
          : "; no calendars attached"),
    );
  }

  for (const [name, a] of wired) await wireVoice(name, a);

  // --- the status bar -------------------------------------------------------------------------
  // Per-turn tokens and context occupancy come from the harness result; the 5h/7d windows are the
  // Claude subscription's own account-wide numbers, which only the process HOLDING the credential
  // can read. In this split that process is the auth sidecar sharing /root/.claude, so we ask it
  // over loopback (`GET /usage`) rather than reading the credential here. The podman-exec path in
  // statusline.ts is for the single-machine deployment and has no podman to exec in a pod.
  const runtimeUrl = process.env.AGENT_RUNTIME_URL ?? "http://127.0.0.1:8080";
  const runtimeToken = process.env.AGENT_RUNTIME_TOKEN;
  const windowsFor = (name: string): Promise<UsageWindow[]> =>
    remoteAccountUsageCached(`agent:${name}`, runtimeUrl, runtimeToken, undefined, undefined, name);

  /** The footer mode, per conversation. Process-local and deliberately so: it is a display
   *  preference for a thread somebody is looking at right now, not a fact about the tenant. */
  const statusModes = new Map<string, StatusMode>();
  const defaultMode: StatusMode = parseStatusMode(process.env.TONOMAN_STATUSLINE ?? "") ?? "small";
  const modeFor = (conversation: string): StatusMode => statusModes.get(conversation) ?? defaultMode;
  /** The last turn's usage per conversation, so `!status` can report it without spending a turn. */
  const lastUsage = new Map<string, TurnUsage>();
  /** The model each conversation has chosen. Per conversation, NOT per process: this worker serves
   *  every agent in the tenant and every thread they are in, and the harness's own knob is a single
   *  variable — so `!model opus` in one thread moved everyone. */
  const models = new Map<string, string>();
  const { claim: claimSession, reset: resetSession } = sessionStore();

  /** Where THIS agent's voice flow speaks: its configured channel, else a DM with the recipient.
   *
   *  A channel because a recap is team news; a DM makes it one person's news that everyone else has
   *  to be told about again — and from the outside there is no way to tell whether it went to Rod
   *  or to Celine. */
  const voiceConversation = async (name: string, user: string): Promise<string | undefined> => {
    const a = wired.get(name);
    if (!a) return undefined;
    const channel = voiceCreds.get(name)?.notifyChannel;
    if (channel) return `${a.cfg.slack?.team_id ?? ""}/${channel}`;
    return dmFor(name, user);
  };

  const deps = {
    agent: (name: string) => wired.get(name),
    voice: (name: string) => voiceCreds.get(name),
    recordUsage: (conversation: string, u: TurnUsage) => lastUsage.set(conversation, u),
    modelFor: (conversation: string) => models.get(conversation),
    claimSession,
    resetSession,
    footer: async (name: string, conversation: string, u: TurnUsage | undefined): Promise<string | null> => {
      const mode = modeFor(conversation);
      if (mode === "none" || !u) return null;
      // The windows are cached for two minutes, so this is a fetch at most once per window per
      // agent — an answer must never wait on the usage API to be delivered.
      const windows = await windowsFor(name).catch(() => [] as UsageWindow[]);
      return renderStatus(mode, u, wired.get(name)?.runner.getModel?.(), windows, Date.now());
    },
    say: async (name: string, user: string, text: string) => {
      const conv = await voiceConversation(name, user);
      if (conv) await wired.get(name)?.conn.reply(conv).send(text);
    },
    ask: async (name: string, user: string, text: string) => {
      const conv = await voiceConversation(name, user);
      if (!conv) return;
      await client.workflow.signalWithStart(conversationWorkflow, {
        workflowId: `${name}:slack:${conv}`,
        taskQueue: o.taskQueue,
        args: [{ agent: name, conversation: conv, channel: "slack" }],
        signal: messageSignal,
        signalArgs: [{ text, user, ts: String(Date.now()) }],
      });
    },
    // The durable record of one item of one skill, over the same system-token API the worker uses
    // for everything else — the worker holds no database connection string.
    //
    // BEST-EFFORT, ALWAYS. This row is observability: it is what answers "is this failing, or has
    // nobody looked at it". A registry that is briefly unreachable must never be the reason a
    // recording is not processed, so every failure here is logged and swallowed — the run proceeds,
    // the row is simply missing. Dedup does not depend on it (the git checkout still answers "already
    // published"); this makes a failing run visible, which nothing did before.
    skillRun: {
      open: async (name: string, skillName: string, itemKey: string, version: number) => {
        const baseUrl = process.env.TONOMANCLOUD_API_URL;
        const guid = wired.get(name)?.cfg.guid;
        if (!baseUrl || !guid) return; // a file roster has no registry to record into
        try {
          const r = await fetch(`${baseUrl}/v1/system/agents/${guid}/skill-runs`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${process.env.TONOMANCLOUD_API_TOKEN ?? ""}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ skill: skillName, itemKey, version }),
          });
          if (!r.ok) console.error(`worker: ${name} skill_run open ${skillName}/${itemKey} → ${r.status}`);
        } catch (e) {
          console.error(`worker: ${name} skill_run open ${skillName}/${itemKey} failed: ${String(e)}`);
        }
      },
      close: async (
        name: string,
        skillName: string,
        itemKey: string,
        status: "done" | "failed",
        error?: string,
      ) => {
        const baseUrl = process.env.TONOMANCLOUD_API_URL;
        const guid = wired.get(name)?.cfg.guid;
        if (!baseUrl || !guid) return;
        try {
          const r = await fetch(`${baseUrl}/v1/system/agents/${guid}/skill-runs`, {
            method: "PATCH",
            headers: {
              authorization: `Bearer ${process.env.TONOMANCLOUD_API_TOKEN ?? ""}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ skill: skillName, itemKey, status, error }),
          });
          if (!r.ok) console.error(`worker: ${name} skill_run close ${skillName}/${itemKey} → ${r.status}`);
        } catch (e) {
          console.error(`worker: ${name} skill_run close ${skillName}/${itemKey} failed: ${String(e)}`);
        }
      },
    },
  };
  const activities = makeActivities(deps);

  // In-channel commands. They read and write the same maps the status footer uses, so what
  // `!status` reports is exactly what the footer would have shown.
  const commandDeps: cmds.CommandDeps = {
    // Straight off the roster this worker already holds, rather than a call back to the registry.
    // The roster IS the worker's view of an agent, and answering from anything else would let
    // `!connections` disagree with what the flow is actually using — which is precisely the
    // question somebody types it to settle.
    // Start a three-legged login. The registry owns the whole flow — it holds the client secret,
    // the pending state and the PKCE verifier, and it is what the provider redirects back to. The
    // worker's only job is to carry the URL into the channel, which is why nothing about Google or
    // Microsoft appears in this process at all.
    beginOauth: async (name, provider, alias, conversation) => {
      const baseUrl = process.env.TONOMANCLOUD_API_URL;
      const guid = wired.get(name)?.cfg.guid;
      if (!baseUrl || !guid) return { problem: "this deployment has no registry behind it" };
      try {
        const r = await fetch(`${baseUrl}/v1/system/agents/${guid}/oauth/${encodeURIComponent(provider)}/begin`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${process.env.TONOMANCLOUD_API_TOKEN ?? ""}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ alias, conversation }),
        });
        const j = (await r.json()) as { url?: string; error?: string; available?: string[] };
        if (!r.ok || !j.url) {
          // The registry's own words. It knows which providers are configured on this deployment
          // and this process does not, so paraphrasing would replace a specific answer with a vague
          // one — "Outlook isn't set up here" versus "that didn't work".
          const avail = j.available?.length ? ` (available: ${j.available.join(", ")})` : "";
          return { problem: `${j.error ?? `HTTP ${r.status}`}${avail}` };
        }
        return { url: j.url };
      } catch (e) {
        return { problem: (e as Error).message };
      }
    },
    connections: async (name) =>
      (wired.get(name)?.cfg.connections ?? []).map((c) => ({
        kind: c.kind,
        alias: c.alias,
        label: c.label,
        status: c.status,
        externalAccount: c.external_account,
      })),
    getMode: modeFor,
    setMode: (conversation, mode) => statusModes.set(conversation, mode),
    lastUsage: (conversation) => lastUsage.get(conversation),
    windows: windowsFor,
    // Which Claude account this agent is signed in as. Straight from `claude auth status` in the
    // agent's own credential directory, trimmed to its first line — the point is to make "whose
    // subscription is this?" answerable from Slack, which it has never been.
    claudeAccount: async (name) => {
      // `claude auth status` answers in JSON — { loggedIn, email, subscriptionType, ... } — so the
      // first line of it is "{". Parsed, not scanned: reading this as text printed a lone brace
      // into Slack, which told Rod nothing except that something was wrong.
      const ops = authDeps.ops(name);
      const raw = (await ops?.status?.().catch(() => "")) ?? "";
      try {
        const j = JSON.parse(raw) as { loggedIn?: boolean; email?: string; subscriptionType?: string };
        if (!j.loggedIn) return "not signed in";
        return [j.email, j.subscriptionType && `(${j.subscriptionType})`].filter(Boolean).join(" ") || "signed in";
      } catch {
        // A harness that answers in prose rather than JSON still gets to say something.
        return raw.split(/\r?\n/).find((l) => l.trim())?.slice(0, 120) ?? "";
      }
    },
    resetSession: (name, conversation) => void resetSession(name, conversation).catch(() => {}),
    plaudConnected: (name) => plaudcli.connected(name),
    // `!connect claude`, typed on purpose. The SAME offer the auth gate makes on its own when a
    // turn finds no credential - one mechanism, not two, so what a person is shown is identical
    // whether they asked for it or we volunteered it.
    //
    // This existed as `!disconnect claude` with no counterpart, which meant the notice told people
    // to send `!connect claude` and the command then said there was no such connector.
    connectClaude: async (name, conversation) => {
      const a = wired.get(name);
      if (!a) return "I don't know that agent here.";
      // ask() returns false both when it POSTED a reason and when there was nothing to post, and
      // those need different answers. The second case is exactly this one, checked here so the
      // command never ends in silence.
      if (!authDeps.ops(name)) return "I can't start a Claude login on this deployment.";
      await gate.ask(authDeps, name, a.cfg.name ?? name, conversation).catch((e) => {
        console.error(`worker: ${name} connect claude failed: ${(e as Error).message}`);
        return false;
      });
      // The blocks ARE the message; returning text as well would post the whole thing twice, and
      // ask() has already said why on the paths where it could not offer a login.
      return "";
    },
    // A published calendar address. The blocks ARE the message; see connectClaude.
    connectIcs: async (name, conversation) => {
      const asked = await icsgate.ask(icsDeps, name, conversation).catch((e) => {
        console.error(`worker: ${name} connect ics failed: ${(e as Error).message}`);
        return false;
      });
      return asked ? "" : "I can't post a dialog in this conversation.";
    },
    disconnectClaude: async (name) => {
      // Removing the credential IS the sign-out: the harness reads it from this directory on every
      // turn, so a deleted file means the next message finds no login and the connect gate offers
      // one. Only THIS agent's directory, so signing Nelly out never touches Sapien.
      const dir = claudecode.configHomeFor(name);
      await fsp.rm(path.join(dir, ".credentials.json"), { force: true }).catch(() => {});
      const a = wired.get(name);
      // So the gate offers a login on the very next message rather than after a restart.
      if (a) a.cfg.auth_state = "unconfigured";
      return "🔓 Signed out of Claude. Send me anything and I'll offer you a fresh login.";
    },
    disconnectPlaud: async (name) => {
      await plaudauth.disconnect(name);
      // And STOP POLLING. This used to end "the running flow finishes its current cycle first",
      // which was a polite way of saying the credential stayed resolved in memory until the next
      // restart — so a disconnected account kept being read, potentially for days. Re-working the
      // flow puts the agent back in disabledFlows, and pausing the schedule is what makes that
      // true rather than merely recorded.
      const a = wired.get(name);
      if (a) {
        await wireVoice(name, a);
        if (!voiceCreds.has(name)) await pauseVoiceSchedule(name, "the Plaud account was disconnected");
      }
      return "Disconnected - I've forgotten your Plaud account and asked Plaud to revoke it. Nothing is polling it any more.";
    },
    finishPlaud: async (name, pasted) => {
      const r = await plaudauth.complete(name, pasted);
      if (!r.ok) return `That didn't work - ${r.problem}.`;
      // THE SECOND COMPLETION PATH. The dialog is not the only way in — `!connect plaud <code>`
      // lands here — and a fix applied to one of two doors is not a fix. Starting the poll has to
      // happen wherever a credential arrives, not wherever it was convenient to add it.
      const caveat = await plaudDeps.onConnected?.(name).catch((e) => `I couldn't start the poll - ${(e as Error).message}`);
      if (caveat) return `✅ Your Plaud account is connected, but ${caveat}.

Nothing will be picked up until that is sorted.`;
      const where = voiceCreds.get(name)?.notifyChannel;
      return (
        "✅ Your Plaud account is connected." +
        `

Record something and I'll pick it up within a couple of minutes - I'll post what I find ${where ? `in <#${where}>` : "here"}.`
      );
    },
    connectPlaud: async (name, conversation) => {
      // Buttons and a private dialog, the same shape as connecting Claude. Two mechanisms for
      // one idea is something a person has to learn twice, and the typed version put an
      // authorization code into channel history.
      const asked = await plaudgate.ask(plaudDeps, name, conversation).catch(() => false);
      // The blocks ARE the message. Returning text as well would post the whole thing twice.
      if (asked) return "";
      // A client that cannot render blocks still gets a working, if wordier, flow.
      const p = await plaudauth.begin(name);
      return (
        `Let's connect your Plaud account. Open this and sign in as yourself:\n\n${p.url}` +
        `\n\n*Then:* the page it sends you to will fail to load - that is expected. Copy the whole address 
         out of your browser bar and send it back as \`!code plaud <address>\``
      );
    },
    // What THIS conversation runs: its own choice, else whatever the roster row says.
    getModel: (name, conversation) => models.get(conversation) ?? wired.get(name)?.cfg.model,
    setModel: (_name, conversation, model) => {
      if (model) models.set(conversation, model);
      else models.delete(conversation);
    },
  };

  // --- adding a calendar by its published address -------------------------------------------------
  //
  // CHECKED BEFORE IT IS STORED. A URL that cannot be read produces a connection row the matcher
  // silently gets nothing from — "connected" on screen and empty in practice, which is the exact
  // state every failure this week wore as a disguise. So the feed is fetched and parsed first, and
  // only a feed that answers is saved.
  const icsDeps: icsgate.IcsGateDeps = {
    conn: (name) => wired.get(name)?.conn as SlackConnector | undefined,
    save: async (name, alias, url) => {
      const guid = wired.get(name)?.cfg.guid;
      const baseUrl = process.env.TONOMANCLOUD_API_URL;
      if (!guid || !baseUrl) return { ok: false, message: "⚠️ This deployment has no registry to store that in." };

      const health = await calendar.checkIcs(url).catch((e) => ({ ok: false as const, problem: (e as Error).message }));
      if (!health.ok) {
        return {
          ok: false,
          message:
            `⚠️ I couldn't read that calendar — ${health.problem}
` +
            "Nothing has been saved. Check the link is the *ICS* one and that it is published to *Can view all details*.",
        };
      }

      const ref = `ics.url:${alias}`;
      const auth = { authorization: `Bearer ${process.env.TONOMANCLOUD_API_TOKEN ?? ""}`, "content-type": "application/json" };
      try {
        // The URL goes into the secret store, sealed, and the connection row only ever names the
        // ref — the same rule as every other credential. It is the calendar's password.
        const put = await fetch(`${baseUrl}/v1/system/agents/${guid}/secrets/${encodeURIComponent(ref)}`, {
          method: "PUT",
          headers: auth,
          body: JSON.stringify({ value: url }),
        });
        if (!put.ok) return { ok: false, message: `⚠️ I couldn't store that — the registry said HTTP ${put.status}.` };

        const attach = await fetch(
          `${baseUrl}/v1/system/agents/${guid}/connections/ics/${encodeURIComponent(alias)}`,
          { method: "PUT", headers: auth, body: JSON.stringify({ secretRef: ref, label: alias }) },
        );
        if (!attach.ok) return { ok: false, message: `⚠️ I stored it but couldn't attach it — HTTP ${attach.status}.` };
      } catch (e) {
        return { ok: false, message: `⚠️ I couldn't reach the registry — ${(e as Error).message.slice(0, 160)}` };
      }

      // TAKE EFFECT NOW. This used to end "it takes effect on my next restart", which was honest
      // about a limitation nobody should have had to live with: connecting a calendar and then
      // waiting for a deploy is the same "connected, but not really" this whole path exists to
      // stop. The roster is the worker's cached view, so the new connection is reflected into it
      // the same way an auth_state change is, and the flow is worked out again.
      const a = wired.get(name);
      if (a) {
        const conns = (a.cfg.connections ??= []);
        const at = conns.findIndex((c) => c.kind === "ics" && c.alias === alias);
        const row = { kind: "ics" as const, alias, secret_ref: ref, status: "connected" as const, label: alias };
        if (at >= 0) conns[at] = { ...conns[at], ...row };
        else conns.push(row as (typeof conns)[number]);
        await wireVoice(name, a);
        const v = voiceCreds.get(name);
        if (v) await ensureVoiceSchedule(name, v);
      }

      // What it FOUND, not that it succeeded. "Connected" on its own is the claim that has been
      // wrong all week; a count and the next meeting are checkable by the person reading them.
      return {
        ok: true,
        message: `✅ ${calendar.healthLine(alias, health)}`,
      };
    },
  };

  // The agent asks for its OWN credential, through its own runtime. The login endpoints live in
  // the sidecar sharing this pod's credential volume, so the code goes from a Slack modal to the
  // process that owns the credential and nowhere else — it never transits the control plane.
  const authBase = process.env.AGENT_RUNTIME_URL ?? "http://127.0.0.1:8080";
  const authDeps: gate.AuthGateDeps = {
    // Named, so the login lands in THIS agent's credential directory. Without the name every
    // agent in the pool shares one Claude subscription and the last person to sign in owns them.
    ops: (name) => (wired.has(name) ? httpAuthOps(authBase, process.env.AGENT_RUNTIME_TOKEN, name) : undefined),
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

  const plaudDeps: plaudgate.PlaudGateDeps = {
    conn: (name) => wired.get(name)?.conn as SlackConnector | undefined,
    begin: async (name) => (await plaudauth.begin(name)).url,
    complete: (name, pasted) => plaudauth.complete(name, pasted),
    notifyChannel: (name) => voiceCreds.get(name)?.notifyChannel,
    // The half that was missing. Storing the credential was never the end of connecting an account
    // — the flow has to be worked out again and the schedule created, both of which only happened
    // at boot.
    onConnected: async (name) => {
      const a = wired.get(name);
      if (!a) return `I don't serve ${name} in this process`;
      await wireVoice(name, a);
      const v = voiceCreds.get(name);
      // wireVoice says WHY in the log; this says it where the person asking can read it.
      if (!v) return "this agent has no voice flow configured yet, so there is nothing to poll with";
      await ensureVoiceSchedule(name, v);
      return undefined;
    },
  };

  // Interactions are wired per connector below, at construction.
  for (const [name, a] of wired) {
    (a.conn as SlackConnector).setInteractionHandler?.((it) => {
      // Two gates now, and each claims only what it recognises: connecting Claude and connecting
      // Plaud both end in a dialog, so the router asks the Plaud one first and falls through when
      // the interaction is not its own.
      // THREE gates now, each claiming only what it recognises, and the auth gate LAST because it
      // is the one with no namespace of its own — it accepts an undefined callbackId, so anything
      // routed to it by default would be tried as a Claude authorization code.
      const claims = (id: string) => it.actionId?.startsWith(id) || it.callbackId === id;
      const run = claims(plaudgate.PLAUD_CONNECT_ACTION)
        ? plaudgate.handleInteraction(plaudDeps, name, it)
        : claims(icsgate.ICS_CONNECT_ACTION)
          ? icsgate.handleInteraction(icsDeps, name, it)
          : gate.handleInteraction(authDeps, name, it);
      void run
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
  // The map from the guid keys (what every other log line and workflow id now carries) back to the
  // names a person recognises. Printed once, so a `f89e0934-…` anywhere below can be read.
  for (const [key, a] of wired) {
    const label = a.cfg.tenant ? `${a.cfg.tenant}-${a.cfg.displayName ?? key}` : (a.cfg.displayName ?? key);
    if (key !== label) console.log(`worker:   ${label} = ${key}`);
  }

  // Ingress: each connector yields envelopes; each becomes a signal. The connector does nothing
  // else — the durability boundary starts at signalWithStart.
  //
  // One pump per agent, each on its OWN abort chained to the worker signal, so live reload can retire
  // one agent's connector without disturbing another's. Extracted from the boot loop for the same
  // reason wireOne was: reload starts a pump for a newly-added or rebuilt agent, and the ingress
  // logic must be identical whether it is boot or reload that starts it.
  const pumps: Promise<void>[] = [];
  const startPump = (name: string, a: Wired): Promise<void> => {
    const ac = new AbortController();
    signal.addEventListener("abort", () => ac.abort(), { once: true });
    a.abort = ac;
    const pump = (async () => {
      for await (const env of a.conn.receive(ac.signal)) {
        // Commands are answered HERE, before the durability boundary: `!status` is a read of
        // state this process already holds, and routing it through a workflow would queue it
        // behind — or interrupt — the very turn it is asking about. They are also answered
        // before the auth gate, so `!help` still works on an agent that cannot yet run turns.
        const cmd = cmds.parse(env.text);
        if (cmd) {
          const out = await cmds.run(commandDeps, name, env.conversation, cmd).catch((e) => {
            console.error(`worker: ${name} command ${cmd.name} failed: ${(e as Error).message}`);
            return `I couldn't run that — ${String((e as Error)?.message ?? e).slice(0, 150)}`;
          });
          // Null means it is not one of ours. An unknown `!word` is far more likely to be
          // ordinary emphasis than a typo'd command, so it falls through to a real turn.
          if (out !== null) {
            // An EMPTY string means the command already said its piece another way - `!connect
            // plaud` posts Block Kit buttons itself. Sending "" on top would post a blank
            // message under them.
            if (out !== "") await a.conn.reply(env.conversation).send(out).catch(() => {});
            continue;
          }
        }
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
    })();
    return pump;
  };
  for (const [name, a] of wired) pumps.push(startPump(name, a));

  // Live roster reload (A11, hot-reload). The worker used to read the roster once and never again,
  // so a Hub edit — a new default model, a granted skill, a rename — reached the running agent only
  // on a restart. On a timer it re-fetches the roster and applies the DIFFERENCE: an unchanged agent
  // is left strictly alone (no socket touched), a config change is swapped in for the next turn, and
  // only a change to a connector's own inputs reconnects anything.
  const reloadEvery = Number(process.env.ROSTER_RELOAD_SECONDS ?? 30) * 1000;
  if (reloadRoster && reloadEvery > 0) {
    const harnesses = defaultHarnesses();
    const doReload = async (): Promise<void> => {
      const next = await reloadRoster();
      const nextAgents = next.agents ?? [];
      // A roster that came back empty while we are serving agents is an upstream failure, never an
      // instruction to tear the fleet down. Keep what we have and wait for the next tick.
      if (nextAgents.length === 0 && wired.size > 0) {
        console.error("worker: roster reload returned 0 agents — keeping current wiring");
        return;
      }
      // Compare like with like: `wired` holds only servable agents, so filter the incoming roster by
      // the same TONOMAN_AGENTS allowlist wire() applies at boot before diffing.
      const servable = nextAgents.filter((a) => {
        if (only.size === 0) return true;
        const label = agentLabel(a);
        return (
          only.has(a.name.toLowerCase()) ||
          only.has(label.toLowerCase()) ||
          only.has((a.displayName ?? "").toLowerCase())
        );
      });
      const current = [...wired.values()].map((w) => w.cfg);
      const plan = planReload(current, servable);
      // Losing more than half the fleet in one tick is degradation upstream (a partial roster, a
      // flaky join), not a mass delete somebody asked for. Refuse it and log loudly.
      //
      // DELIBERATELY off for a single-agent worker (`wired.size > 1`): with one agent, "more than
      // half" is the agent itself, and there is no majority to compare it against. The empty-roster
      // guard above still catches `agents: []`, but a roster that comes back non-empty yet without
      // this one agent (its channel join momentarily invisible) WOULD retire it here. Acceptable
      // today — Sapien and Nelly make two — and the reload after the hiccup wires it straight back.
      // A single-agent self-hosted worker that wants belt-and-braces should pin ROSTER_RELOAD_SECONDS
      // higher or disable reload.
      if (wired.size > 1 && plan.removed.length > wired.size / 2 && servable.length < current.length) {
        console.error(
          `worker: roster reload would remove ${plan.removed.length}/${wired.size} agents — ` +
            `ignoring as likely upstream degradation`,
        );
        return;
      }
      if (plan.added.length === 0 && plan.removed.length === 0 && plan.updated.length === 0) return;

      const byKey = new Map(servable.map((a) => [a.name, a] as const));

      // Removed: stop its pump (its own abort), pause its poll, drop it. A turn in flight dies with
      // the connector — the same as a restart, and acceptable for a disabled or deleted agent.
      for (const key of plan.removed) {
        const a = wired.get(key);
        if (!a) continue;
        a.abort?.abort();
        await pauseVoiceSchedule(key, "agent left the roster").catch(() => {});
        wired.delete(key);
        console.log(`worker: reload — retired ${agentLabel(a.cfg)} (${key})`);
      }

      // Added: wire it, start its pump, wire its voice. A newly created agent appears here the reload
      // after its Slack setup completes — the roster lists only enabled, channel-bound agents.
      for (const key of plan.added) {
        const cfg2 = byKey.get(key);
        if (!cfg2) continue;
        const w = wireOne(cfg2, harnesses);
        if (!w) continue; // wireOne logged why (channel, tokens, harness)
        wired.set(key, w);
        pumps.push(startPump(key, w));
        await wireVoice(key, w).catch((e) => console.error(`worker: reload — wireVoice ${key} failed: ${(e as Error).message}`));
        console.log(`worker: reload — added ${agentLabel(cfg2)} (${key})`);
      }

      // Updated: swap the config in place so the next turn reads it (the model per turn; the persona
      // through the identity file the roster fetch just rewrote). Rebuild the runner if a baked-in
      // field changed (max_turns / url), keeping the connector so no socket reconnects. Rebuild the
      // whole entry only if a connector input changed (harness / token / channel / allowed-users).
      for (const d of plan.updated) {
        const cfg2 = byKey.get(d.key);
        const a = wired.get(d.key);
        if (!cfg2 || !a) continue;
        if (d.rebuildConn) {
          a.abort?.abort();
          const w = wireOne(cfg2, harnesses);
          if (!w) {
            wired.delete(d.key);
            continue;
          }
          wired.set(d.key, w);
          pumps.push(startPump(d.key, w));
          console.log(`worker: reload — reconnected ${agentLabel(cfg2)} (${d.key})`);
        } else {
          a.cfg = cfg2;
          if (d.rebuildRunner) {
            const runner = newRunnerFor(cfg2, harnesses);
            if (runner) {
              a.runner = runner;
              a.run = runClosure(runner);
            }
          }
          console.log(`worker: reload — updated ${agentLabel(cfg2)} (${d.key})${d.rebuildRunner ? " — new runner" : ""}`);
        }
        // Re-derive the voice flow from the new config — idempotent (ensureVoiceSchedule updates in
        // place), and how a newly granted skill or a changed cadence reaches the poll.
        const w = wired.get(d.key);
        if (w) await wireVoice(d.key, w).catch((e) => console.error(`worker: reload — wireVoice ${d.key} failed: ${(e as Error).message}`));
      }

      // Refresh checkouts and context notes against the swapped configs. We hold `busy`, so syncAll's
      // own timer is not also running; call its body directly.
      await syncAll().catch(() => {});
    };

    let reloadTimer: ReturnType<typeof setInterval> | undefined;
    reloadTimer = setInterval(() => {
      if (busy) return;
      busy = true;
      void doReload()
        .catch((e) => console.error(`worker: roster reload failed — ${(e as Error).message}`))
        .finally(() => {
          busy = false;
        });
    }, reloadEvery);
    signal.addEventListener("abort", () => clearInterval(reloadTimer), { once: true });
    console.log(`worker: roster reload every ${reloadEvery / 1000}s`);
  }

  // gw-wake: a system can start the conversation. This is what lets the voice flow say "I've got
  // your meeting" without anybody asking — the beat the whole pipeline exists to produce.
  const wakeToken = process.env.TONOMAN_WAKE_TOKEN ?? "";
  const wakeServing = serveWake(
    {
      port: Number(process.env.TONOMAN_WAKE_PORT ?? 3980),
      token: wakeToken,
      deps: {
        has: (name) => wired.has(name),
        dmFor,
        say: async (name, conversation, text) => {
          await wired.get(name)?.conn.reply(conversation).send(text);
        },
        ask: async (name, conversation, text, user) => {
          // Through the same workflow as a typed message, so a woken turn has the same history,
          // the same ordering and the same interruption behaviour as any other.
          //
          // `user` is the RECIPIENT. A placeholder here made the agent believe it was addressing a
          // stranger, and it refused to discuss the meeting it had just been asked to summarise —
          // which was the right call on its part and the wrong input from ours.
          await client.workflow.signalWithStart(conversationWorkflow, {
            workflowId: `${name}:slack:${conversation}`,
            taskQueue: o.taskQueue,
            args: [{ agent: name, conversation, channel: "slack" }],
            signal: messageSignal,
            signalArgs: [{ text, user: user ?? "", ts: String(Date.now()) }],
          });
        },
      },
    },
    signal,
  );
  if (!wakeServing) {
    console.log("worker: TONOMAN_WAKE_TOKEN is unset — /api/wake is NOT served (no agent can speak first)");
  }

  // The voice flow, watching by itself. One long-lived workflow per agent, started idempotently:
  // `WorkflowExecutionAlreadyStarted` is the expected answer on every restart after the first, and
  // means the poll survived the deploy rather than that something is wrong.
  // The voice flow runs on a SCHEDULE, not a timer loop inside a workflow.
  //
  // A schedule is what this always should have been: the cadence is visible on a page and editable
  // without a deploy, pausing is a button rather than terminating a running execution and
  // restarting a pod, and `overlapPolicy: SKIP` is the "do not double-process" guarantee that
  // otherwise has to be written by hand. The loop only made sense if the workflow carried state
  // between ticks, and it never did — what has been published is answered from the git checkout.
  /** The note this worker writes when it pauses a schedule BECAUSE THE REGISTRY SAYS SO. It is
   *  what tells our own pause apart from a person's, and the difference is not cosmetic: resuming
   *  on `enabled=true` is correct, and resuming a pause somebody made by hand is a restart quietly
   *  undoing an operator's decision. That is how a paused backlog re-enabled itself and published
   *  recaps nobody had approved. */
  const DISABLED_NOTE = "flow_property enabled=false";

  /** The voice schedule's id, keyed by the agent's STABLE guid rather than its (mutable) name.
   *  Renaming an agent must not re-key its schedule: the old one would be left polling in parallel
   *  with the new — the double-process this whole flow guards against, in a rename's costume. Falls
   *  back to the name for a file roster, which has no guid. */
  function voiceScheduleId(name: string): string {
    return `voice:${wired.get(name)?.cfg.guid ?? name}`;
  }

  /** Stop one agent's poll. Best effort and idempotent: a flow that was never scheduled has
   *  nothing to pause, which is the normal case for a flow that was never on. */
  async function pauseVoiceSchedule(name: string, why: string): Promise<void> {
    try {
      const h = client.schedule.getHandle(voiceScheduleId(name));
      if (!(await h.describe()).state.paused) {
        await h.pause(why);
        console.log(`worker: ${name} voice schedule paused — ${why}`);
      }
    } catch {
      /* no schedule under that id */
    }
  }

  for (const name of disabledFlows) await pauseVoiceSchedule(name, DISABLED_NOTE);

  /** Create, update or resume one agent's poll schedule. Separated from the loop for the same
   *  reason as wireVoice: a flow that becomes ready AFTER boot has to get a schedule then, not at
   *  the next restart. Safe to call repeatedly — "already exists" is the normal answer. */
  async function ensureVoiceSchedule(name: string, v: VoiceConfig): Promise<void> {
    const recipient = v.notifyUser ?? "";
    if (!recipient && !v.notifyChannel) {
      // Nowhere to send a recap is not a state to run in: the pipeline would transcribe, summarise,
      // commit and then have nobody to tell.
      console.log(`worker: ${name} voice flow not scheduled — nobody to tell (set notify_channel or notify_user)`);
      return;
    }
    const scheduleId = voiceScheduleId(name);
    const every: Duration = `${v.pollSeconds ?? 300} seconds`;
    const action = {
      type: "startWorkflow" as const,
      workflowType: plaudPollWorkflow,
      taskQueue: o.taskQueue,
      args: [{ agent: name, notify: recipient ?? "" }] as [PollInput],
    };

    // One-time migration off the old NAME-keyed id. An earlier build scheduled `voice:<tenant>-<name>`;
    // left in place it keeps polling alongside the new guid-keyed schedule — the double-process this
    // change exists to prevent. Delete it when the id has actually moved (guid rosters only).
    if (scheduleId !== `voice:${name}`) {
      try {
        await client.schedule.getHandle(`voice:${name}`).delete();
        console.log(`worker: ${name} removed the legacy name-keyed voice schedule (now ${scheduleId})`);
      } catch {
        /* no legacy schedule under the old id, which is the normal case after the first migration */
      }
    }

    // The loop's execution, if this pod is the one replacing it. Left running it would poll in
    // parallel with the schedule and announce everything twice — the double-answer bug in a
    // different costume.
    try {
      const old = client.workflow.getHandle(scheduleId);
      const d = await old.describe();
      if (d.status.name === "RUNNING") {
        await old.terminate("superseded by the voice schedule");
        console.log(`worker: ${name} terminated the old polling workflow — a schedule drives it now`);
      }
    } catch {
      /* nothing running under that id, which is the normal case */
    }

    try {
      await client.schedule.create({
        scheduleId,
        spec: { intervals: [{ every }] },
        // SKIP, not BUFFER: a tick that lands while the previous one is still transcribing has
        // nothing new to say, and queueing it would only guarantee a pile-up behind a slow meeting.
        policies: { overlap: ScheduleOverlapPolicy.SKIP },
        action,
      });
      console.log(`worker: ${name} voice schedule created — every ${every}`);
    } catch (e) {
      if (!/already exists/i.test((e as Error).message ?? "")) throw e;
      // Update rather than leave it: the interval and the recipient come from the registry, and a
      // schedule that silently keeps yesterday's configuration is the staleness this design was
      // meant to remove.
      const h = client.schedule.getHandle(scheduleId);
      await h.update((prev) => ({
        ...prev,
        spec: { intervals: [{ every }] },
        action,
      }));
      // And UNPAUSE it — but ONLY the pause this worker wrote. Turning the flow off pauses the
      // schedule, so skipping this entirely would make the switch work in one direction only: a row
      // set back to enabled=true would look on in the registry and in the boot log while the
      // schedule sat paused and nothing ever ran.
      //
      // Unpausing UNCONDITIONALLY is the other half of the same mistake, and it is the one that
      // actually cost something: every restart resumed a schedule a person had paused on purpose,
      // so a backlog held back for inspection drained itself the next time the pod came up.
      const state = (await h.describe()).state;
      if (state.paused) {
        if (state.note === DISABLED_NOTE) {
          await h.unpause("flow_property enabled=true");
          console.log(`worker: ${name} voice schedule resumed`);
        } else {
          console.log(
            `worker: ${name} voice schedule LEFT PAUSED — ${state.note || "paused outside the registry"}`,
          );
        }
      }
      console.log(`worker: ${name} voice schedule updated — every ${every}`);
    }
  }

  for (const [name, v] of voiceCreds) await ensureVoiceSchedule(name, v);

  signal.addEventListener("abort", () => worker.shutdown(), { once: true });
  await Promise.all([serving, ...pumps]);
  await conn.close();
  await nativeConn.close();
  console.log("worker: stopped");
}

/** Pure helpers exposed for tests. Not part of the module's contract. */
export const __testing = { disallowedTools, DEFAULT_DISALLOWED };
