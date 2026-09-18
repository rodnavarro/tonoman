// The LLM client for the reindexer — the SAME row shape the voice flow's inference providers use
// (name/url/model/key, an OpenAI-compatible /chat/completions), so "route it through the Tonoman
// inference capability" is a config value, not a second client. For dev it defaults to the local
// ollama serving gemma4 on this GPU; in production the `url` points at the LiteLLM proxy (which
// reaches this box over Tailscale) and the `model` is LiteLLM's friendly name.

export interface LlmProvider {
  name: string;
  /** OpenAI-compatible base, e.g. `http://localhost:11434/v1` (ollama) or the LiteLLM proxy. */
  url: string;
  model: string;
  /** Bearer key when the endpoint needs one (LiteLLM master key); ollama needs none. */
  key?: string;
  /** Context window to ask for. An 8 GB card running a 9.6 GB model offloads to CPU, so a modest
   *  window keeps a call from crawling. */
  numCtx?: number;
  /** Per-call timeout. A local model is slow; better a clean skip than a hung reindex. */
  timeoutMs?: number;
}

/** The dev default: ollama on this machine, gemma4, a window sized for an 8 GB GPU. Overridable by
 *  env so the same code points at LiteLLM without an edit (SECONDBRAIN_LLM_URL / _MODEL / _KEY). */
export function ollamaProvider(env: NodeJS.ProcessEnv = process.env): LlmProvider {
  return {
    name: 'gemma-local',
    url: (env.SECONDBRAIN_LLM_URL ?? 'http://localhost:11434/v1').replace(/\/+$/, ''),
    model: env.SECONDBRAIN_LLM_MODEL ?? 'gemma4:latest',
    key: env.SECONDBRAIN_LLM_KEY,
    numCtx: Number(env.SECONDBRAIN_LLM_CTX ?? '8192') || 8192,
    timeoutMs: Number(env.SECONDBRAIN_LLM_TIMEOUT ?? '120000') || 120000,
  };
}

/** One chat completion. PURE over `fetchImpl`, so the enrichment logic is testable without a model.
 *  Returns the assistant's text, trimmed. Throws on a non-OK response or a timeout — the caller
 *  decides whether one page's failure should skip that page or stop the run. */
export async function inferChat(
  p: LlmProvider,
  system: string,
  user: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), p.timeoutMs ?? 120000);
  try {
    const res = await fetchImpl(`${p.url}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(p.key ? { authorization: `Bearer ${p.key}` } : {}) },
      body: JSON.stringify({
        model: p.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0.2,
        // ollama honours num_ctx via options; LiteLLM ignores an unknown field, so it is harmless there.
        ...(p.numCtx ? { options: { num_ctx: p.numCtx } } : {}),
        stream: false,
      }),
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`${p.name}: HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return (body.choices?.[0]?.message?.content ?? '').trim();
  } finally {
    clearTimeout(timer);
  }
}
