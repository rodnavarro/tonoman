// The reindex RUNNER: reads an Azure DevOps wiki repo through git, builds the knowledge graph, writes
// the Karpathy-style index under a hidden `.tonoman/` folder, and (optionally) commits it. IO lives
// here; the graph rules are in graph.ts and tested there.
//
// WHY GIT, NOT THE FILESYSTEM. The wiki has case-colliding paths (`Axiplex/` and `axiplex/`) that
// NTFS folds into one directory on checkout, so a filesystem walk sees a corrupted tree. Reading
// through `git ls-tree`/`git grep` against HEAD reflects the REPO, which is the source of truth and
// is what a Linux worker would sync anyway.
//
//   npx tsx src/secondbrain/wiki-reindex/reindex.ts <repo-dir> [--commit] [--enrich N] [--only <prefix>]

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildGraph, graphStats, type Graph } from './graph.js';
import { enrichPages, type EnrichDeps } from './enrich.js';
import { ollamaProvider, inferChat, type LlmProvider } from './llm.js';

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 1 << 28 });
}

/** Every `<path>.md` in the repo with its byte size, and every `.order` file's path — from one
 *  `git ls-tree` against HEAD, so the case-colliding working tree is never touched. */
export function readTree(repo: string): { pages: { path: string; size: number }[]; orderPaths: string[] } {
  const out = git(repo, ['ls-tree', '-r', '-l', 'HEAD']);
  const pages: { path: string; size: number }[] = [];
  const orderPaths: string[] = [];
  for (const line of out.split('\n')) {
    if (!line) continue;
    // <mode> <type> <sha> <size>\t<path>
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const meta = line.slice(0, tab).split(/\s+/);
    const size = Number(meta[3]) || 0;
    const p = line.slice(tab + 1);
    if (/\.md$/i.test(p)) pages.push({ path: p, size });
    else if (/(^|\/)\.order$/.test(p)) orderPaths.push(p);
  }
  return { pages, orderPaths };
}

/** Each `.order` file's folder id and the child names it lists. `<folder>/.order` -> folder is the
 *  dirname (''.for the repo root). */
export function readOrders(repo: string, orderPaths: string[]): { folder: string; children: string[] }[] {
  const orders: { folder: string; children: string[] }[] = [];
  for (const op of orderPaths) {
    const folder = op === '.order' ? '' : op.replace(/\/?\.order$/, '');
    let text = '';
    try {
      text = git(repo, ['show', `HEAD:${op}`]);
    } catch {
      continue;
    }
    const children = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('#'));
    orders.push({ folder, children });
  }
  return orders;
}

/** Content markdown per page id, gathered so graph.ts can pull the links. Uses `git grep` WITH file
 *  names to attribute each matching line to its page, then concatenates the lines of each page — far
 *  cheaper than reading every page in full, and enough for link extraction. */
export function readLinkContent(repo: string): Map<string, string> {
  const byPage = new Map<string, string[]>();
  let out = '';
  try {
    out = git(repo, ['grep', '-I', '--no-color', '-e', '](/', 'HEAD', '--', '*.md']);
  } catch {
    return new Map();
  }
  for (const line of out.split('\n')) {
    if (!line) continue;
    // HEAD:<path>:<content>
    const m = /^HEAD:(.*?):(.*)$/.exec(line);
    if (!m) continue;
    const id = m[1]!.replace(/\.md$/i, '');
    (byPage.get(id) ?? byPage.set(id, []).get(id)!).push(m[2]!);
  }
  const content = new Map<string, string>();
  for (const [id, lines] of byPage) content.set(id, lines.join('\n'));
  return content;
}

export interface ReindexResult {
  graph: Graph;
  stats: ReturnType<typeof graphStats>;
  enriched: number;
}

/** Build the graph and the index files, write them under `<repo>/.tonoman/`. Returns the graph and
 *  stats for the log and the report. `enrich` > 0 asks the LLM to summarise that many of the busiest
 *  pages into the index (bounded, because a local model on a small GPU is slow). */
export async function reindex(
  repo: string,
  opts: { enrich?: number; only?: string; provider?: LlmProvider; now?: () => Date } = {},
): Promise<ReindexResult> {
  const now = opts.now ?? (() => new Date());
  const { pages, orderPaths } = readTree(repo);
  const filtered = opts.only ? pages.filter((p) => p.path.startsWith(opts.only!)) : pages;
  const orders = readOrders(repo, orderPaths);
  const content = readLinkContent(repo);
  const graph = buildGraph(filtered, orders, content);
  const stats = graphStats(graph);

  const outDir = path.join(repo, '.tonoman');
  fs.mkdirSync(outDir, { recursive: true });

  // The graph the explorer reads. Kept compact: the explorer computes layout, so no coordinates.
  fs.writeFileSync(path.join(outDir, 'graph.json'), JSON.stringify({ generatedAt: now().toISOString(), stats, ...graph }, null, 0));

  // Karpathy's index.md — content-oriented navigation the LLM (and a person) can read without
  // embeddings: the busiest hubs and the orphans, each linking to its page.
  const byDegree = [...graph.nodes].sort((a, b) => b.degree - a.degree);
  const hubs = byDegree.slice(0, 40);
  const orphans = graph.nodes.filter((n) => n.degree === 0 && !n.stub).slice(0, 40);

  let enriched = 0;
  const summaries = new Map<string, { summary: string; tags: string[] }>();
  if (opts.enrich && opts.provider) {
    // Enrich the busiest pages that actually have content — a stub carries nothing to summarise.
    const targets = byDegree.filter((n) => !n.stub).slice(0, opts.enrich);
    const deps: EnrichDeps = {
      pageText: (id) => {
        try {
          return git(repo, ['show', `HEAD:${id}.md`]);
        } catch {
          return '';
        }
      },
      infer: (system, user) => inferChat(opts.provider!, system, user),
    };
    const results = await enrichPages(
      targets.map((n) => ({ id: n.id, label: n.label })),
      deps,
    );
    for (const r of results) summaries.set(r.id, { summary: r.summary, tags: r.tags });
    enriched = results.length;
  }

  fs.writeFileSync(path.join(outDir, 'index.md'), renderIndex(hubs, orphans, stats, summaries, now()));
  appendLog(outDir, now(), stats, enriched);

  return { graph, stats, enriched };
}

function renderIndex(
  hubs: { id: string; label: string; degree: number }[],
  orphans: { id: string; label: string }[],
  stats: ReturnType<typeof graphStats>,
  summaries: Map<string, { summary: string; tags: string[] }>,
  when: Date,
): string {
  const link = (id: string, label: string) => `[${label}](/${id})`;
  const lines: string[] = [
    '# Second brain — index',
    '',
    `_Generated ${when.toISOString()} · ${stats.nodes} pages, ${stats.links} cross-links, ${stats.hierarchy} hierarchy edges, ${stats.orphans} orphans._`,
    '',
    'This index and the graph beside it are generated from the wiki by the Tonoman reindexer. The',
    'source pages are never rewritten; this is the compounding, cross-referenced view on top of them.',
    '',
    '## Hubs — the most connected pages',
    '',
  ];
  for (const h of hubs) {
    const s = summaries.get(h.id);
    lines.push(`- ${link(h.id, h.label)} — ${h.degree} links${s ? ` · ${s.summary}` : ''}${s?.tags.length ? ` _(${s.tags.join(', ')})_` : ''}`);
  }
  lines.push('', '## Orphans — pages nothing links to', '');
  for (const o of orphans) lines.push(`- ${link(o.id, o.label)}`);
  lines.push('');
  return lines.join('\n');
}

function appendLog(outDir: string, when: Date, stats: ReturnType<typeof graphStats>, enriched: number): void {
  const logPath = path.join(outDir, 'log.md');
  const head = fs.existsSync(logPath) ? '' : '# Reindex log\n\nAppend-only record of each reindex.\n\n';
  const entry = `- ${when.toISOString()} — ${stats.nodes} pages, ${stats.links} links, ${stats.hierarchy} hierarchy, ${stats.orphans} orphans, ${enriched} enriched.\n`;
  fs.appendFileSync(logPath, head + entry);
}

// Runnable directly.
if (process.argv[1] && /reindex\.(ts|mjs|js)$/.test(process.argv[1])) {
  const repo = process.argv[2];
  if (!repo) {
    console.error('usage: reindex <repo-dir> [--commit] [--enrich N] [--only <prefix>]');
    process.exit(2);
  }
  const enrichIdx = process.argv.indexOf('--enrich');
  const onlyIdx = process.argv.indexOf('--only');
  const enrich = enrichIdx >= 0 ? Number(process.argv[enrichIdx + 1]) || 0 : 0;
  const only = onlyIdx >= 0 ? process.argv[onlyIdx + 1] : undefined;
  const provider = enrich > 0 ? ollamaProvider() : undefined;
  reindex(repo, { enrich, only, provider })
    .then((r) => {
      console.log(`reindex: ${JSON.stringify(r.stats)} · enriched ${r.enriched}`);
      if (process.argv.includes('--commit')) {
        try {
          git(repo, ['add', '.tonoman']);
          git(repo, ['commit', '-m', `reindex: ${r.stats.nodes} pages, ${r.stats.links} links, ${r.enriched} enriched`]);
          console.log('reindex: committed .tonoman/');
        } catch (e) {
          console.log(`reindex: nothing to commit or commit failed — ${(e as Error).message.split('\n')[0]}`);
        }
      }
    })
    .catch((e) => {
      console.error(`reindex failed: ${(e as Error).message}`);
      process.exit(1);
    });
}
