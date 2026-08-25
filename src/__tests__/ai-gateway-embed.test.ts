// ============================================================
// ai-gateway-embed.test.ts — Wave 2, workstream E item 5.
//
// HONEST SCOPE, STATED UP FRONT. AI Gateway does NOTHING for this worker's
// role as an MCP *provider*. It fronts OUTBOUND model calls only. This worker
// makes exactly one class of outbound model call worth fronting — the
// per-search query embedding in embedQuery() — and the win there is a cache
// hit on repeated query text plus token/latency/error analytics on the AI
// binding. That is a small, narrow win, not a headline.
//
// AND IT MUST NOT SPREAD. PricebookEmbedWorkflow embeds only rows where
// `embedding IS NULL`, so every input it sees is unique BY CONSTRUCTION. A
// cache there is pure overhead — Cloudflare's own docs warn against caching
// embedding requests for indexing workloads. The second describe() block below
// pins that boundary so a future "let's be consistent" edit cannot erase it.
//
// This test lives in __tests__/ rather than in src/supabase.test.ts to keep
// the diff off a file another workstream is editing.
// ============================================================
import { describe, it, expect, vi } from 'vitest';
import { embedQuery, EMBED_MODEL_ID } from '../supabase';

function envWithAi() {
  const run = vi.fn(async () => ({ data: [[0.1, 0.2, 0.3]] }));
  return { env: { AI: { run } } as any, run };
}

describe('embedQuery routes through AI Gateway', () => {
  it('passes a gateway option as the third argument to AI.run', async () => {
    const { env, run } = envWithAi();
    await embedQuery(env, 'shower caulk');
    expect(run).toHaveBeenCalledTimes(1);
    const [model, input, options] = run.mock.calls[0] as unknown as [string, unknown, any];
    expect(model).toBe(EMBED_MODEL_ID);
    expect(input).toEqual({ text: ['shower caulk'] });
    expect(options?.gateway?.id).toBeTruthy();
  });

  it('sets a 24h cacheTtl so a repeated query embedding is served from cache', async () => {
    const { env, run } = envWithAi();
    await embedQuery(env, 'shower caulk');
    const options = (run.mock.calls[0] as unknown as [string, unknown, any])[2];
    expect(options.gateway.cacheTtl).toBe(86400);
  });

  it('still returns the vector unchanged', async () => {
    const { env } = envWithAi();
    await expect(embedQuery(env, 'x')).resolves.toEqual([0.1, 0.2, 0.3]);
  });

  it('still falls back to null (→ lexical search) when the gateway path throws', async () => {
    const env = {
      AI: {
        run: vi.fn(async () => {
          throw new Error('gateway unavailable');
        }),
      },
    } as any;
    await expect(embedQuery(env, 'x')).resolves.toBeNull();
  });
});

describe('the indexing Workflow is deliberately NOT gatewayed', () => {
  it('pricebook-embed.ts passes no gateway option to AI.run', async () => {
    const src = (await import('../workflows/pricebook-embed.ts?raw')).default;
    // It embeds only rows WHERE embedding IS NULL — every input is unique by
    // construction, so a cache is pure overhead and pollutes the cache-hit
    // metrics that make the embedQuery gateway worth reading at all.
    expect(src).not.toMatch(/gateway/);
  });
});
