// ============================================================
// supabase-resilience.test.ts — the two things every sb* helper owed and had
// neither: a retry on a transient failure, and a bound on how much of a
// failure body reaches the caller.
//
// WHY (audit, verified at 2ff9d39): all four helpers were single-shot bare
// `fetch` with no retry, and every error path interpolated the FULL
// `res.text()`. A Cloudflare 522 in front of Supabase returns an HTML error
// page — tens of KB — which landed whole in `error_log` and in the MCP
// response body. The retry mirrors `src/d1-proxy.ts` (3 attempts, 50/200ms)
// rather than inventing a second idiom.
// ============================================================
import { describe, it, expect, vi, afterEach } from 'vitest';
import { sbCount, sbRpc, sbSelect, sbWriteEmbedding } from './supabase';

const env = { SUPABASE_URL: 'https://p.supabase.co', SUPABASE_PB_KEY: 'k' } as any;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Fails `failures` times with `status`, then serves `ok`. */
function flaky(failures: number, status: number, ok: () => Response) {
  let n = 0;
  return vi.fn(async () => (n++ < failures ? new Response('transient', { status }) : ok()));
}

const jsonOk = () => new Response('[{"code":"CAP-240"}]', { status: 200 });

describe('sb* retry on transient failures (mirrors d1-proxy)', () => {
  it('sbRpc retries a 429 and returns the eventual success', async () => {
    const f = flaky(1, 429, jsonOk);
    vi.stubGlobal('fetch', f as any);
    await expect(sbRpc(env, 'search_pricebook_hybrid', {})).resolves.toEqual([{ code: 'CAP-240' }]);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('sbRpc retries a 503 and returns the eventual success', async () => {
    const f = flaky(2, 503, jsonOk);
    vi.stubGlobal('fetch', f as any);
    await expect(sbRpc(env, 'fn', {})).resolves.toEqual([{ code: 'CAP-240' }]);
    expect(f).toHaveBeenCalledTimes(3);
  });

  it('sbRpc gives up after 3 attempts and throws the last status', async () => {
    const f = vi.fn(async () => new Response('still down', { status: 500 }));
    vi.stubGlobal('fetch', f as any);
    await expect(sbRpc(env, 'fn', {})).rejects.toThrow(/supabase rpc fn failed 500/);
    expect(f).toHaveBeenCalledTimes(3);
  });

  it('sbRpc does NOT retry a terminal 4xx — a 404 will not get better', async () => {
    const f = vi.fn(async () => new Response('PGRST202', { status: 404 }));
    vi.stubGlobal('fetch', f as any);
    await expect(sbRpc(env, 'match_entities', {})).rejects.toThrow(/failed 404/);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('sbSelect retries a 502', async () => {
    const f = flaky(1, 502, () => new Response('[{"st_id":1}]', { status: 200 }));
    vi.stubGlobal('fetch', f as any);
    await expect(sbSelect(env, 'pricebook_items?st_id=eq.1')).resolves.toEqual([{ st_id: 1 }]);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('sbSelect does NOT retry a 401', async () => {
    const f = vi.fn(async () => new Response('bad key', { status: 401 }));
    vi.stubGlobal('fetch', f as any);
    await expect(sbSelect(env, 'pricebook_items')).rejects.toThrow(/failed 401/);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('sbCount retries a 408 and reads the count off the eventual success', async () => {
    const f = flaky(1, 408, () =>
      new Response('[]', { status: 206, headers: { 'content-range': '0-0/349036' } }));
    vi.stubGlobal('fetch', f as any);
    await expect(sbCount(env, 'entity_chunks?select=chunk_id', 'vec')).resolves.toBe(349036);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('sbCount gives up after 3 attempts', async () => {
    const f = vi.fn(async () => new Response('nope', { status: 500 }));
    vi.stubGlobal('fetch', f as any);
    await expect(sbCount(env, 'entity_chunks?select=chunk_id', 'vec')).rejects.toThrow(/supabase count/);
    expect(f).toHaveBeenCalledTimes(3);
  });

  it('a network-level throw is transient and retried', async () => {
    let n = 0;
    const f = vi.fn(async () => {
      if (n++ === 0) throw new TypeError('network error');
      return jsonOk();
    });
    vi.stubGlobal('fetch', f as any);
    await expect(sbRpc(env, 'fn', {})).resolves.toEqual([{ code: 'CAP-240' }]);
    expect(f).toHaveBeenCalledTimes(2);
  });

  // The abort budget is 25s, sized against the authenticator role's 30s
  // statement_timeout. Retrying a hit on THAT budget would mean 3 x 25s = 75s
  // of wall clock for a query that is simply too slow — and it would come back
  // with the identical timeout, because the cause is the statement, not the
  // wire. So a timeout is terminal even though it arrives as a thrown error.
  it('a timeout is NOT retried — the same slow query would just time out again, 25s later', async () => {
    const f = vi.fn(async () => {
      const e = new Error('The operation was aborted due to timeout');
      e.name = 'TimeoutError';
      throw e;
    });
    vi.stubGlobal('fetch', f as any);
    await expect(sbRpc(env, 'fn', {})).rejects.toThrow(/timeout/i);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('an AbortError is likewise terminal', async () => {
    const f = vi.fn(async () => {
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    });
    vi.stubGlobal('fetch', f as any);
    await expect(sbSelect(env, 'pricebook_items')).rejects.toThrow(/aborted/);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('an exhausted network failure surfaces the underlying message, not a bare status', async () => {
    const f = vi.fn(async () => { throw new TypeError('connection reset'); });
    vi.stubGlobal('fetch', f as any);
    await expect(sbRpc(env, 'fn', {})).rejects.toThrow(/connection reset/);
    expect(f).toHaveBeenCalledTimes(3);
  });

  // sbWriteEmbedding is the ONE write in this module. It is retried DELIBERATELY:
  // PATCH ?code=eq.X&item_type=eq.Y {embedding: <fixed vector>} is a full-value
  // assignment on a keyed filter, so applying it twice leaves exactly the state
  // applying it once leaves. The failure it protects against is precisely the
  // ambiguous one — a request that reached Postgres but whose response was lost —
  // and re-writing the identical vector is a no-op. (An INSERT or an increment
  // would NOT qualify; there is neither here.)
  it('sbWriteEmbedding retries a transient 500 — the PATCH is a full-value assignment, so it is idempotent', async () => {
    const f = flaky(1, 500, () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', f as any);
    await expect(sbWriteEmbedding(env, 'CAP-240', 'material', [0.5])).resolves.toBeUndefined();
    expect(f).toHaveBeenCalledTimes(2);
    // Both attempts must carry the SAME body — a retry that re-derived the
    // vector would not be the idempotent write this is claimed to be.
    const bodies = (f.mock.calls as any[]).map((c) => c[1].body);
    expect(bodies[0]).toBe(bodies[1]);
  });

  it('sbWriteEmbedding does NOT retry a 409 conflict', async () => {
    const f = vi.fn(async () => new Response('conflict', { status: 409 }));
    vi.stubGlobal('fetch', f as any);
    await expect(sbWriteEmbedding(env, 'X', 'material', [0.1])).rejects.toThrow(/failed 409/);
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe('error bodies are truncated before they reach an exception message', () => {
  // A Cloudflare 522 interstitial in front of Supabase is a full HTML page.
  const HUGE = '<!DOCTYPE html>' + 'x'.repeat(40_000);

  it('sbRpc truncates a 40 KB body to 600 chars', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(HUGE, { status: 400 })) as any);
    const err = await sbRpc(env, 'fn', {}).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    // The whole message stays small: 600 body chars plus a short prefix/suffix.
    expect((err as Error).message.length).toBeLessThan(800);
    expect((err as Error).message).toContain('<!DOCTYPE html>');
    expect((err as Error).message).not.toContain(HUGE);
  });

  it('sbSelect truncates a 40 KB body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(HUGE, { status: 400 })) as any);
    const err = await sbSelect(env, 'pricebook_items').catch((e: Error) => e);
    expect((err as Error).message.length).toBeLessThan(800);
  });

  it('sbCount truncates a 40 KB body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(HUGE, { status: 400 })) as any);
    const err = await sbCount(env, 'entity_chunks?select=chunk_id', 'vec').catch((e: Error) => e);
    expect((err as Error).message.length).toBeLessThan(800);
  });

  it('sbWriteEmbedding truncates a 40 KB body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(HUGE, { status: 400 })) as any);
    const err = await sbWriteEmbedding(env, 'C', 'material', [0.1]).catch((e: Error) => e);
    expect((err as Error).message.length).toBeLessThan(800);
  });

  it('says the body was truncated, so nobody hunts for the missing tail', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(HUGE, { status: 400 })) as any);
    const err = await sbRpc(env, 'fn', {}).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/truncated/i);
  });

  it('a SHORT body is passed through verbatim, with no truncation marker', async () => {
    const short = '{"code":"PGRST202","message":"Could not find the function"}';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(short, { status: 404 })) as any);
    const err = await sbRpc(env, 'fn', {}).catch((e: Error) => e);
    expect((err as Error).message).toContain(short);
    expect((err as Error).message).not.toMatch(/truncated/i);
  });
});
