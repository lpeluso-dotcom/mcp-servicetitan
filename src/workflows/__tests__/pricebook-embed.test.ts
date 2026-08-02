import { describe, it, expect, vi, afterEach } from 'vitest';
import { drainOnce, EMBED_BATCH, RUN_CEILING } from '../pricebook-embed';

afterEach(() => vi.unstubAllGlobals());

function env(aiRun: any) {
  return { SUPABASE_URL: 'https://p.supabase.co', SUPABASE_PB_KEY: 'k', AI: { run: aiRun } } as any;
}

describe('PricebookEmbedWorkflow drainOnce', () => {
  it('embeds NULL rows with the locked model + app projection, writes by (code,item_type)', async () => {
    const aiRun = vi.fn(async () => ({ data: [[0.1, 0.2]] }));
    let served = false;
    const patched: any[] = [];
    const fetchMock = vi.fn(async (u: string, init: any) => {
      const url = String(u);
      if (url.includes('select=code') && !served) {
        served = true;
        return new Response(JSON.stringify([
          { code: 'CAP-240', item_type: 'material', name: 'Capacitor', description: 'Dual run', category_name: 'HVAC' },
        ]), { status: 200 });
      }
      if (url.includes('select=code')) return new Response(JSON.stringify([]), { status: 200 }); // backlog drained
      patched.push({ url, body: init?.body }); // PATCH write
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const out = await drainOnce(env(aiRun), { batch: 100, ceiling: 5000 });

    expect(aiRun).toHaveBeenCalledWith('@cf/baai/bge-base-en-v1.5', { text: ['Capacitor — Dual run — HVAC'] });
    expect(out.embedded).toBe(1);
    expect(patched[0].url).toContain('code=eq.CAP-240&item_type=eq.material');
    expect(JSON.parse(patched[0].body)).toEqual({ embedding: '[0.1,0.2]' });
  });

  it('is a no-op when the backlog is empty', async () => {
    const aiRun = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([]), { status: 200 })));
    const out = await drainOnce(env(aiRun), { batch: 100, ceiling: 5000 });
    expect(out.embedded).toBe(0);
    expect(aiRun).not.toHaveBeenCalled();
  });

  it('honors the per-run ceiling', async () => {
    const aiRun = vi.fn(async () => ({ data: [[0.1]] }));
    // Always returns one full batch → would loop forever without the ceiling.
    const fetchMock = vi.fn(async (u: string) => {
      if (String(u).includes('select=code')) {
        return new Response(JSON.stringify(
          Array.from({ length: 2 }, (_, i) => ({ code: `C${i}`, item_type: 'material', name: `n${i}` })),
        ), { status: 200 });
      }
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const out = await drainOnce(env(aiRun), { batch: 2, ceiling: 4 });
    expect(out.embedded).toBe(4); // 2 batches of 2, then stop at ceiling
    expect(EMBED_BATCH).toBe(100);
    expect(RUN_CEILING).toBe(5000);
  });

  it('breaks out on a stuck full batch that makes zero forward progress (no-progress guard)', async () => {
    const aiRun = vi.fn(async () => ({ data: [] })); // malformed/empty response — no row gets a vector
    const selectMock = vi.fn(async () => {
      // Always a full batch, never empty — without the guard this recurs forever.
      return new Response(JSON.stringify(
        Array.from({ length: 2 }, (_, i) => ({ code: `S${i}`, item_type: 'material', name: `n${i}` })),
      ), { status: 200 });
    });
    const fetchMock = vi.fn(async (u: string) => {
      if (String(u).includes('select=code')) return selectMock();
      return new Response(null, { status: 204 }); // PATCH write path (should never be reached)
    });
    vi.stubGlobal('fetch', fetchMock);

    const out = await drainOnce(env(aiRun), { batch: 2, ceiling: 4 });

    expect(out.embedded).toBe(0);
    expect(selectMock).toHaveBeenCalledTimes(1);
  });
});
