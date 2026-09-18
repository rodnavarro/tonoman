import { describe, it, expect } from 'vitest';
import { pageExcerpt, parseEnrichment, enrichPages, type EnrichDeps } from './enrich';
import { inferChat, ollamaProvider } from './llm';

describe('pageExcerpt', () => {
  it('titles from the leaf and caps the body', () => {
    const out = pageExcerpt('Folder/Meeting-Recap', 'x'.repeat(3000), 100);
    expect(out.startsWith('# Meeting Recap')).toBe(true);
    expect(out.length).toBeLessThan(160);
  });
});

describe('parseEnrichment — defensive against how models actually reply', () => {
  it('reads strict JSON', () => {
    expect(parseEnrichment('{"summary":"A page about X.","tags":["x","y"]}')).toEqual({ summary: 'A page about X.', tags: ['x', 'y'] });
  });
  it('digs JSON out of a code fence or prose', () => {
    expect(parseEnrichment('Sure!\n```json\n{"summary":"Y","tags":["a"]}\n```')).toEqual({ summary: 'Y', tags: ['a'] });
  });
  it('caps tags at five and lowercases them', () => {
    expect(parseEnrichment('{"summary":"Z","tags":["A","B","C","D","E","F"]}').tags).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
  it('falls back to the first line as the summary when there is no JSON', () => {
    expect(parseEnrichment('This page covers onboarding.\nmore')).toEqual({ summary: 'This page covers onboarding.', tags: [] });
  });
  it('drops surrounding quotes on a plain answer', () => {
    expect(parseEnrichment('"Just a quote."').summary).toBe('Just a quote.');
  });
});

describe('enrichPages', () => {
  const deps = (fail = new Set<string>()): EnrichDeps => ({
    pageText: (id) => (id === 'Empty' ? '' : `body of ${id}`),
    infer: async (_s, user) => {
      const id = user.split('\n')[0].replace('# ', '');
      if (fail.has(id)) throw new Error('model timed out');
      return `{"summary":"about ${id}","tags":["t"]}`;
    },
  });

  it('summarises each readable page, skipping empty ones', async () => {
    const out = await enrichPages([{ id: 'A', label: 'A' }, { id: 'Empty', label: 'Empty' }], deps());
    expect(out).toEqual([{ id: 'A', summary: 'about A', tags: ['t'] }]);
  });

  it('a single page failing does not sink the batch', async () => {
    const out = await enrichPages([{ id: 'A', label: 'A' }, { id: 'B', label: 'B' }], deps(new Set(['B'])));
    expect(out.map((r) => r.id)).toEqual(['A']);
  });
});

describe('inferChat — the OpenAI-compatible client', () => {
  it('posts the model, messages and num_ctx, returns the assistant text', async () => {
    let seen: any;
    const fakeFetch = (async (_url: string, init: { body: string }) => {
      seen = JSON.parse(init.body);
      return { ok: true, json: async () => ({ choices: [{ message: { content: '  hi  ' } }] }) } as Response;
    }) as unknown as typeof fetch;
    const p = ollamaProvider({ SECONDBRAIN_LLM_MODEL: 'gemma4:latest', SECONDBRAIN_LLM_CTX: '4096' } as NodeJS.ProcessEnv);
    const text = await inferChat(p, 'sys', 'usr', fakeFetch);
    expect(text).toBe('hi');
    expect(seen.model).toBe('gemma4:latest');
    expect(seen.options.num_ctx).toBe(4096);
    expect(seen.messages[0]).toEqual({ role: 'system', content: 'sys' });
  });

  it('throws on a non-OK response', async () => {
    const fakeFetch = (async () => ({ ok: false, status: 500, text: async () => 'boom' }) as Response) as unknown as typeof fetch;
    await expect(inferChat(ollamaProvider(), 's', 'u', fakeFetch)).rejects.toThrow(/500/);
  });

  it('defaults to local ollama and carries a key only when set', async () => {
    let hadAuth = false;
    const fakeFetch = (async (_u: string, init: { headers: Record<string, string> }) => {
      hadAuth = 'authorization' in init.headers;
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'x' } }] }) } as Response;
    }) as unknown as typeof fetch;
    await inferChat(ollamaProvider({} as NodeJS.ProcessEnv), 's', 'u', fakeFetch);
    expect(hadAuth).toBe(false);
    await inferChat(ollamaProvider({ SECONDBRAIN_LLM_KEY: 'k' } as NodeJS.ProcessEnv), 's', 'u', fakeFetch);
    expect(hadAuth).toBe(true);
  });
});
