// PURE: turning an Azure DevOps wiki (the tenant-wide second brain) into a knowledge graph — nodes
// for pages, edges for hierarchy and for content cross-references. No IO here: the runner reads the
// repo through git and hands this the paths and contents, so every rule below is unit-testable
// without a checkout.
//
// AN ADO WIKI, NOT AN OBSIDIAN VAULT. Two consequences drive the parsing:
//   - Links are Markdown `[text](/Folder/Page)` with ABSOLUTE, URL-ENCODED repo paths (`%3A` for a
//     colon), NOT `[[wikilinks]]`. Most links point at `/.attachments/…` (images) or external URLs;
//     only the internal page links are graph edges.
//   - Hierarchy is explicit: a folder `X/` pairs with a sibling page `X.md`, and each folder holds a
//     `.order` file naming its children in order. That hierarchy is most of the graph — content
//     cross-links are comparatively sparse — so both edge kinds are kept and the explorer toggles them.

export interface GraphNode {
  /** The page's repo path without `.md`, URL-encoded exactly as the repo stores it — the stable id
   *  that links resolve against. */
  id: string;
  /** Human-readable: decoded, leaf only, dashes as spaces. */
  label: string;
  /** The parent folder id (''.for a top-level page), for colouring/grouping. */
  folder: string;
  /** A 0-byte page — an ADO wiki folder-stub that exists only to parent its children. Kept as a
   *  node so the tree is whole, but marked so the explorer can dim it. */
  stub: boolean;
  /** Content links out + in + hierarchy, filled by buildGraph. */
  degree: number;
}

export interface GraphEdge {
  source: string;
  target: string;
  kind: 'hierarchy' | 'link' | 'related';
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** The repo path of a page, minus its `.md`. `Folder/Page.md` -> `Folder/Page`. */
export function pageId(repoPath: string): string {
  return repoPath.replace(/\.md$/i, '');
}

/** The parent folder of an id, or '' for a top-level page. */
export function parentOf(id: string): string {
  const i = id.lastIndexOf('/');
  return i < 0 ? '' : id.slice(0, i);
}

/** A page's display label: the leaf, percent-decoded, ADO's dashes back to spaces. */
export function decodeLabel(id: string): string {
  const leaf = id.slice(id.lastIndexOf('/') + 1);
  let s = leaf;
  try {
    s = decodeURIComponent(leaf);
  } catch {
    /* a stray % that is not an escape — show it raw rather than throw */
  }
  return s.replace(/-/g, ' ').trim() || leaf;
}

/** Is this href an INTERNAL wiki page link (an edge), as opposed to an image, an attachment or an
 *  external URL? Internal links are absolute repo paths beginning with `/` and not under
 *  `/.attachments/`. */
export function isContentLink(href: string): boolean {
  const h = href.trim();
  if (!h.startsWith('/')) return false; // external (http…), anchors (#…), relative — not a page edge
  if (/^\/\.attachments\//i.test(h)) return false; // an embedded image or file, not a page
  return true;
}

/** The page id an internal href points at, if it names a page this wiki has. ADO writes the path
 *  without `.md`; a trailing slash, an anchor and a query are dropped. Matched against known ids
 *  both as-written and percent-decoded, since a link may encode a colon the path stores raw or the
 *  other way round. Returns undefined for a link to a page that does not exist (a dangling link). */
export function resolveLink(href: string, knownIds: Set<string>): string | undefined {
  let h = href.trim().split('#')[0]!.split('?')[0]!;
  if (h.length > 1) h = h.replace(/\/+$/, ''); // trailing slash, but keep a lone '/'
  const cand = h.replace(/^\//, '').replace(/\.md$/i, '');
  if (knownIds.has(cand)) return cand;
  // Percent-escapes may differ in HEX CASE (`%3a` vs `%3A`) between a link and the stored path;
  // normalise both to uppercase hex before comparing.
  const up = upHex(cand);
  if (up !== cand && knownIds.has(up)) return up;
  // Try the other encoding: links and stored paths do not always agree on what is escaped. Decode
  // once, and re-encode a decoded candidate — but DECODE FIRST so an already-escaped path is not
  // double-encoded.
  let dec = cand;
  try {
    dec = decodeURIComponent(cand);
  } catch {
    /* a stray % that is not an escape — leave as-is */
  }
  if (dec !== cand && knownIds.has(dec)) return dec;
  if (dec !== cand && knownIds.has(upHex(dec))) return upHex(dec);
  const enc = dec.split('/').map((seg) => encodeURIComponent(seg)).join('/');
  if (enc !== cand && knownIds.has(enc)) return enc;
  return undefined;
}

/** Uppercase the hex of every %XX escape, so `%3a` and `%3A` compare equal. */
function upHex(s: string): string {
  return s.replace(/%[0-9a-fA-F]{2}/g, (m) => m.toUpperCase());
}

/** Every Markdown link target in a page. `[text](href)` — the href only, image links included (they
 *  are filtered by `isContentLink`, not here). Reference-style and bare autolinks are rare in an ADO
 *  export and skipped. */
export function extractLinks(md: string): string[] {
  const out: string[] = [];
  // [text](href) — href is up to the first whitespace or ')'; ADO does not use link titles.
  const re = /\[[^\]]*\]\(([^)\s]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md))) out.push(m[1]!);
  return out;
}

/** The child names a `.order` file lists (one per line, blank lines ignored). These are page/folder
 *  names relative to the folder the `.order` sits in, encoded the same way the repo stores them. */
export function orderChildren(orderText: string): string[] {
  return orderText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
}

/** Build the graph. Inputs are already read from git by the runner:
 *   - `pages`: every `<path>.md` in the repo, with its byte size (0 = stub).
 *   - `orders`: each `.order` file's folder id and the child names it lists.
 *   - `contentOf`: a page id -> its Markdown (only pages worth reading; a missing entry = not read,
 *     so no content edges from it, which is fine for a stub).
 *
 *  Hierarchy edges come from `.order` (parent -> child) and from the folder/page pairing; content
 *  edges from resolvable internal links. Every edge is deduped and both endpoints must be real
 *  nodes, so a link to a deleted page adds nothing. */
export function buildGraph(
  pages: { path: string; size: number }[],
  orders: { folder: string; children: string[] }[],
  contentOf: Map<string, string>,
): Graph {
  const nodes = new Map<string, GraphNode>();
  for (const p of pages) {
    const id = pageId(p.path);
    if (!nodes.has(id)) {
      nodes.set(id, { id, label: decodeLabel(id), folder: parentOf(id), stub: p.size === 0, degree: 0 });
    }
  }
  const ids = new Set(nodes.keys());
  const edgeKey = new Set<string>();
  const edges: GraphEdge[] = [];
  const addEdge = (source: string, target: string, kind: GraphEdge['kind']) => {
    if (source === target || !nodes.has(source) || !nodes.has(target)) return;
    const k = `${source}\u0000${target}\u0000${kind}`;
    if (edgeKey.has(k)) return;
    edgeKey.add(k);
    edges.push({ source, target, kind });
    nodes.get(source)!.degree++;
    nodes.get(target)!.degree++;
  };

  // Hierarchy from .order: the folder's own page (folder id) parents each child it lists. A child is
  // named relative to the folder, so its id is `<folder>/<child>` (top-level when the folder is '').
  for (const o of orders) {
    for (const child of o.children) {
      const childId = o.folder ? `${o.folder}/${child}` : child;
      const parentId = o.folder; // '' for the repo root: its children are top-level pages, no parent node
      if (parentId) addEdge(parentId, childId, 'hierarchy');
    }
  }
  // Hierarchy from the tree itself, as a backstop where a .order is missing: a page's parent folder,
  // if that folder is itself a page, parents it.
  for (const id of ids) {
    const parent = parentOf(id);
    if (parent && nodes.has(parent)) addEdge(parent, id, 'hierarchy');
  }
  // Content edges from internal links.
  for (const [id, md] of contentOf) {
    if (!nodes.has(id)) continue;
    for (const href of extractLinks(md)) {
      if (!isContentLink(href)) continue;
      const target = resolveLink(href, ids);
      if (target) addEdge(id, target, 'link');
    }
  }

  return { nodes: [...nodes.values()], edges };
}

/** A compact stat line for the log and the report. */
export function graphStats(g: Graph): { nodes: number; stubs: number; hierarchy: number; links: number; orphans: number } {
  const hierarchy = g.edges.filter((e) => e.kind === 'hierarchy').length;
  const links = g.edges.filter((e) => e.kind === 'link').length;
  return {
    nodes: g.nodes.length,
    stubs: g.nodes.filter((n) => n.stub).length,
    hierarchy,
    links,
    // Degree-0 pages that are NOT folder stubs — the same set the index lists, so the explorer's
    // "orphans" stat and the index's orphan list agree (a stub with no children is not an orphan a
    // person would go fix).
    orphans: g.nodes.filter((n) => n.degree === 0 && !n.stub).length,
  };
}
