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
import { serveWake } from "./wake";
import { promises as fsp } from "node:fs";
import { defaultHarnesses } from "../gateway";
import { makeActivities, type TurnRunReq, type VoiceConfig } from "./activities";
import { conversationWorkflow, messageSignal, plaudPollWorkflow, type Inbound, type PollInput } from "./workflows";

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
}

/** Builds one connector + runner per agent in the roster. An agent whose channel has no connector
 *  is skipped with a reason rather than failing the worker — one bad row must not silence the rest. */
function wire(cfg: Config): Map<string, Wired> {
  const harnesses = defaultHarnesses();
  const out = new Map<string, Wired>();
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
    //
    // And because the pod is the sandbox, the tools it hands the model are the security boundary.
    // This pod holds the operator's Claude subscription credential, so a shell here can read the
    // account behind it — which is exactly what happened: asked who it was talking to, the agent
    // ran Bash, found the operator's email in the runtime, and told a customer about it. An agent
    // that answers from meetings and notes has no use for a shell anyway.
    const runner = spec.newRunner({
      agent: a.name,
      container: a.container,
      model: a.model,
      maxTurns: a.max_turns,
      url: a.url,
      disallowedTools: disallowedTools(),
    });

    out.set(a.name, {
      cfg: a,
      conn,
      runner,
      run: (r: TurnRunReq, signal?: AbortSignal) =>
        runner.run(
          {
            prompt: r.prompt,
            systemPromptFile: r.systemPromptFile,
            model: r.model,
            sessionId: r.sessionId,
            sessionNew: r.sessionNew,
          },
          signal,
        ),
    });
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
  // One sync at a time. A first clone of a large wiki takes longer than the interval, so the timer
  // fired again into a checkout git was still building and the two processes collided on
  // `.git/shallow.lock` — reported as "failed to sync" for a repository that was in fact fine.
  // Skipping a tick is free; the next one is a minute away.
  let syncing = false;
  const syncTimer = setInterval(() => {
    if (syncing) return;
    syncing = true;
    void syncAll()
      .catch(() => {})
      .finally(() => {
        syncing = false;
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
  for (const [name, a] of wired) {
    const groqKey = process.env.GROQ_API_KEY;
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
      continue;
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
      continue;
    }
    if (!groqKey || !src) {
      console.log(`worker: ${name} has no voice flow (needs GROQ_API_KEY and a second-brain source)`);
      continue;
    }
    // How far back the poll may reach. "Not in the second brain" is NOT the same question as
    // "should be transcribed": without a floor the first poll backfills the customer's entire
    // Plaud history and announces each old meeting in Slack as if it had just happened.
    // Unset means "from today onwards" in the pod's own timezone, which is what switching the
    // feature on is meant to mean.
    const tzOffset = -new Date().getTimezoneOffset();
    const floorMs = recapFloor.floorFor(voice.since || undefined, Date.now(), tzOffset);
    const token = await resolveRef(src.secret_ref);
    const pushUrl = token ? src.repo_url.replace("https://", `https://x-access-token:${token}@`) : src.repo_url;
    const dir = path.join(process.env.TONOMAN_STATE_ROOT ?? "/root/.tonoman", "secondbrain", name, src.id);
    voiceCreds.set(name, {
      notifyChannel: voice.notifyChannel || undefined,
      notifyUser: voice.notifyUser || undefined,
      journal: voice.journal,
      pollSeconds: voice.pollSeconds,
      // An agent that has connected its own account through !connect reads from the third-party
      // API; one that has not is still on the mounted bearer. Per agent, so the two tenants can be
      // on different halves of this migration at the same time.
      creds: { tokenJson, cliAgent: viaCli ? name : undefined },
      brainDir: src.subpath ? path.join(dir, src.subpath) : dir,
      pushUrl,
      groqKey,
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
        `brain at ${dir}; only recordings from ${new Date(floorMs).toISOString()} onwards`,
    );
  }

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
  };
  const activities = makeActivities(deps);

  // In-channel commands. They read and write the same maps the status footer uses, so what
  // `!status` reports is exactly what the footer would have shown.
  const commandDeps: cmds.CommandDeps = {
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
      // The flow keeps its resolved credential until the worker restarts, so say that rather than
      // let somebody believe the account is already unhooked when the next poll still reads it.
      return "Disconnected - I've forgotten your Plaud account and asked Plaud to revoke it. The running flow finishes its current cycle first.";
    },
    finishPlaud: async (name, pasted) => {
      const r = await plaudauth.complete(name, pasted);
      if (!r.ok) return `That didn't work - ${r.problem}.`;
      const where = voiceCreds.get(name)?.notifyChannel;
      return (
        "✅ Your Plaud account is connected." +
        `

Record something and I'll pick it up within five minutes - I'll post what I find ${where ? `in <#${where}>` : "here"}.`
      );
    },
    connectPlaud: async (name) => {
      const p = await plaudauth.begin(name);
      return (
        `Let's connect your Plaud account. Open this and sign in as yourself:

${p.url}` +
        `

*Then:* the page it sends you to will fail to load. That is expected - it is trying to reach me and cannot.` +
        `

Copy the whole address out of your browser bar and send it back here as \`!code <address>\``
      );
    },
    // What THIS conversation runs: its own choice, else whatever the roster row says.
    getModel: (name, conversation) => models.get(conversation) ?? wired.get(name)?.cfg.model,
    setModel: (_name, conversation, model) => {
      if (model) models.set(conversation, model);
      else models.delete(conversation);
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

  // Ingress: each connector yields envelopes; each becomes a signal. The connector does nothing
  // else — the durability boundary starts at signalWithStart.
  const pumps: Promise<void>[] = [];
  for (const [name, a] of wired) {
    pumps.push(
      (async () => {
        for await (const env of a.conn.receive(signal)) {
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
              await a.conn.reply(env.conversation).send(out).catch(() => {});
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
      })(),
    );
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
  for (const name of disabledFlows) {
    // Best effort and idempotent: a flow that was never scheduled has nothing to pause.
    try {
      const h = client.schedule.getHandle(`voice:${name}`);
      if (!(await h.describe()).state.paused) {
        await h.pause("flow_property enabled=false");
        console.log(`worker: ${name} voice schedule paused — the flow is switched off`);
      }
    } catch {
      /* no schedule under that id, which is the normal case for a flow that was never on */
    }
  }

  for (const [name, v] of voiceCreds) {
    const recipient = v.notifyUser ?? "";
    if (!recipient && !v.notifyChannel) {
      // Nowhere to send a recap is not a state to run in: the pipeline would transcribe, summarise,
      // commit and then have nobody to tell.
      console.log(`worker: ${name} voice flow not scheduled — nobody to tell (set notify_channel or notify_user)`);
      continue;
    }
    const scheduleId = `voice:${name}`;
    const every: Duration = `${v.pollSeconds ?? 300} seconds`;
    const action = {
      type: "startWorkflow" as const,
      workflowType: plaudPollWorkflow,
      taskQueue: o.taskQueue,
      args: [{ agent: name, notify: recipient ?? "" }] as [PollInput],
    };

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
      // And UNPAUSE it. Turning the flow off pauses the schedule, so leaving this out makes the
      // switch work in one direction only: a row set back to enabled=true would look on in the
      // registry and in the boot log while the schedule sat paused and nothing ever ran.
      if ((await h.describe()).state.paused) {
        await h.unpause("flow_property enabled=true");
        console.log(`worker: ${name} voice schedule resumed`);
      }
      console.log(`worker: ${name} voice schedule updated — every ${every}`);
    }
  }

  signal.addEventListener("abort", () => worker.shutdown(), { once: true });
  await Promise.all([serving, ...pumps]);
  await conn.close();
  await nativeConn.close();
  console.log("worker: stopped");
}

/** Pure helpers exposed for tests. Not part of the module's contract. */
export const __testing = { disallowedTools, DEFAULT_DISALLOWED };
