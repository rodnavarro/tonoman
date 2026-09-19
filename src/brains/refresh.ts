// A brain organising itself, in the background (BRAIN-BACKGROUND-REFRESH, BRAIN-CONNECTIONS,
// BRAIN-TRAVERSAL-FILES, BRAIN-LOCAL-MODEL).
//
// After a person's or a Talent's push, the brain's pushed state is read in a temporary checkout and:
//   - the map is built from what the pages say: links, the folder hierarchy, pages nothing links to;
//   - the local model tags pages it has not seen (or that changed since), and pages that share a topic
//     are connected even when nothing links them — a "related" edge, and a hub page for the topic;
//   - the refresh's own files are written under `.tonoman/`: index.md (the map), hubs/, orphans.md,
//     pages.json (what the model said, by page content, so an unchanged page is never asked twice) and
//     log.md (what each refresh did). No page is ever rewritten.
//   - the graph and the brain's freshness go to the registry for the Hub.
// If the local model is configured but unreachable, the refresh waits — it never sends a brain's
// content to another provider instead.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { buildGraph, graphStats, type Graph, type GraphEdge } from "../secondbrain/wiki-reindex/graph";
import { readOrders } from "../secondbrain/wiki-reindex/reindex";
import { parseEnrichment, pageExcerpt } from "../secondbrain/wiki-reindex/enrich";
import { inferChat, type LlmProvider } from "../secondbrain/wiki-reindex/llm";
import { isRefreshPath, type BrainRef, type BrainStore } from "./store";

export interface RefreshPublish {
  state: "fresh" | "stale" | "failed";
  revision?: string;
  generatedAt?: string;
  stats?: Record<string, number>;
  graph?: Graph;
  detail?: string;
}

export interface RefreshDeps {
  store: Pick<BrainStore, "withCheckout" | "writeFiles">;
  /** The local model. Absent = no connections are made; the map is still built. */
  provider?: LlmProvider;
  /** One model call; defaults to the provider's chat endpoint. Injected in tests. */
  infer?: (system: string, user: string) => Promise<string>;
  /** Is the local model up? Defaults to asking its /models endpoint. */
  available?: () => Promise<boolean>;
  publish(brainId: string, p: RefreshPublish): Promise<void>;
  /** Pages the model is asked about per refresh; the rest wait for the next one. */
  budget?: number;
  now?: () => Date;
  log?: (s: string) => void;
}

interface PageNote {
  blob: string;
  summary: string;
  tags: string[];
}

const TAG_SYSTEM =
  "You index one page of a team's knowledge base. Reply with STRICT JSON only: " +
  '{"summary": "<one sentence, <=160 chars, plain>", "tags": ["<2 to 5 short lowercase topics this page is about>"]}. ' +
  "Tags are topics a reader would group pages by (a project, a client, a technology), not words from the title. No markdown, no extra text.";

function gitOut(dir: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile("git", ["-C", dir, ...args], { maxBuffer: 1 << 28, windowsHide: true }, (e, so) => (e ? reject(e) : resolve(so))),
  );
}

/** PURE: a tag as a file name. */
export function hubSlug(tag: string): string {
  return tag.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "topic";
}

/** PURE: pages that share a topic, as "related" edges — only topics small enough to mean something,
 *  and never an edge the links already draw. */
export function relatedEdges(notes: Map<string, PageNote>, existing: GraphEdge[], maxPerTopic = 12): { edges: GraphEdge[]; topics: Map<string, string[]> } {
  const topics = new Map<string, string[]>();
  for (const [id, n] of notes) for (const t of n.tags) (topics.get(t) ?? topics.set(t, []).get(t)!).push(id);
  const have = new Set(existing.map((e) => [e.source, e.target].sort().join("\0")));
  const edges: GraphEdge[] = [];
  for (const [, ids] of topics) {
    if (ids.length < 2 || ids.length > maxPerTopic) continue;
    const sorted = [...ids].sort();
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const k = [sorted[i], sorted[j]].join("\0");
        if (have.has(k)) continue;
        have.add(k);
        edges.push({ source: sorted[i]!, target: sorted[j]!, kind: "related" });
      }
    }
  }
  const kept = new Map([...topics].filter(([, ids]) => ids.length >= 2));
  return { edges, topics: kept };
}

/** PURE: a page's links as the graph reads them, `](/<page>)`. People and agents write ordinary
 *  relative links (`](pricing.md)`, `](../Team/offsite.md)`); the graph only resolves ones from the
 *  brain's root. A link to a web address, an anchor, or out of the brain is left as it is. */
export function rootedLinks(pageId: string, text: string, sub = ""): string {
  return text.replace(/\]\(([^)\s]+)/g, (whole, href: string) => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("#")) return whole;
    if (href.startsWith("/")) return sub && href.startsWith(`/${sub}/`) ? `](${href.slice(sub.length + 1)}` : whole;
    const to = path.posix.normalize(path.posix.join(path.posix.dirname(pageId), href));
    return to.startsWith("..") ? whole : `](/${to}`;
  });
}

/** Every page's lines that carry a link, by page id (relative to the brain's folder). */
async function linkLines(dir: string, sub: string, ids: Set<string>): Promise<Map<string, string>> {
  const out = await gitOut(dir, ["grep", "-I", "-z", "--no-color", "-F", "-e", "](", "HEAD", "--", sub ? `${sub}/*.md` : "*.md"]).catch(() => "");
  const byPage = new Map<string, string[]>();
  for (const rec of out.split("\n")) {
    const nul = rec.indexOf("\0");
    if (nul < 0) continue;
    const full = rec.slice(0, nul).replace(/^HEAD:/, "");
    const id = (sub ? full.slice(sub.length + 1) : full).replace(/\.md$/i, "");
    if (!ids.has(id)) continue;
    (byPage.get(id) ?? byPage.set(id, []).get(id)!).push(rootedLinks(id, rec.slice(nul + 1), sub));
  }
  return new Map([...byPage].map(([k, v]) => [k, v.join("\n")]));
}

const link = (id: string, label?: string) => `[${(label ?? id).replace(/[[\]()]/g, " ").trim()}](../${id}.md)`;

/** PURE: the refresh's map of the brain. */
export function renderIndex(g: Graph, notes: Map<string, PageNote>, topics: Map<string, string[]>, orphans: string[], when: Date, name: string): string {
  const label = new Map(g.nodes.map((n) => [n.id, n.label]));
  const top = [...g.nodes].filter((n) => !n.stub).sort((a, b) => b.degree - a.degree).slice(0, 30);
  const lines = [
    `# ${name} — map`,
    "",
    `_Kept by Tonoman, refreshed ${when.toISOString().slice(0, 16).replace("T", " ")} UTC. ${g.nodes.length} pages, ${orphans.length} with nothing linking to them._`,
    "_Read this first, then the hub for a topic, then search. Pages are never changed by this._",
    "",
    "## Topics",
    "",
    ...[...topics]
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 60)
      .map(([t, ids]) => `- [${t}](hubs/${hubSlug(t)}.md) — ${ids.length} pages`),
    "",
    "## Most connected pages",
    "",
    ...top.map((n) => {
      const s = notes.get(n.id);
      return `- ${link(n.id, label.get(n.id))}${s ? ` — ${s.summary}` : ""}`;
    }),
    "",
    orphans.length ? `## Nothing links to these\n\nSee [orphans.md](orphans.md) (${orphans.length}).` : "## Nothing links to these\n\nNone.",
    "",
  ];
  return lines.join("\n");
}

/** Refresh one brain. Returns what it published. */
export async function refreshBrain(d: RefreshDeps, brain: BrainRef, name: string): Promise<RefreshPublish> {
  const now = d.now ?? (() => new Date());
  const log = d.log ?? ((s: string) => console.log(s));
  const budget = d.budget ?? 40;
  const sub = (brain.subpath ?? "").replace(/^\/+|\/+$/g, "");
  const within = (p: string) => (sub ? p.startsWith(`${sub}/`) : true);
  const strip = (p: string) => (sub ? p.slice(sub.length + 1) : p);

  return d.store.withCheckout(brain, async (dir, revision) => {
    // Everything the brain holds, by path and content id — never the refresh's own files.
    const tree = await gitOut(dir, ["ls-tree", "-r", "-l", "-z", "HEAD"]);
    const pages: { path: string; size: number; blob: string }[] = [];
    const orderPaths: string[] = [];
    for (const rec of tree.split("\0")) {
      const tab = rec.indexOf("\t");
      if (tab < 0) continue;
      const [, , blob, size] = rec.slice(0, tab).split(/\s+/);
      const full = rec.slice(tab + 1);
      if (!within(full) || isRefreshPath(full)) continue;
      const p = strip(full);
      if (/^log\.md$/i.test(p)) continue; // the write log is not knowledge
      if (/\.md$/i.test(p)) pages.push({ path: p, size: Number(size) || 0, blob: blob ?? "" });
      else if (/(^|\/)\.order$/.test(p)) orderPaths.push(full);
    }
    const ids = new Set(pages.map((p) => p.path.replace(/\.md$/i, "")));
    const orders = readOrders(dir, orderPaths).map((o) => ({ folder: sub && o.folder.startsWith(`${sub}/`) ? o.folder.slice(sub.length + 1) : o.folder === sub ? "" : o.folder, children: o.children }));
    const content = await linkLines(dir, sub, ids);
    const graph = buildGraph(pages.map((p) => ({ path: p.path, size: p.size })), orders, content);
    const orphans = graph.nodes.filter((n) => n.degree === 0 && !n.stub).map((n) => n.id);

    // What the model has said before, by page content.
    const cacheRel = path.join(dir, sub, ".tonoman", "pages.json");
    const cache = new Map<string, PageNote>(
      Object.entries(JSON.parse(await fs.readFile(cacheRel, "utf8").catch(() => "{}")) as Record<string, PageNote>),
    );
    for (const id of [...cache.keys()]) if (!ids.has(id)) cache.delete(id);

    let tagged = 0;
    let detail: string | undefined;
    if (d.provider || d.infer) {
      const up = d.available ? await d.available() : await modelUp(d.provider!);
      if (!up) {
        // Configured, but not there: wait rather than send the brain anywhere else.
        const waiting: RefreshPublish = { state: "stale", revision, detail: "waiting for the local model" };
        await d.publish(brain.id, waiting);
        log(`brains: refresh of ${brain.id} is waiting for the local model`);
        return waiting;
      }
      const infer = d.infer ?? ((s: string, u: string) => inferChat(d.provider!, s, u));
      const degree = new Map(graph.nodes.map((n) => [n.id, n.degree]));
      const todo = pages
        .map((p) => ({ id: p.path.replace(/\.md$/i, ""), blob: p.blob, size: p.size }))
        // The brain's own guide and index are for finding things, not things to know: mapped, not read.
        .filter((p) => p.size > 0 && !/^(brain|index)$/i.test(p.id) && cache.get(p.id)?.blob !== p.blob)
        .sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0))
        .slice(0, budget);
      let failures = 0;
      for (const p of todo) {
        const md = await fs.readFile(path.join(dir, sub, `${p.id}.md`), "utf8").catch(() => "");
        if (!md.trim()) continue;
        try {
          const n = parseEnrichment(await infer(TAG_SYSTEM, pageExcerpt(p.id, md)));
          if (n.summary) cache.set(p.id, { blob: p.blob, summary: n.summary, tags: n.tags });
          tagged++;
          failures = 0;
        } catch {
          // Three in a row means the model went away mid-refresh: keep what was tagged, try the rest later.
          if (++failures >= 3) {
            detail = "the local model stopped answering; the rest will be tagged next time";
            break;
          }
        }
      }
    } else {
      detail = "no local model is set up, so pages are mapped but not connected";
    }

    const { edges, topics } = relatedEdges(cache, graph.edges);
    const full: Graph = { ...graph, edges: [...graph.edges, ...edges] };
    const labels = new Map(graph.nodes.map((n) => [n.id, n.label]));
    const when = now();
    const files: { path: string; content: string }[] = [
      { path: ".tonoman/index.md", content: renderIndex(graph, cache, topics, orphans, when, name) },
      {
        path: ".tonoman/orphans.md",
        content: ["# Pages nothing links to", "", ...orphans.map((id) => `- ${link(id, labels.get(id))}`), ""].join("\n"),
      },
      { path: ".tonoman/pages.json", content: JSON.stringify(Object.fromEntries(cache), null, 0) },
      ...[...topics].map(([t, members]) => ({
        path: `.tonoman/hubs/${hubSlug(t)}.md`,
        content: [
          `# ${t}`,
          "",
          `_Pages about ${t}, gathered by Tonoman from what they say — they need not link to each other._`,
          "",
          ...members.map((id) => `- [${(labels.get(id) ?? id).replace(/[[\]()]/g, " ").trim()}](../../${id}.md) — ${cache.get(id)?.summary ?? ""}`),
          "",
        ].join("\n"),
      })),
    ];
    const prior = await fs.readFile(path.join(dir, sub, ".tonoman", "log.md"), "utf8").catch(() => "# Refresh log\n\n");
    const stats = { ...graphStats(graph), related: edges.length, topics: topics.size, tagged };
    files.push({
      path: ".tonoman/log.md",
      content: `${prior}${prior.endsWith("\n") ? "" : "\n"}- ${when.toISOString().slice(0, 16).replace("T", " ")} UTC · ${graph.nodes.length} pages · ${stats.links} links · ${edges.length} connections by topic · ${tagged} pages newly read · ${orphans.length} orphans\n`,
    });
    const w = await d.store.writeFiles({ brain, files, note: "Refresh: map, hubs and connections", who: "Tonoman", system: true });
    if (!w.ok) {
      const failed: RefreshPublish = { state: "failed", revision, detail: w.detail };
      await d.publish(brain.id, failed);
      return failed;
    }
    const done: RefreshPublish = { state: "fresh", revision, generatedAt: when.toISOString(), stats, graph: full, ...(detail ? { detail } : {}) };
    await d.publish(brain.id, done);
    log(`brains: refreshed ${brain.id} — ${graph.nodes.length} pages, ${edges.length} connections, ${tagged} newly read`);
    return done;
  });
}

async function modelUp(p: LlmProvider): Promise<boolean> {
  try {
    const r = await fetch(`${p.url}/models`, { headers: p.key ? { authorization: `Bearer ${p.key}` } : {}, signal: AbortSignal.timeout(5000) });
    return r.ok;
  } catch {
    return false;
  }
}

/** One refresh at a time (a small GPU serves one request at a time), a short wait after the last push
 *  so a burst of notes is refreshed once, and a longer one when the model was not there. */
export function createRefreshQueue(o: {
  run: (brain: BrainRef) => Promise<RefreshPublish>;
  /** Mark a brain stale the moment it is queued, so the Hub says so. */
  stale?: (brain: BrainRef) => Promise<void>;
  delayMs?: number;
  retryMs?: number;
  log?: (s: string) => void;
}) {
  const delay = o.delayMs ?? 60_000;
  const retry = o.retryMs ?? 10 * 60_000;
  const log = o.log ?? ((s: string) => console.log(s));
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const pending = new Map<string, BrainRef>();
  let chain: Promise<void> = Promise.resolve();
  const schedule = (b: BrainRef, ms: number) => {
    clearTimeout(timers.get(b.id));
    pending.set(b.id, b);
    const t = setTimeout(() => {
      timers.delete(b.id);
      const brain = pending.get(b.id)!;
      pending.delete(b.id);
      chain = chain.then(async () => {
        try {
          const r = await o.run(brain);
          if (r.state === "stale") schedule(brain, retry);
        } catch (e) {
          log(`brains: refresh of ${brain.id} failed — ${(e as Error).message}`);
        }
      });
    }, ms);
    (t as { unref?: () => void }).unref?.();
    timers.set(b.id, t);
  };
  return {
    touch(b: BrainRef): void {
      void o.stale?.(b).catch(() => {});
      schedule(b, delay);
    },
    /** For tests and shutdown: wait for whatever is running. */
    idle: () => chain,
    stop(): void {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    },
  };
}
