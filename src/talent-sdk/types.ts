// The Talent SDK — the contract a Talent is built against, and NOTHING else it may import.
//
// A Talent is a self-contained CLI (see docs/architecture.md A15). It depends on this SDK and on its
// own third-party libraries — never on `../worker` or any runtime internal. That import boundary is
// the compile-time proof that a Talent is liftable into its own repo. Keep this surface MINIMAL: it
// grows only when a second Talent genuinely needs something a first one didn't.

/** One credential a Talent needs — a RAW third-party account it uses directly (Plaud, a calendar
 *  feed). `optional` distinguishes "cannot run without it" (Plaud) from "works, just does less" (a
 *  calendar — none means an empty candidate list, not a failure). Resolved by the environment and
 *  delivered to the CLI; a long-lived login (Plaud's OAuth) arrives as a ref the Talent exchanges for
 *  a fresh token via `ctx.credential`, so it can refresh across a long run. */
export interface CredentialRequirement {
  kind: string;
  optional?: boolean;
}

/** A runtime-MEDIATED capability the Talent calls through the capability plane rather than doing
 *  itself — so provider routing (local-gpu), metering (inference) and the git-backed second brain
 *  stay the runtime's, never baked into the Talent. Announcing is deliberately absent: a Talent
 *  reports an outcome, it does not speak. */
export type CapabilityName = 'transcribe' | 'infer' | 'publish';

export type ConfigFieldType = 'channel' | 'channel_list' | 'text' | 'toggle';

/** One typed field an agent fills when the Talent is installed. The Hub renders a form from these;
 *  the worker passes the saved values in `TalentInput.config`. */
export interface ConfigField {
  key: string;
  type: ConfigFieldType;
  label?: string;
  required?: boolean;
}

/** A Talent's manifest: its identity and its declared, deterministic dependencies. This is what
 *  worker-boot registration upserts into the Cloud `talent` registry (git = source of truth). It is
 *  DATA — declared in code, imported at build time — which is why "hot-load" applies to the CLI's
 *  execution, not to how the manifest reaches the catalogue. */
export interface TalentManifest {
  name: string;
  version: number;
  description?: string;
  /** Raw third-party credentials the Talent uses directly. */
  requires: CredentialRequirement[];
  /** Mediated capabilities the Talent calls through the plane. */
  capabilities: CapabilityName[];
  configSchema: ConfigField[];
}

// --- What a run receives and returns -------------------------------------------------------------

/** The one item to work — a recording id for the Plaud Talent; whatever the next source calls its
 *  own tomorrow — plus this agent's saved config and, on the per-person path, whose account it is. */
export interface TalentInput {
  item: string;
  config: Record<string, unknown>;
  user?: string;
}

/** The structured result a Talent reports on stdout. The Talent does the work and REPORTS; it does
 *  not speak — `runTalentWorkflow` announces `summary` through the existing say path, and the agent
 *  consumes `steer` to decide any further step to bubble to the user. `status` is what the
 *  `talent_run` record closes as. */
export interface TalentOutcome {
  status: 'done' | 'skipped' | 'failed';
  /** A human-facing line the runtime announces verbatim (e.g. the recap notice). */
  summary?: string;
  /** A hint to the agent about a sensible next step; consumed by the agent loop, not announced. */
  steer?: string;
  /** Why a run was skipped or failed — recorded, not announced. */
  reason?: string;
}

// --- The capability plane, as the Talent sees it -------------------------------------------------
//
// These signatures match the plane's wire exactly, and they are free of any runtime type — a Talent
// imports only this SDK. The engine, budget and routing behind each call are the tenant's, resolved
// below the Talent.

/** Transcribe audio the Talent obtained from its source. `audioUrl` is a URL the plane can fetch
 *  (for Plaud, the pre-signed temp URL the Talent resolved with its credential); `cacheId` keys the
 *  chunk cache so a retry resumes; `label` is for logs. The plane segments and routes it through the
 *  tenant's transcription chain (groq / local-gpu) and returns which providers answered in `by`. */
export interface TranscribeCapability {
  (input: { audioUrl: string; label?: string; cacheId?: string; vocab?: string }): Promise<{
    text: string;
    seconds: number;
    by: string[];
  }>;
}

/** One JSON-mode completion through the tenant's model chain. The PROMPT is the Talent's (it owns
 *  `system` and `user`); the plane budgets `user` to the model's window and routes it. The Talent
 *  parses the returned `text` against its own schema. */
export interface InferCapability {
  (input: { system: string; user: string }): Promise<{ text: string }>;
}

/** File an artifact in the tenant's git-backed second brain; returns where it landed. The repo, push
 *  credential, journal and timezone are the runtime's. NOTE (transitional): the payload is the recap
 *  artifact's shape for now — a stated impurity, to be cut to a domain-neutral `{route, title, body}`
 *  when a second Talent forces it. The Talent fills it; the SDK forwards it opaquely. */
export interface PublishCapability {
  (payload: Record<string, unknown>): Promise<{ published: boolean; path: string; route: string }>;
}

/** Everything a running Talent is handed. It imports this type; the SDK's `runCli` constructs the
 *  concrete object (capability clients over `TONOMAN_CAPABILITY_URL`, creds from the environment)
 *  and calls the Talent's `run`. */
export interface TalentContext {
  input: TalentInput;
  /** Raw credentials by kind, as declared in `requires`, delivered in the environment. May be empty
   *  for a kind whose login is long-lived — fetch that fresh with `credential` instead. */
  creds: Record<string, unknown>;
  /** Fetch a fresh, usable credential of a declared kind — refreshable across a long run (Plaud). */
  credential(kind: string): Promise<unknown>;
  cap: {
    transcribe: TranscribeCapability;
    infer: InferCapability;
    publish: PublishCapability;
  };
  /** Emit a progress note on the side channel (stderr), so the `runTalent` activity keeps Temporal's
   *  heartbeat alive without the outcome stream having to carry it. */
  progress(note: string): void;
  /** Structured logging to stderr; never stdout (stdout carries only the outcome). */
  log(msg: string): void;
}

/** The function a Talent exports. Pure orchestration over `ctx`: no process, env or stdout access of
 *  its own — the SDK's `runCli` owns the boundary. */
export type TalentRun = (ctx: TalentContext) => Promise<TalentOutcome>;
