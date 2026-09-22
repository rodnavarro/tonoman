// The brain tool, served by the worker to the turns it runs.
//
// A turn never opens brain files. It asks this broker, over localhost, with a token minted for that
// one turn. Every call re-asks the registry who the speaker is and what they reach, so a grant or a
// revoke takes effect on the next call (BRAIN-GRANTS-DECIDE, BRAIN-GRANT-TIMING). The broker records
// which brains the turn used before it hands anything back (BRAIN-USED-DECIDES), and meters one
// budget for everything the turn reads (BRAIN-BOUNDED).
//
// The harness reaches the broker through a tiny MCP server over stdio (`mcpShimSource`), written to
// disk once at start. Its token is in the turn's own MCP configuration: readable by that turn, and
// worth nothing beyond that turn's own reach.

import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { BrainRef, BrainStore } from "./store";
import { seed, seedFiles, safePagePath } from "./store";
import { brainFailureText, isSetupFault, SETUP_FAULT_TEXT } from "./credential";
import { cliSource, toolShimSource } from "./cli";
import { checkReceipt, documentTrouble, planReceipt, reportOf, totals, type FiledOutcome, type Plan } from "../receipts/receipts";

export interface Reachable {
  id: string;
  name: string;
  slug: string;
  kind: "personal" | "shared";
  state: "not_created" | "active";
  repoUrl: string | null;
  repoName: string | null;
  ownerName: string | null;
  mode: "read" | "write";
  own: boolean;
  subpath?: string | null;
  branch?: string | null;
  /** Kept exactly as it is (BRAIN-AS-IS): a records repo like finances. */
  asIs?: boolean;
}

export interface Reach {
  tenant: string;
  speaker: { accountId: string | null; name: string | null; member: boolean };
  brains: Reachable[];
}

export interface BrainsRegistry {
  reach(agentGuid: string, slackUserId: string): Promise<Reach>;
  recordRepo(brainId: string, repoUrl: string, repoName: string): Promise<void>;
}

export interface Provisioner {
  /** Create (or adopt) the remote repo for a brain, empty. */
  create(tenant: string, brain: Reachable): Promise<{ repoUrl: string; repoName: string }>;
  /** The credential for a repo this provisioner made. */
  token(): Promise<string>;
}

export interface TurnSpec {
  agentGuid: string;
  slackUserId: string;
  /** How the turn's person is named in log.md. */
  who: string;
  /** The turn's own folder: the only place a file it files may come from (CONVO-FILES-IN-THE-TURN). */
  cwd?: string;
  /** The Receipts Talent, when it is on for the agent: the brain it files into (TALENT-BRAIN-SETTING)
   *  and the tenant's legal entities. Absent = `tonoman receipts` says it is off (CLI-GRANTED-GROUPS). */
  receipts?: { brainId: string; entities?: string[]; version?: number };
}

/** A run of a Talent begun by a conversation (RUN-FROM-CONVERSATION), content-free. */
export interface ConversationRun {
  agentGuid: string;
  slackUserId: string;
  talent: string;
  version: number;
  itemKey: string;
  status: "done" | "failed";
  summary: string;
}

export interface McpServerSpec {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** The `tonoman` command for one turn: the folder that is its whole PATH, and its environment. */
export interface TurnCli {
  binDir: string;
  env: Record<string, string>;
}

interface Turn extends TurnSpec {
  /** What the person sent, as it arrived, by name (RECEIPT-FILES-WHAT-WAS-SENT). */
  attachments?: Map<string, Buffer>;
  used: Set<string>;
  /** Brains this turn has fetched fresh already: its first look at each is the latest push. */
  fetched: Set<string>;
  bytes: number;
  expiresAt: number;
  /** Saves what the turn used, durably, before the broker hands anything back. */
  onUse?: (brainId: string) => Promise<void>;
}

export interface TurnHooks {
  /** Called — and awaited — the first time a turn uses each brain, before any of it is returned. If
   *  it fails, nothing is returned: a use that is not on record could later be repeated in public. */
  onUse?: (brainId: string) => Promise<void>;
}

export interface BrokerOptions {
  store: BrainStore;
  registry: BrainsRegistry;
  provisioner?: Provisioner;
  /** Token for a brain's remote (the provisioner's, unless a brain is somewhere else). */
  scratch: string;
  /** Where `tonoman` and its tool are installed: a folder every turn's user can read and run from and
   *  none can change (TURNUSER-TOOLS-REACHABLE). `scratch` when not given — the worker's own state,
   *  which only a turn running as the worker could reach. */
  toolsDir?: string;
  budgetBytes?: number;
  log?: (s: string) => void;
  /** The node binary that runs the shim and the CLI; the worker's own by default. */
  node?: string;
  /** Record a Talent's run begun by a conversation (best-effort). */
  recordRun?: (run: ConversationRun) => Promise<void>;
}

const INDEX_HEAD_BYTES = 4000;

/** PURE: cut text to a byte budget, saying so. */
export function withinBudget(text: string, left: number): { text: string; cut: boolean } {
  if (Buffer.byteLength(text) <= left) return { text, cut: false };
  if (left <= 200) return { text: "", cut: true };
  const buf = Buffer.from(text).subarray(0, left - 120).toString("utf8").replace(/�$/, "");
  return { text: `${buf}\n\n[…cut: this turn's reading budget is nearly spent]`, cut: true };
}

/** PURE: find the brain a caller named — by id, by exact name, or by a unique case-insensitive name. */
export function pickBrain(brains: Reachable[], named: unknown): Reachable | undefined {
  if (typeof named !== "string" || !named.trim()) return undefined;
  const n = named.trim();
  const byId = brains.find((b) => b.id === n);
  if (byId) return byId;
  const exact = brains.filter((b) => b.name === n || b.slug === n);
  if (exact.length === 1) return exact[0];
  const loose = brains.filter((b) => b.name.toLowerCase() === n.toLowerCase());
  return loose.length === 1 ? loose[0] : undefined;
}

function describe(b: Reachable): string {
  const whose = b.own ? "yours" : b.ownerName ? `${b.ownerName}'s` : "shared";
  const state = b.state === "not_created" ? ", empty so far" : "";
  return `${b.name} (${whose}, ${b.mode === "write" ? "read and write" : "read only"}${state})`;
}

export function createBroker(o: BrokerOptions) {
  const log = o.log ?? ((s: string) => console.log(s));
  const budget = o.budgetBytes ?? 160_000;
  const turns = new Map<string, Turn>();
  // BRAIN-REFUSED-IS-NOT-RETRIED: the brains whose repository refused the credential during a turn.
  // Nothing goes back to git for one of them while that turn lasts - the answer is already known,
  // and an agent told "just now" tried thirteen times. A later turn tries afresh: it may be fixed.
  const refused = new WeakMap<Turn, Set<string>>();
  const refusedIn = (t: Turn): Set<string> => refused.get(t) ?? (refused.set(t, new Set()), refused.get(t)!);
  let baseUrl = "";
  let shimPath = "";
  let cliBin = "";
  let cliPath = "";

  const refOf = (tenant: string, b: Reachable): BrainRef => ({
    id: b.id,
    name: b.name,
    tenant,
    slug: b.slug,
    kind: b.kind,
    repoUrl: b.repoUrl!,
    subpath: b.subpath ?? undefined,
    branch: b.branch ?? undefined,
    ...(b.asIs ? { asIs: true } : {}),
  });

  /** The Receipts Talent's brain, as this speaker reaches it — or why not. */
  function receiptsBrain(t: Turn, reach: Reach, need: "read" | "write"): { b: Reachable } | { status: number; text: string } {
    if (!t.receipts) return { status: 403, text: "Receipts is not on for this agent, so `tonoman receipts` does nothing here." };
    if (!reach.speaker.member) return { status: 403, text: "This person is not a member of the tenant, so they cannot file or read receipts." };
    const b = reach.brains.find((x) => x.id === t.receipts!.brainId);
    // Turning the Talent on widens nobody's reach (RECEIPT-WHO-MAY-FILE).
    if (!b || (need === "write" && b.mode !== "write")) {
      return { status: 403, text: `This person cannot ${need === "write" ? "file into" : "read"} the brain Receipts files into. Nothing was ${need === "write" ? "written" : "read"}.` };
    }
    if (b.state !== "active" || !b.repoUrl) return { status: 409, text: `${b.name} has not been set up yet.` };
    // "Filed" means on `main`, with nothing else added (RECEIPT-SAME-LAYOUT, BRAIN-AS-IS): a brain on
    // another branch, or one the worker keeps a log and a map in, is not where receipts go.
    if (need === "write" && (!b.asIs || (b.branch ?? "main") !== "main")) {
      return { status: 409, text: `Not filed. Receipts files only into a brain kept as it is, on main; ${b.name} is not set up that way. Tell the person to check the Receipts settings in the Hub.` };
    }
    return { b };
  }

  /** The file a receipt names: one the person sent, exactly as it arrived. The worker hands those
   *  over before the agent runs (`attach`), so nothing the agent does in its folder — a file it made,
   *  a copy it changed, a link to somewhere else — can be filed, and the broker never opens a path the
   *  turn controls (RECEIPT-FILES-WHAT-WAS-SENT). */
  async function turnFile(t: Turn, named: unknown): Promise<{ bytes: Buffer; name: string } | { status: number; text: string }> {
    if (typeof named !== "string" || !named.trim()) return { status: 400, text: "Name the attached file (it is in this turn's folder)." };
    const name = named.trim();
    // By its name: `photo.jpg`, `./photo.jpg`, or the path the agent was shown for it in its own
    // folder. That is worked out from the words alone — nothing is opened — so a path to anywhere
    // else is refused even when its last part is the name of something the person sent.
    const plain = path.basename(name);
    const shown = !/[\\/]/.test(name) || (!!t.cwd && path.resolve(t.cwd, name) === path.join(path.resolve(t.cwd), plain));
    const bytes = shown ? t.attachments?.get(plain) : undefined;
    if (!bytes) return { status: 403, text: `"${name}" is not a file the person sent in this conversation. Only a file they sent can be filed.` };
    const trouble = documentTrouble(plain, bytes);
    if (trouble) return { status: 422, text: `Not filed. ${trouble}` };
    return { bytes, name: plain };
  }

  async function runOf(t: Turn, itemKey: string, ok: boolean, summary: string): Promise<void> {
    await o.recordRun?.({ agentGuid: t.agentGuid, slackUserId: t.slackUserId, talent: "receipts", version: t.receipts?.version ?? 1, itemKey, status: ok ? "done" : "failed", summary }).catch(() => {});
  }

  /** Make a brain's repo on its first use (BRAIN-REPO-ON-FIRST-USE). Only the owner's own turn does. */
  async function provision(tenant: string, b: Reachable): Promise<Reachable> {
    if (!o.provisioner) throw new Error("brains cannot be created on this worker (no git host configured)");
    const made = await o.provisioner.create(tenant, b);
    await seed(made.repoUrl, await o.provisioner.token(), seedFiles(b.name), o.scratch);
    await o.registry.recordRepo(b.id, made.repoUrl, made.repoName);
    log(`brains: created ${made.repoName} for ${b.id}`);
    return { ...b, state: "active", repoUrl: made.repoUrl, repoName: made.repoName };
  }

  /** Record that a turn used these brains, durably, BEFORE anything of them is returned. */
  async function mark(t: Turn, ids: string[]): Promise<void> {
    for (const id of ids) {
      if (t.used.has(id)) continue;
      if (t.onUse) await t.onUse(id);
      t.used.add(id);
    }
  }

  /** A turn's first look at a brain fetches it fresh; later looks in the same turn use that fetch. */
  async function first(t: Turn, tenant: string, b: Reachable): Promise<void> {
    if (t.fetched.has(b.id) || b.state !== "active" || !b.repoUrl) return;
    await o.store.refresh(refOf(tenant, b));
    t.fetched.add(b.id);
  }

  function charge(t: Turn, text: string): string {
    const r = withinBudget(text, budget - t.bytes);
    t.bytes += Buffer.byteLength(r.text);
    return r.text || "[nothing returned: this turn's reading budget is spent — say what you could not look at]";
  }

  type Handler = (t: Turn, reach: Reach, body: Record<string, unknown>) => Promise<{ status: number; text: string }>;

  const handlers: Record<string, Handler> = {
    async list(t, reach) {
      if (!reach.speaker.member) return { status: 200, text: "This person is not a member of the tenant, so they reach no brains." };
      if (reach.brains.length === 0) return { status: 200, text: "This person reaches no brains." };
      // Every brain named here counts as used, even an empty one: its name and whose it is are
      // things the audience may not be allowed to know.
      await mark(t, reach.brains.map((b) => b.id));
      const parts: string[] = [];
      for (const b of reach.brains) {
        parts.push(`## ${describe(b)}\nid: ${b.id}`);
        if (b.state !== "active" || !b.repoUrl) continue;
        await first(t, reach.tenant, b).catch(() => {});
        const idx = await o.store.read(refOf(reach.tenant, b), "index.md").catch(() => null);
        if (idx) parts.push(`index.md (start):\n${idx.content.slice(0, INDEX_HEAD_BYTES)}`);
        // The refresh's map: topics, each linking to a hub page that gathers it (BRAIN-TRAVERSAL-FILES).
        const map = await o.store.read(refOf(reach.tenant, b), ".tonoman/index.md").catch(() => null);
        if (map) parts.push(`.tonoman/index.md — the map Tonoman keeps (start):\n${map.content.slice(0, INDEX_HEAD_BYTES)}`);
      }
      return { status: 200, text: charge(t, parts.join("\n\n")) };
    },

    async pages(t, reach, body) {
      const b = pickBrain(reach.brains, body.brain);
      if (!b) return { status: 404, text: `No brain called "${String(body.brain ?? "")}" is within reach.` };
      await mark(t, [b.id]);
      if (b.state !== "active" || !b.repoUrl) return { status: 404, text: `${b.name} is empty so far.` };
      await first(t, reach.tenant, b);
      const folder = typeof body.folder === "string" ? body.folder.trim() : "";
      const r = await o.store.pages(refOf(reach.tenant, b), folder, 40);
      const where = folder ? `${b.name} — ${folder}` : b.name;
      if (!r.pages.length) return { status: 200, text: `No pages in ${where}.` };
      const more = r.total > r.pages.length ? `\n…and ${r.total - r.pages.length} more; name a folder to narrow it.` : "";
      return { status: 200, text: charge(t, `## ${where} (${r.total} pages, newest change first)\n${r.pages.map((p) => `${p.day} ${p.path}`).join("\n")}${more}`) };
    },

    async search(t, reach, body) {
      const q = typeof body.query === "string" ? body.query : "";
      if (!q.trim()) return { status: 400, text: "query is required" };
      const pool = body.brain ? [pickBrain(reach.brains, body.brain)].filter(Boolean) as Reachable[] : reach.brains;
      if (body.brain && pool.length === 0) return { status: 404, text: `No brain called "${body.brain}" is within reach.` };
      const out: string[] = [];
      const failed: string[] = [];
      const setupFaults: string[] = [];
      let total = 0;
      for (const b of pool) {
        if (b.state !== "active" || !b.repoUrl) continue;
        if (refusedIn(t).has(b.id) || refusedIn(t).has(b.name)) {
          setupFaults.push(b.name);
          continue;
        }
        let hits: Awaited<ReturnType<typeof o.store.search>>;
        try {
          await first(t, reach.tenant, b);
          hits = await o.store.search(refOf(reach.tenant, b), q, 40 - total);
        } catch (e) {
          if (isSetupFault((e as Error).message ?? "")) {
            refusedIn(t).add(b.id).add(b.name); // asked for by id or by name
            setupFaults.push(b.name);
            log(`brains: search of ${b.name} failed - ${(e as Error).message}`);
            continue;
          }
          failed.push(b.name);
          await mark(t, [b.id]);
          continue;
        }
        if (!hits.length) continue;
        await mark(t, [b.id]);
        total += hits.length;
        out.push(`## ${b.name}\n${hits.map((h) => `${h.path}:${h.line}: ${h.text}`).join("\n")}`);
        if (total >= 40) break;
      }
      const missed =
        (failed.length ? `\n\nCould not search ${failed.join(", ")} just now — say so rather than guessing.` : "") +
        (setupFaults.length ? `\n\n${setupFaults.join(", ")}: ${SETUP_FAULT_TEXT}` : "");
      return { status: 200, text: charge(t, (out.length ? out.join("\n\n") : `Nothing found for "${q}".`) + missed) };
    },

    async read(t, reach, body) {
      const b = pickBrain(reach.brains, body.brain);
      if (!b) return { status: 404, text: `No brain called "${String(body.brain ?? "")}" is within reach.` };
      await mark(t, [b.id]);
      if (b.state !== "active" || !b.repoUrl) return { status: 404, text: `${b.name} is empty so far.` };
      await first(t, reach.tenant, b);
      const page = await o.store.read(refOf(reach.tenant, b), String(body.path ?? ""));
      if (!page) return { status: 404, text: `There is no page "${String(body.path ?? "")}" in ${b.name}.` };
      return { status: 200, text: charge(t, `revision: ${page.blob}\n\n${page.content}`) };
    },

    // A receipt, filed as the Teams Sapien filed it (receipt.md). Evidence and its ledger row in one
    // commit, worked out from the brain's latest state in every push attempt.
    async "receipts.file"(t, reach, body) {
      const target = receiptsBrain(t, reach, "write");
      if (!("b" in target)) return target;
      const file = await turnFile(t, body.file);
      if (!("bytes" in file)) return file;
      const checked = checkReceipt(
        {
          vendor: String(body.vendor ?? ""),
          date: String(body.date ?? ""),
          amount: String(body.amount ?? ""),
          category: String(body.category ?? ""),
          entity: String(body.entity ?? ""),
          docType: typeof body.docType === "string" ? body.docType : undefined,
          year: typeof body.year === "string" ? body.year : undefined,
          note: typeof body.note === "string" ? body.note : undefined,
          extra: body.extra === true || body.extra === "true",
          fileName: file.name,
        },
        t.receipts?.entities ?? [],
      );
      if (!checked.ok) return { status: 422, text: `Not filed. ${checked.ask}` };
      const b = target.b;
      await mark(t, [b.id]);
      const r = await o.store.writeFiles({
        brain: refOf(reach.tenant, b),
        files: [],
        plan: (tree) => planReceipt(checked.r, file.bytes, tree) as Promise<Plan>,
        subject: checked.r.subject,
        note: checked.r.subject,
        who: t.who,
        notify: { agentGuid: t.agentGuid, slackUserId: t.slackUserId },
        recover: { receipt: checked.r, bytes: file.bytes.toString("base64"), entities: t.receipts?.entities ?? [] },
        authorize: async () => {
          if (![...turns.values()].includes(t)) return false;
          const now = await o.registry.reach(t.agentGuid, t.slackUserId);
          return now.brains.some((x) => x.id === b.id && x.mode === "write");
        },
      });
      // The run's item is a fingerprint of the receipt's name, never the name: the run history is seen
      // by the tenant, and the name carries the vendor and the amount (RUN-FROM-CONVERSATION).
      const item = `receipt-${createHash("sha256").update(checked.r.stem).digest("hex").slice(0, 12)}`;
      if (!r.ok) {
        await runOf(t, item, false, "a receipt could not be filed");
        return { status: 502, text: `Not filed: ${r.detail}. Say so; do not say it was filed.` };
      }
      const outcome = r.outcome as FiledOutcome;
      // Nothing was written and the person has something to do: not a run that went well.
      if (outcome.status === "no-original" || outcome.status === "ledger-broken") {
        await runOf(t, item, false, outcome.status === "no-original" ? "no filed receipt to keep another photo beside" : "the ledger needs fixing by hand first");
        return { status: 409, text: reportOf(outcome) };
      }
      await runOf(t, item, true, outcome.status === "filed" ? "filed a receipt" : outcome.status === "extra" ? "kept another photo of a receipt" : "a receipt already on file");
      return { status: 200, text: reportOf(outcome) };
    },

    async "receipts.totals"(t, reach, body) {
      const target = receiptsBrain(t, reach, "read");
      if (!("b" in target)) return target;
      // This year only when none was asked for: "2025x" is a mistake to say, not this year's totals.
      const asked = body.year === undefined || body.year === null || body.year === "" ? undefined : String(body.year).trim();
      if (asked !== undefined && !/^\d{4}$/.test(asked)) return { status: 400, text: `"${asked}" is not a year. Ask for four digits, e.g. 2026.` };
      const year = asked ?? String(new Date().getFullYear());
      const b = target.b;
      await mark(t, [b.id]);
      await first(t, reach.tenant, b);
      let page: Awaited<ReturnType<typeof o.store.read>>;
      try {
        page = await o.store.read(refOf(reach.tenant, b), `${year}/spreadsheet/deductions_ledger.csv`);
      } catch (e) {
        // Could not be read is not "there is none".
        await runOf(t, `totals-${year}`, false, "the year's ledger could not be read");
        return { status: 502, text: `The ${year} ledger could not be read just now (${(e as Error).message.slice(0, 120)}). Say so; do not give totals.` };
      }
      await runOf(t, `totals-${year}`, true, "read the year's totals");
      if (!page) return { status: 200, text: `No ledger for ${year} yet.` };
      const tt = totals(page.content);
      const lines = Object.entries(tt.byCategory)
        .sort((x, y) => y[1].amount - x[1].amount)
        .map(([c, v]) => `${c} — ${v.count} — $${v.amount.toFixed(2)}`);
      const unread = tt.unreadable ? `\n${tt.unreadable} row${tt.unreadable === 1 ? " has" : "s have"} an amount that is not money; counted, not added. Say so.` : "";
      return { status: 200, text: charge(t, `${year}: ${tt.count} entries, $${tt.total.toFixed(2)}\n${lines.join("\n")}${unread}`) };
    },

    // Change a page or a file in place (BRAIN-EDIT-IN-PLACE): the words to find, and the words to put
    // there or to add after them. Worked out on the file as it is on its remote inside every push
    // attempt, so a change someone pushed meanwhile is kept; everything but the words found stays
    // byte for byte. General on purpose (D-BRAINS-ARE-EDITABLE): no Talent has a command of its own
    // for correcting what it filed.
    async edit(t, reach, body) {
      const b = pickBrain(reach.brains, body.brain);
      if (!b) return { status: 404, text: `No brain called "${String(body.brain ?? "")}" is within reach.` };
      if (b.mode !== "write") {
        await mark(t, [b.id]);
        return { status: 403, text: `${b.name} is read only for this person. Nothing was changed.` };
      }
      const file = String(body.path ?? "");
      if (!safePagePath(file)) return { status: 400, text: "That path is not allowed. Use a relative path like `Topic/page.md`." };
      const find = typeof body.find === "string" ? body.find : "";
      const replace = typeof body.replace === "string" ? body.replace : undefined;
      const after = typeof body.after === "string" ? body.after : undefined;
      if (!find) return { status: 400, text: "Say which words to find (--find): enough of the line that it is found only once." };
      if ((replace === undefined) === (after === undefined)) return { status: 400, text: "Give --replace (what to put there instead) or --after (what to add after it): one of them." };
      const put = replace !== undefined ? replace : find + after;
      if (put === find) return { status: 400, text: "That would change nothing." };
      if (Buffer.byteLength(find) > 20_000 || Buffer.byteLength(put) > 60_000) return { status: 400, text: "That is too much to change in one go; change it in smaller pieces." };
      await mark(t, [b.id]);
      if (b.state !== "active" || !b.repoUrl) return { status: 404, text: `${b.name} is empty so far.` };
      const note = (typeof body.note === "string" && body.note.trim()) || `Edited ${file}`;
      type Edited = { status: "edited" } | { status: "no-file" } | { status: "not-text" } | { status: "not-found" } | { status: "many"; n: number };
      const r = await o.store.writeFiles({
        brain: refOf(reach.tenant, b),
        files: [],
        plan: async (tree) => {
          const text = await tree.read(file);
          if (text === null) return { nothing: { status: "no-file" } satisfies Edited };
          // A photo, or a file in an encoding that did not survive being read, is not edited as words.
          if (text.includes("\u0000") || text.includes("\uFFFD")) return { nothing: { status: "not-text" } satisfies Edited };
          const n = text.split(find).length - 1;
          if (n === 0) return { nothing: { status: "not-found" } satisfies Edited };
          if (n > 1) return { nothing: { status: "many", n } satisfies Edited };
          const at = text.indexOf(find);
          return { write: [{ path: file, content: text.slice(0, at) + put + text.slice(at + find.length) }], outcome: { status: "edited" } satisfies Edited };
        },
        subject: note,
        note,
        who: t.who,
        notify: { agentGuid: t.agentGuid, slackUserId: t.slackUserId },
        authorize: async () => {
          if (![...turns.values()].includes(t)) return false;
          const now = await o.registry.reach(t.agentGuid, t.slackUserId);
          return now.brains.some((x) => x.id === b.id && x.mode === "write");
        },
      });
      if (!r.ok) {
        if (r.reason === "bad-path") return { status: 400, text: "That path is not allowed (not log.md, nothing under .tonoman or .git)." };
        if (r.reason === "not-allowed") return { status: 403, text: `Not changed: ${r.detail}.` };
        return { status: 502, text: `Not changed: ${r.detail}. Say so; do not say it was changed.` };
      }
      const e = r.outcome as Edited;
      if (e.status === "edited") return { status: 200, text: `Changed in ${b.name}: ${file} — that one place, nothing else.` };
      if (e.status === "no-file") return { status: 404, text: `There is no "${file}" in ${b.name}. Nothing was changed.` };
      if (e.status === "not-text") return { status: 400, text: `"${file}" is not a text file, so it cannot be edited as words. Nothing was changed.` };
      if (e.status === "not-found") return { status: 404, text: `Not found in ${file}: those exact words are not there, so nothing was changed. Search or read the file for the exact text — spacing, commas and quotes included.` };
      return { status: 409, text: `Those words are in ${e.n} places in ${file}, so nothing was changed. Give more of the line — enough that it is found only once.` };
    },

    async write(t, reach, body) {
      let b = pickBrain(reach.brains, body.brain);
      if (!b) return { status: 404, text: `No brain called "${String(body.brain ?? "")}" is within reach.` };
      if (b.mode !== "write") {
        const writableBrains = reach.brains.filter((x) => x.mode === "write");
        await mark(t, [b.id, ...writableBrains.map((x) => x.id)]);
        const writable = writableBrains.map((x) => x.name);
        return {
          status: 403,
          text: `${b.name} is read only for this person.${writable.length ? ` They can write to: ${writable.join(", ")}.` : " They cannot write to any brain."}`,
        };
      }
      const content = typeof body.content === "string" ? body.content : "";
      const note = typeof body.note === "string" ? body.note : "";
      if (!content.trim()) return { status: 400, text: "content is required" };
      if (Buffer.byteLength(content) > 200_000) return { status: 400, text: "that page is too large to write in one go" };
      await mark(t, [b.id]);
      if (b.state === "not_created") {
        if (!b.own) return { status: 409, text: `${b.name} has not been set up yet; only its owner's first note creates it.` };
        try {
          b = await provision(reach.tenant, b);
        } catch (e) {
          log(`brains: could not create ${b.id}: ${(e as Error).message}`);
          return { status: 502, text: `I could not set up ${b.name} yet, so nothing was saved.` };
        }
      }
      const r = await o.store.write({
        brain: refOf(reach.tenant, b),
        path: String(body.path ?? ""),
        content,
        baseBlob: typeof body.revision === "string" && body.revision ? body.revision : null,
        note,
        who: t.who,
        notify: { agentGuid: t.agentGuid, slackUserId: t.slackUserId },
        // Asked right before the push: is this turn still open, and may the person still write here?
        authorize: async () => {
          if (![...turns.values()].includes(t)) return false;
          const now = await o.registry.reach(t.agentGuid, t.slackUserId);
          return now.brains.some((x) => x.id === b!.id && x.mode === "write");
        },
      });
      if (r.ok) return { status: 200, text: `Saved to ${b.name}: ${r.path}${r.merged ? " (merged with a change someone else made meanwhile)" : ""}.` };
      if (r.reason === "bad-path") return { status: 400, text: "That page name is not allowed. Use a relative path like `Topic/page.md` (not log.md)." };
      if (r.reason === "not-allowed") return { status: 403, text: `Not saved: ${r.detail}.` };
      if (r.reason === "conflict") return { status: 409, text: `Not saved: ${r.detail}. Read the page again and redo the edit. (Kept as ${r.pendingId}.)` };
      return { status: 502, text: `Not saved: ${r.detail}.` };
    },
  };

  const server = http.createServer((req, res) => {
    const send = (status: number, text: string) => {
      res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
      res.end(text);
    };
    const auth = String(req.headers.authorization ?? "");
    const t = turns.get(auth.startsWith("Bearer ") ? auth.slice(7) : "");
    if (!t || t.expiresAt < Date.now()) return send(401, "this turn's brain access has ended");
    const url = (req.url ?? "").replace(/\?.*$/, "");
    const name = url.startsWith("/receipts/") ? `receipts.${url.slice("/receipts/".length)}` : url.replace(/^\/brain\//, "");
    const h = Object.prototype.hasOwnProperty.call(handlers, name) ? handlers[name] : undefined;
    if (req.method !== "POST" || !h) return send(404, "no such tool");
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", async () => {
      let body: Record<string, unknown> = {};
      try {
        body = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>) : {};
      } catch {
        return send(400, "the request was not JSON");
      }
      try {
        // Fresh every call: the speaker's reach at this moment, not at the start of the turn.
        const asked = typeof body.brain === "string" ? body.brain : "";
        if (asked && refusedIn(t).has(asked)) return send(502, SETUP_FAULT_TEXT);
        const reach = await o.registry.reach(t.agentGuid, t.slackUserId);
        const r = await h(t, reach, body);
        // The turn may have ended while this call ran: nothing goes back to a finished turn.
        if (![...turns.values()].includes(t)) return send(401, "this turn's brain access has ended");
        send(r.status, r.text);
      } catch (e) {
        const why = (e as Error).message ?? "";
        log(`brains: ${name} failed — ${why}`);
        const asked = typeof body.brain === "string" ? body.brain : "";
        if (asked && isSetupFault(why)) refusedIn(t).add(asked);
        send(502, brainFailureText(why));
      }
    });
  });

  return {
    async start(): Promise<void> {
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      await fs.mkdir(o.scratch, { recursive: true });
      const tools = o.toolsDir ?? o.scratch;
      if (o.toolsDir) {
        // Root's to write, everyone's to read and run: a turn's user can use `tonoman`, not replace it.
        await fs.mkdir(tools, { recursive: true });
        await fs.chmod(tools, 0o755);
      }
      // `tonoman` as Codex's one tool: the same CLI behind one short schema (cli.md).
      shimPath = path.join(tools, "tonoman-mcp.cjs");
      await fs.writeFile(shimPath, toolShimSource, { mode: 0o644 });
      // The `tonoman` command: a folder holding it and nothing else, which is the turn's whole PATH
      // (CLI-ONLY-THIS-COMMAND). The wrapper runs the CLI with an absolute node, so nothing else need
      // be reachable.
      cliBin = path.join(tools, "bin");
      await fs.mkdir(cliBin, { recursive: true });
      cliPath = path.join(tools, "tonoman-cli.cjs");
      await fs.writeFile(cliPath, cliSource, { mode: 0o644 });
      if (o.toolsDir) for (const p of [cliBin, shimPath, cliPath]) await fs.chmod(p, p === cliBin ? 0o755 : 0o644);
      await fs.writeFile(path.join(cliBin, "tonoman"), `#!/bin/sh\nexec ${JSON.stringify(o.node ?? process.execPath)} ${JSON.stringify(cliPath)} "$@"\n`, { mode: 0o755 });
    },
    get url() {
      return baseUrl;
    },
    /** Make a brain's repo if it has none yet (a Talent's first filing into it). */
    ensureRepo: (tenant: string, b: Reachable): Promise<Reachable> => (b.state === "active" ? Promise.resolve(b) : provision(tenant, b)),
    /** Open a turn's access. Returns the MCP server (Codex) and the `tonoman` command (Claude) — both
     *  on the same token, which works only while the turn runs (CLI-DIES-WITH-TURN). */
    startTurn(spec: TurnSpec, hooks: TurnHooks = {}): { token: string; mcp: McpServerSpec; cli: TurnCli } {
      const token = randomBytes(24).toString("hex");
      turns.set(token, { ...spec, used: new Set(), fetched: new Set(), bytes: 0, expiresAt: Date.now() + 2 * 60 * 60 * 1000, onUse: hooks.onUse });
      const env = { TONOMAN_BRAIN_URL: baseUrl, TONOMAN_BRAIN_TOKEN: token, ...(spec.receipts ? { TONOMAN_RECEIPTS: "1" } : {}) };
      return {
        token,
        mcp: { name: "tonoman", command: o.node ?? process.execPath, args: [shimPath], env: { ...env, TONOMAN_CLI_PATH: cliPath } },
        cli: { binDir: cliBin, env },
      };
    },
    /** What the person sent, handed over by the worker before the agent runs. The same name twice
     *  keeps the first: the worker gives each file a name of its own (CONVO-ATTACHED-FILES). */
    attach(token: string, files: { name: string; bytes: Buffer }[]): void {
      const t = turns.get(token);
      if (!t) return;
      t.attachments ??= new Map();
      for (const f of files) if (!t.attachments.has(f.name)) t.attachments.set(f.name, f.bytes);
    },
    /** The turn's own folder, bound once the turn has made it (CONVO-FILES-IN-THE-TURN). */
    bindFolder(token: string, cwd: string): void {
      const t = turns.get(token);
      if (t) t.cwd = cwd;
    },
    /** Close a turn's access; what it used is handed back once. */
    endTurn(token: string): { used: string[] } {
      const t = turns.get(token);
      turns.delete(token);
      return { used: t ? [...t.used] : [] };
    },
    /** What a turn has used so far (for a turn still running). */
    usedBy(token: string): string[] {
      return [...(turns.get(token)?.used ?? [])];
    },
    async close(): Promise<void> {
      turns.clear();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

export type Broker = ReturnType<typeof createBroker>;

/** The MCP server the harness starts: stdio JSON-RPC in, HTTP to the broker out. Plain CommonJS with
 *  no dependencies, so it runs under any node the image has, compiled or not. */
export const mcpShimSource = String.raw`"use strict";
const URL_ = process.env.TONOMAN_BRAIN_URL, TOKEN = process.env.TONOMAN_BRAIN_TOKEN;
const tools = [
  { name: "brain_list", description: "List the brains this person can reach — whose each is, read or write — with the start of each brain's index.md. Call this first, before searching or writing.", inputSchema: { type: "object", properties: {} } },
  { name: "brain_pages", description: "List the pages of one brain, or of one folder in it, newest change first, with the day each last changed (at most 40, and how many there are). Use it to find the newest pages on a topic, or what a folder holds, instead of guessing paths.", inputSchema: { type: "object", properties: { brain: { type: "string" }, folder: { type: "string", description: "A folder in the brain, e.g. Research/AI (optional: the whole brain)." } }, required: ["brain"] } },
  { name: "brain_search", description: "Search the brains for lines containing all the given words (case-insensitive). Optionally limit to one brain by name.", inputSchema: { type: "object", properties: { query: { type: "string" }, brain: { type: "string", description: "A brain's name or id (optional)." } }, required: ["query"] } },
  { name: "brain_read", description: "Read one page of a brain. Returns its revision: pass that back to brain_write when you edit the page, so someone else's change made meanwhile is merged rather than lost.", inputSchema: { type: "object", properties: { brain: { type: "string" }, path: { type: "string", description: "Relative page path, e.g. AI/typesafe-ai.md" } }, required: ["brain", "path"] } },
  { name: "brain_write", description: "Create or replace one page of a brain the person can write to, and commit it. To edit an existing page, brain_read it first and pass its revision. Confirms only once it is saved; if it is not saved, say so. Also add the page to the brain's index.md or to the hub page for its topic.", inputSchema: { type: "object", properties: { brain: { type: "string" }, path: { type: "string" }, content: { type: "string", description: "The whole page, in Markdown." }, note: { type: "string", description: "One line for the brain's log: what this is." }, revision: { type: "string", description: "The revision brain_read returned, when editing." } }, required: ["brain", "path", "content", "note"] } },
];
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
async function call(name, args) {
  try {
    const r = await fetch(URL_ + "/brain/" + name.replace(/^brain_/, ""), { method: "POST", headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" }, body: JSON.stringify(args || {}) });
    const text = await r.text();
    return { content: [{ type: "text", text }], isError: !r.ok };
  } catch (e) {
    return { content: [{ type: "text", text: "The brain could not be reached just now." }], isError: true };
  }
}
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", async (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id === undefined) continue; // notifications need no answer
    if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: (m.params && m.params.protocolVersion) || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "tonoman-brain", version: "1" } } });
    else if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools } });
    else if (m.method === "tools/call") send({ jsonrpc: "2.0", id: m.id, result: await call(m.params.name, m.params.arguments) });
    else if (m.method === "ping") send({ jsonrpc: "2.0", id: m.id, result: {} });
    else send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "method not found" } });
  }
});
process.stdin.on("end", () => process.exit(0));
`;
