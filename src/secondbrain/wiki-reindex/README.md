# wiki-reindex — the second brain as a knowledge graph

A Karpathy-style **LLM wiki** over the tenant's Azure DevOps wiki (the tenant-wide second brain): the
source pages are never rewritten, and a compounding, cross-referenced view is built on top of them —
a graph, an index, and a graph explorer.

```
graph.ts    PURE: pages + links + .order hierarchy → a {nodes, edges} graph        (unit-tested)
llm.ts      the inference client — the SAME provider row shape as the voice flow    (unit-tested)
enrich.ts   PURE: the Karpathy "ingest" step — LLM summary + tags per hub page       (unit-tested)
reindex.ts  the RUNNER: reads the repo through git, writes .tonoman/, optional commit
explorer.html   an Obsidian-like force-graph view over graph.json
```

## Run it

```bash
# Build the graph + index for a wiki checkout (writes <repo>/.tonoman/):
npx tsx src/secondbrain/wiki-reindex/reindex.ts <repo-dir>

# Enrich the busiest content pages with a local model, and commit the result:
SECONDBRAIN_LLM_MODEL=gemma2:2b npx tsx src/secondbrain/wiki-reindex/reindex.ts <repo-dir> --enrich 20 --commit
```

`.tonoman/graph.json` is what the explorer reads; `index.md` is the human/LLM navigation (hubs +
orphans, with the enriched summaries); `log.md` is the append-only record of each reindex.

## Why git, not the filesystem

An ADO wiki has **case-colliding paths** (`Acme/` and `acme/`) that NTFS folds into one
directory on checkout, so a filesystem walk sees a corrupted tree. Everything reads through
`git ls-tree` / `git grep` against `HEAD`, which is the repo's truth and is what a Linux worker syncs
anyway. Links are ADO Markdown `[text](/Folder/Page)` (absolute, URL-encoded), not `[[wikilinks]]`;
hierarchy comes from `.order` files and the folder/page pairing.

## Inference routing (whisper-shaped)

`llm.ts` uses the same `{name, url, model, key}` provider row the voice flow's transcription/summary
providers use — "route it through the Tonoman inference capability" is a config value, not a second
client. Dev defaults to the local **ollama** on this GPU (`http://localhost:11434/v1`,
`gemma4:latest` when it has the VRAM). Point it at anything OpenAI-compatible with three env vars:

```
SECONDBRAIN_LLM_URL=http://litellm.prod-litellm.svc.cluster.local:4000/v1   # the cluster proxy
SECONDBRAIN_LLM_MODEL=gemma                                                  # a friendly LiteLLM name
SECONDBRAIN_LLM_KEY=<litellm master key>
```

In production the `url` is the LiteLLM proxy, which reaches this GPU box over Tailscale; adding a
`gemma` model to LiteLLM's `values.yaml` is the one prod change that route needs (prepared on an
infra branch, not merged — see the report).

## Notes

- **Opening the explorer:** `explorer.html` fetches `./graph.json` beside it, so it must be *served*
  over http(s) (the ADO wiki's attachment host, a static server, or the Hub) — double-clicking it
  from disk (`file://`) is blocked by the browser and it shows "Could not load graph.json".

- **GPU:** `gemma4:latest` (9.6 GB) does not fit an 8 GB card while the whisper server is resident,
  so the dev enrichment ran on `gemma2:2b`. On a card with headroom (or when whisper is not loaded)
  set `SECONDBRAIN_LLM_MODEL=gemma4:latest`.
- **Bounded enrichment:** a local model is slow, so `--enrich N` covers the busiest *content* pages
  (stubs are skipped). A full-corpus pass belongs in a background job.
- **Known limits:** a link whose path contains a literal `)` is truncated by the Markdown-link regex
  (harmless in practice — ADO percent-encodes parens in paths); `SECONDBRAIN_LLM_CTX` is best-effort
  (ollama's `/v1` ignores it — set the context in a Modelfile).
- The graph is deterministic and fast (~13 s for 4,400 pages); the LLM only writes the index prose.
