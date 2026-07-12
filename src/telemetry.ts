// Harness-neutral observability (obs-*). tonoman owns the trace SINK and the boot-time WIRING; each
// harness plug declares only how its runtime emits telemetry (Spec.telemetry). This module implements:
//   - the harness-neutral trace model (obs-trace-neutral),
//   - the Langfuse sink read from ONE config, mapped across runtime env-name quirks (obs-sink-*),
//   - the `hook` adapter for a transcript-based runtime (Claude Code today, Codex the same shape):
//     a PURE transcript→NeutralTrace decoder + a zero-dep post to Langfuse's ingestion API (obs-zero-dep),
//   - registering the post-turn hook into the runtime's settings (obs-runtime-registers).
// Zero-dep: no vendor SDK, no Python — plain Node + fetch, matching tonoman's plain-JS principle.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

/** One turn as a harness-neutral trace (obs-trace-neutral) — the SAME shape across runtimes, so one
 * dashboard answers cost/skill/model/bloat/abuse questions regardless of Claude Code / Codex / OpenCode. */
export interface NeutralTrace {
  agent?: string;
  session?: string;
  user?: string;
  backend?: string; // "subscription" | "bedrock" | …
  model?: string;
  prompt: string;
  reply: string;
  tools: { name: string; input?: unknown; output?: string }[];
  skills: string[];
  tokens: { input?: number; output?: number; cacheRead?: number; cacheCreation?: number };
}

/** The trace sink — ONE tonoman config (obs-sink-config), independent of runtime. */
export interface Sink {
  publicKey: string;
  secretKey: string;
  baseUrl: string;
}

/** Read the sink from env. Returns null when unconfigured → tracing is OFF (obs-sink-config). Accepts
 * BOTH `LANGFUSE_BASE_URL` (Claude Code / Codex) and `LANGFUSE_BASEURL` (OpenCode) so one config maps
 * onto each runtime's env-name quirk (obs-sink-mapping). An explicit TRACE_TO_LANGFUSE=false disables. */
export function sinkFromEnv(env: NodeJS.ProcessEnv = process.env): Sink | null {
  const flag = (env.TRACE_TO_LANGFUSE ?? "").trim().toLowerCase();
  if (flag && !["1", "true", "yes", "on"].includes(flag)) return null; // explicit off
  const publicKey = env.LANGFUSE_PUBLIC_KEY;
  const secretKey = env.LANGFUSE_SECRET_KEY;
  const baseUrl = env.LANGFUSE_BASE_URL || env.LANGFUSE_BASEURL;
  if (!publicKey || !secretKey || !baseUrl) return null;
  return { publicKey, secretKey, baseUrl: baseUrl.replace(/\/+$/, "") };
}

// --- the `hook` adapter: Claude Code transcript → NeutralTrace (pure, testable) --------------------

type Rec = Record<string, unknown>;
const asRec = (v: unknown): Rec => (v && typeof v === "object" ? (v as Rec) : {});
const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Decode a Claude Code transcript (parsed JSONL entries) into the neutral trace for the CURRENT turn.
 * The current turn = everything after the last real user prompt (a genuine prompt has STRING content;
 * tool_results are also `type:"user"` but carry a LIST). Pure — no IO, so the mapping is unit-tested. */
export function decodeClaudeTranscript(entries: unknown[], extra: Partial<NeutralTrace> = {}): NeutralTrace {
  let start = 0;
  entries.forEach((e, i) => {
    const o = asRec(e);
    if (o.type === "user" && typeof asRec(o.message).content === "string") start = i;
  });
  const turn = entries.slice(start);

  const trace: NeutralTrace = { prompt: "", reply: "", tools: [], skills: [], tokens: {}, ...extra };
  const first = asRec(asRec(turn[0]).message).content;
  if (typeof first === "string") trace.prompt = first;

  const replyParts: string[] = [];
  const toolResults = new Map<string, string>();
  for (const e of turn) {
    const o = asRec(e);
    const m = asRec(o.message);
    if (o.type === "assistant") {
      if (typeof m.model === "string") trace.model = m.model;
      const u = asRec(m.usage);
      if (Object.keys(u).length) {
        trace.tokens = {
          input: u.input_tokens as number | undefined,
          output: u.output_tokens as number | undefined,
          cacheRead: u.cache_read_input_tokens as number | undefined,
          cacheCreation: u.cache_creation_input_tokens as number | undefined,
        };
      }
      for (const b of asArr(m.content).map(asRec)) {
        if (b.type === "text" && typeof b.text === "string" && b.text) replyParts.push(b.text);
        else if (b.type === "tool_use" && typeof b.name === "string") trace.tools.push({ name: b.name, input: b.input, output: undefined });
      }
    } else if (o.type === "user") {
      for (const b of asArr(m.content).map(asRec)) {
        if (b.type === "tool_result") {
          const c = b.content;
          toolResults.set(String(b.tool_use_id ?? ""), typeof c === "string" ? c : JSON.stringify(c).slice(0, 8000));
        }
      }
    }
  }
  trace.reply = replyParts.join("");
  // attach tool outputs by id, in call order
  let ri = 0;
  const ids = [...toolResults.keys()];
  for (const t of trace.tools) {
    if (ids[ri] !== undefined) t.output = toolResults.get(ids[ri]);
    ri++;
  }
  return trace;
}

// --- cost (obs-trace-neutral: cost per turn) -------------------------------------------------------
// Per-model token prices in USD/token, WITH cache tiers. We compute cost in the hook rather than rely
// on the sink's price catalog because self-hosted Langfuse v2 doesn't know newer models and can't price
// cache tiers (which dominate our token counts). List prices — update when they change; on Langfuse v3
// this can move to the sink's native cache-aware model pricing. Matches both plain and Bedrock ids.
interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}
const PRICES: { match: RegExp; price: Price }[] = [
  // USD/token. cacheRead ≈ 0.1× input (10× cheaper reuse); cacheWrite ≈ 1.25× input (premium to store).
  { match: /claude-opus-4/i, price: { input: 15e-6, output: 75e-6, cacheRead: 1.5e-6, cacheWrite: 18.75e-6 } },
  { match: /claude-sonnet-4/i, price: { input: 3e-6, output: 15e-6, cacheRead: 0.3e-6, cacheWrite: 3.75e-6 } },
  { match: /claude-haiku-4/i, price: { input: 1e-6, output: 5e-6, cacheRead: 0.1e-6, cacheWrite: 1.25e-6 } },
];

/** Cache-aware USD cost for a turn, broken out PER TIER (obs cost visibility) so "how much is just
 * re-caching the system prompt" is one glance. {} when the model is unpriced. */
export function costOf(
  model: string | undefined,
  t: NeutralTrace["tokens"],
): { input?: number; output?: number; cacheWrite?: number; cacheRead?: number; total?: number } {
  const p = model ? PRICES.find((x) => x.match.test(model))?.price : undefined;
  if (!p) return {};
  const input = (t.input || 0) * p.input;
  const output = (t.output || 0) * p.output;
  const cacheWrite = (t.cacheCreation || 0) * p.cacheWrite;
  const cacheRead = (t.cacheRead || 0) * p.cacheRead;
  return { input, output, cacheWrite, cacheRead, total: input + output + cacheWrite + cacheRead };
}

// --- full-context capture (fctx-*): the ENTIRE request the model saw, assembled post-hoc ----------
// Out-of-path (fctx-out-of-path): the static prefix (system + tools) is captured ONCE at boot by a
// local probe; the post-turn hook prepends it to the full message history from the transcript. Nothing
// sits in the request path, so it is backend-agnostic (subscription OAuth untouched) and never costs a
// turn. Reconstruction is ~faithful (the boot-snapshot prefix), not byte-exact — enough to debug bloat.

/** Full-context capture is OFF unless TRACE_FULL_CONTEXT is explicitly truthy (fctx-flag-gated). */
export function fullContextEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return ["1", "true", "yes", "on"].includes((env.TRACE_FULL_CONTEXT || "").trim().toLowerCase());
}

/** The static prefix captured at boot (fctx-boot-prefix): the system blocks + the tool schemas. */
export interface ContextPrefix {
  system: string[];
  tools: { name: string; description?: string; input_schema?: unknown }[];
}

/** Extract {system, tools} from a captured model request body (pure). null if it isn't a request. */
export function parsePrefix(requestBody: unknown): ContextPrefix | null {
  const b = asRec(requestBody);
  if (b.system === undefined && !Array.isArray(b.tools)) return null;
  const sysRaw = b.system;
  const system = Array.isArray(sysRaw)
    ? sysRaw.map((x) => (typeof x === "string" ? x : String(asRec(x).text ?? ""))).filter(Boolean)
    : typeof sysRaw === "string"
      ? [sysRaw]
      : [];
  const tools = asArr(b.tools)
    .map(asRec)
    .map((t) => ({ name: String(t.name ?? ""), description: typeof t.description === "string" ? t.description : undefined, input_schema: t.input_schema }));
  return { system, tools };
}

/** Flatten transcript entries into readable role/content messages (the live half of the context).
 * `elide` holds tool_use_ids whose result body was pulled into its own section (a loaded skill) —
 * those are replaced with a one-line pointer so `messages` stays legible instead of swallowing the
 * skill body. */
function messagesFromTranscript(entries: unknown[], elide?: Set<string>): string {
  const out: string[] = [];
  for (const e of entries) {
    const o = asRec(e);
    if (o.type !== "user" && o.type !== "assistant") continue;
    const m = asRec(o.message);
    const role = String(m.role || o.type);
    const c = m.content;
    let text: string;
    if (typeof c === "string") text = c;
    else {
      const parts: string[] = [];
      for (const b of asArr(c).map(asRec)) {
        if (b.type === "text") parts.push(String(b.text ?? ""));
        else if (b.type === "thinking") parts.push(`[thinking] ${String(b.thinking ?? "")}`);
        else if (b.type === "tool_use") parts.push(`[tool_use ${String(b.name)}] ${JSON.stringify(b.input)}`);
        else if (b.type === "tool_result") {
          if (elide?.has(String(b.tool_use_id ?? ""))) { parts.push(`[skill body shown in its own span]`); continue; }
          const rc = b.content;
          parts.push(`[tool_result] ${typeof rc === "string" ? rc : JSON.stringify(rc)}`);
        }
      }
      text = parts.join("\n");
    }
    out.push(`### ${role}\n${text}`);
  }
  return out.join("\n\n");
}

/** A skill loaded mid-conversation via the Skill tool lands as a (potentially large) tool_result in
 * the transcript — otherwise buried inside `messages`. Pull each one into its own labelled slice so it
 * gets its own span (parallel to per-tool spans), and report which tool_result ids to elide. Pure. */
function skillSections(entries: unknown[]): { sections: ContextSection[]; elide: Set<string> } {
  const names = new Map<string, string>(); // tool_use_id -> skill name
  for (const e of entries) {
    const m = asRec(asRec(e).message);
    for (const b of asArr(m.content).map(asRec)) {
      if (b.type === "tool_use" && String(b.name) === "Skill") {
        const inp = asRec(b.input);
        names.set(String(b.id ?? ""), String(inp.command ?? inp.skill ?? inp.name ?? "skill"));
      }
    }
  }
  const sections: ContextSection[] = [];
  const elide = new Set<string>();
  for (const e of entries) {
    const m = asRec(asRec(e).message);
    for (const b of asArr(m.content).map(asRec)) {
      const id = String(b.tool_use_id ?? "");
      if (b.type === "tool_result" && names.has(id)) {
        const rc = b.content;
        sections.push({ label: `skill: ${names.get(id)}`, text: typeof rc === "string" ? rc : JSON.stringify(rc) });
        elide.add(id);
      }
    }
  }
  return { sections, elide };
}

const FCTX_MAX = 400_000; // char cap: truncate with a marker rather than drop silently (fctx-size-aware)

/** One readable slice of the context: a label + its text (becomes one Langfuse span). */
export interface ContextSection {
  label: string;
  text: string;
}

/** Rough token estimate (~chars/4) — good enough to see which section dominates; marked "~" everywhere. */
export function estTokens(s: string): number {
  return Math.round(s.length / 4);
}
/** Compact token label, e.g. 5893 → "5.9k", 120 → "120". */
export function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
}

/** Break the ENTIRE context into labelled sections (system prompt / each tool / messages), so each
 * becomes its OWN Langfuse span with an estimated token count in the name — legible at a glance instead
 * of one 80k-char wall. Boot-captured prefix + live messages (fctx-captures-entire-request). Pure. */
export function fullContextSections(prefix: ContextPrefix | null, entries: unknown[], appended?: { label: string; text: string }[]): ContextSection[] {
  const sections: ContextSection[] = [];
  if (prefix) {
    // ONE span per system block, and — crucially — peel out anything WE appended. Claude Code sends
    // the system prompt as an ARRAY, but `--append-system-prompt-file` (the agent's AGENTS.md identity,
    // any extra appended prompt) is CONCATENATED onto the tail of the base block, not added as a new
    // block. Since we know the file content we appended, we locate it and split it into its own span —
    // so the identity is legible on its own instead of buried in the base prompt. Fully generic: pass
    // any appended blob and it surfaces as its own labelled section.
    const n = prefix.system.length;
    prefix.system.forEach((blk, i) => {
      let base = blk;
      const peeled: ContextSection[] = [];
      for (const a of appended ?? []) {
        const anchor = a.text.trim().slice(0, 48); // stable head of the appended file, verbatim in the block
        const at = anchor ? base.indexOf(anchor) : -1;
        if (at >= 0) {
          peeled.push({ label: a.label, text: base.slice(at) });
          base = base.slice(0, at).replace(/\s+$/, "");
        }
      }
      if (base) sections.push({ label: n > 1 ? `system prompt [${i + 1}/${n}]` : "system prompt", text: base });
      sections.push(...peeled);
    });
    for (const t of prefix.tools) sections.push({ label: `tool: ${t.name}`, text: `${t.description ?? ""}\n\ninput_schema: ${JSON.stringify(t.input_schema, null, 2)}` });
  } else {
    sections.push({ label: "system prompt", text: "(prefix not captured at boot — see runtime logs)" });
  }
  const skills = skillSections(entries);
  sections.push(...skills.sections);
  let msgs = messagesFromTranscript(entries, skills.elide);
  if (msgs.length > FCTX_MAX) msgs = msgs.slice(0, FCTX_MAX) + `\n\n…[truncated ${msgs.length - FCTX_MAX} chars]`;
  sections.push({ label: "messages", text: msgs });
  return sections;
}

// --- zero-dep post to Langfuse's ingestion API (obs-zero-dep) --------------------------------------

/** Build the Langfuse `/api/public/ingestion` batch for one neutral trace: a trace + a generation
 * (token usage) + a span per tool call. Pure (ids/timestamp injected) so it is unit-tested. */
export function buildLangfuseBatch(t: NeutralTrace, ids: () => string, ts: string, sections?: ContextSection[]): { batch: unknown[] } {
  const traceId = ids();
  const cost = costOf(t.model, t.tokens); // cache-aware USD; sent explicitly so v2 shows cost
  const meta = { agent: t.agent, backend: t.backend, model: t.model, skills: t.skills, tools: t.tools.map((x) => x.name) };
  // Name the trace per-agent so Langfuse groups cost/usage BY AGENT out of the box (the fleet view);
  // tags make agent + backend first-class filters. Falls back to the generic label if agent unknown.
  const name = t.agent ? `${t.agent}-turn` : "agent-turn";
  const tags = [t.agent ? `agent:${t.agent}` : null, t.backend ? `backend:${t.backend}` : null].filter(Boolean) as string[];
  const batch: unknown[] = [
    { id: ids(), type: "trace-create", timestamp: ts, body: { id: traceId, name, sessionId: t.session, userId: t.user, input: t.prompt, output: t.reply, metadata: meta, tags } },
    {
      id: ids(),
      type: "generation-create",
      timestamp: ts,
      body: {
        id: ids(),
        traceId,
        name: "generation",
        model: t.model,
        input: t.prompt,
        output: t.reply,
        usage: {
          input: t.tokens.input,
          output: t.tokens.output,
          // `total` reflects the REAL billable size INCLUDING the cache tiers, so Langfuse's headline
          // usage widget agrees with the cost at a glance. v2's widget natively shows only input+output
          // and hides the cache-creation/-read tokens that dominate the bill (a cold turn is ~99%
          // cache-write) — leaving "80 tokens" next to "$0.17". input/output stay pure; the gap between
          // them and `total` IS the cache. The precise per-tier split stays in `metadata` below.
          total: (t.tokens.input || 0) + (t.tokens.output || 0) + (t.tokens.cacheRead || 0) + (t.tokens.cacheCreation || 0),
          unit: "TOKENS",
          inputCost: cost.input,
          outputCost: cost.output,
          totalCost: cost.total,
        },
        metadata: {
          backend: t.backend,
          cache_read_input_tokens: t.tokens.cacheRead,
          cache_creation_input_tokens: t.tokens.cacheCreation,
          // per-tier USD so "$ spent just re-caching the system prompt" is legible, not folded into total
          cost_input: cost.input,
          cost_output: cost.output,
          cost_cache_write: cost.cacheWrite,
          cost_cache_read: cost.cacheRead,
        },
      },
    },
  ];
  for (const tool of t.tools) {
    batch.push({ id: ids(), type: "span-create", timestamp: ts, body: { id: ids(), traceId, name: "tool:" + tool.name, input: tool.input, output: tool.output } });
  }
  // full-context sections (fctx-attaches-to-trace): ONE span per section (system prompt / each tool /
  // messages), each with an estimated token count in its name — so the trace shows what's eating
  // context at a glance, not one opaque wall of text. `startTime` steps by 1ms to keep display order.
  if (sections) {
    const base = Date.parse(ts) || 0;
    sections.forEach((s, i) => {
      const tok = estTokens(s.text);
      batch.push({
        id: ids(),
        type: "span-create",
        timestamp: ts,
        body: { id: ids(), traceId, name: `ctx: ${s.label} · ~${fmtTokens(tok)} tok`, startTime: new Date(base + i).toISOString(), input: s.text, metadata: { chars: s.text.length, est_tokens: tok } },
      });
    });
  }
  return { batch };
}

/** POST a neutral trace to the sink. Best-effort (obs-nonfatal): returns ok/err, never throws. */
export async function postTrace(sink: Sink, t: NeutralTrace, fetchImpl: typeof fetch = fetch, sections?: ContextSection[]): Promise<{ ok: boolean; status?: number; error?: string }> {
  try {
    const body = JSON.stringify(buildLangfuseBatch(t, () => randomUUID(), new Date().toISOString(), sections));
    const auth = Buffer.from(`${sink.publicKey}:${sink.secretKey}`).toString("base64");
    const res = await fetchImpl(`${sink.baseUrl}/api/public/ingestion`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Basic ${auth}` },
      body,
    });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// --- registration: write the post-turn hook into the runtime's settings (obs-runtime-registers) ----

/** Merge a Stop hook running `command` into a Claude Code settings object (pure). Idempotent: replaces
 * any prior tonoman Stop hook, preserves everything else. */
export function withStopHook(settings: Rec, command: string): Rec {
  const s: Rec = { ...settings };
  const hooks = asRec(s.hooks);
  s.hooks = { ...hooks, Stop: [{ hooks: [{ type: "command", command }] }] };
  return s;
}

/** Register the tonoman trace hook into `<configDir>/settings.json`. The hook command runs THIS
 * tonoman build's internal trace-hook (`node <cli> __trace-hook`), so the transcript decoder + sink
 * live in tonoman, not a baked image script. Idempotent; safe on every boot. */
export async function registerClaudeHook(configDir: string, cliPath: string): Promise<void> {
  const p = path.join(configDir, "settings.json");
  let cur: Rec = {};
  try {
    cur = JSON.parse(await fs.readFile(p, "utf8")) as Rec;
  } catch {
    /* no/invalid settings yet */
  }
  await fs.mkdir(configDir, { recursive: true });
  const command = `node ${JSON.stringify(cliPath).slice(1, -1)} __trace-hook`;
  await fs.writeFile(p, JSON.stringify(withStopHook(cur, command), null, 2));
}
