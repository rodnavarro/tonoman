// The Karpathy "ingest" step, bounded: for a handful of the busiest pages, ask the local model for a
// one-line summary and a few tags, to file into the index. PURE over its deps (page text + infer),
// so the parsing and the bounding are tested without a model or a repo.
//
// It never rewrites a source page — the wiki's pages are the immutable material; this is the
// compounding index on top. And it is deliberately small: a 9.6 GB model on an 8 GB card is slow, so
// enrichment covers the hubs a reader reaches first, not all 4000 pages.

export interface EnrichDeps {
  /** The full markdown of a page id, or '' if it cannot be read. */
  pageText(id: string): string;
  /** One chat completion: (system, user) -> text. */
  infer(system: string, user: string): Promise<string>;
}

export interface Enriched {
  id: string;
  summary: string;
  tags: string[];
}

const SYSTEM =
  'You summarise a wiki page for an index. Reply with STRICT JSON only: ' +
  '{"summary": "<one sentence, <=160 chars, plain>", "tags": ["<=5 short lowercase tags"]}. ' +
  'No markdown, no code fence, no extra text.';

/** Trim a page to what fits a small context window: the title, then the first ~1500 characters of
 *  prose. Enough for a one-line summary; cheap for the model. */
export function pageExcerpt(id: string, md: string, limit = 1500): string {
  const label = id.slice(id.lastIndexOf('/') + 1).replace(/-/g, ' ');
  const body = md.replace(/\r/g, '').trim();
  return `# ${label}\n\n${body.slice(0, limit)}`;
}

/** Parse the model's reply into a summary + tags, defensively: models wrap JSON in prose or a code
 *  fence, or answer in plain text. A first-object extraction handles the common cases; a plain-text
 *  answer becomes the summary with no tags rather than an error. */
export function parseEnrichment(raw: string): { summary: string; tags: string[] } {
  const text = raw.trim();
  const jsonStart = text.indexOf('{');
  const jsonEnd = text.lastIndexOf('}');
  if (jsonStart >= 0 && jsonEnd > jsonStart) {
    try {
      const o = JSON.parse(text.slice(jsonStart, jsonEnd + 1)) as { summary?: unknown; tags?: unknown };
      const summary = typeof o.summary === 'string' ? o.summary.trim().slice(0, 200) : '';
      const tags = Array.isArray(o.tags)
        ? o.tags.filter((t): t is string => typeof t === 'string').map((t) => t.trim().toLowerCase()).filter(Boolean).slice(0, 5)
        : [];
      if (summary) return { summary, tags };
    } catch {
      /* fall through to plain text */
    }
  }
  // Plain-text fallback: first non-empty line, no tags.
  const line = text.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  return { summary: line.replace(/^["']|["']$/g, '').slice(0, 200), tags: [] };
}

/** Enrich a bounded list of pages, one model call each, in sequence (a small GPU serves one request
 *  at a time anyway). A page whose call fails is skipped, not fatal — the index is better with the
 *  ones that worked than empty because one timed out. */
export async function enrichPages(pages: { id: string; label: string }[], deps: EnrichDeps): Promise<Enriched[]> {
  const out: Enriched[] = [];
  for (const p of pages) {
    const md = deps.pageText(p.id);
    if (!md.trim()) continue;
    try {
      const reply = await deps.infer(SYSTEM, pageExcerpt(p.id, md));
      const { summary, tags } = parseEnrichment(reply);
      if (summary) out.push({ id: p.id, summary, tags });
    } catch {
      // one page's model failure must not sink the batch
    }
  }
  return out;
}
