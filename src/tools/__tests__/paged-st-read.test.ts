// ============================================================
// paged-st-read.test.ts — v1.4 shared pagination helper.
// Strategy: mock ST_PROXY service binding + ST_RATE_LIMITER DO,
// drive pagedStRead through every loop/exit/retry path.
// All fixtures are synthetic — no real customer or BU data.
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { pagedStRead } from '../../paged-st-read';

const HEADERS = { 'X-Sync-Key': 'test', 'X-Correlation-Id': 'corr', 'X-Actor': 'vitest' };
const ENDPOINT = '/jpm/v2/tenant/0/jobs';

function makeEnv(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>): any {
  return {
    ST_PROXY: { fetch: vi.fn(fetchImpl) },
    ST_RATE_LIMITER: {
      idFromName: vi.fn().mockReturnValue('do-id'),
      get: vi.fn().mockReturnValue({
        fetch: vi.fn().mockImplementation(
          async () => new Response(JSON.stringify({ allowed: true }), { status: 200 })
        ),
      }),
    },
  };
}

function pageOk(items: unknown[], hasMore: boolean): Response {
  return new Response(JSON.stringify({ data: items, hasMore }), { status: 200 });
}

describe('pagedStRead', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('returns first page when hasMore=false', async () => {
    const env = makeEnv(async () => pageOk([{ id: 1 }, { id: 2 }], false));
    const out = await pagedStRead(env, HEADERS, ENDPOINT, { businessUnitIds: '1' });
    expect(out.items).toHaveLength(2);
    expect(out.pageCount).toBe(1);
    expect(out.truncated).toBe(false);
    expect(out.warnings).toEqual([]);
    expect(out.partialFailures).toEqual([]);
    expect(env.ST_PROXY.fetch).toHaveBeenCalledTimes(1);
  });

  it('loops while hasMore=true and concatenates items', async () => {
    let p = 0;
    const env = makeEnv(async () => {
      p++;
      if (p === 1) return pageOk([{ id: 1 }, { id: 2 }], true);
      if (p === 2) return pageOk([{ id: 3 }, { id: 4 }], true);
      return pageOk([{ id: 5 }], false);
    });
    const out = await pagedStRead(env, HEADERS, ENDPOINT, {}, { pageSize: 2 });
    expect(out.items.map((i: any) => i.id)).toEqual([1, 2, 3, 4, 5]);
    expect(out.pageCount).toBe(3);
    expect(out.truncated).toBe(false);
  });

  it('stops when data.length < pageSize even if hasMore is missing', async () => {
    let p = 0;
    const env = makeEnv(async () => {
      p++;
      if (p === 1) return new Response(JSON.stringify({ data: [{ id: 1 }, { id: 2 }] }), { status: 200 });
      return new Response(JSON.stringify({ data: [{ id: 3 }] }), { status: 200 });
    });
    const out = await pagedStRead(env, HEADERS, ENDPOINT, {}, { pageSize: 2 });
    expect(out.items).toHaveLength(3);
    expect(out.pageCount).toBe(2);
    expect(out.truncated).toBe(false);
  });

  it('returns empty result when first page has no data', async () => {
    const env = makeEnv(async () => pageOk([], false));
    const out = await pagedStRead(env, HEADERS, ENDPOINT, {});
    expect(out.items).toEqual([]);
    expect(out.pageCount).toBe(1);
    expect(out.truncated).toBe(false);
  });

  it('caps at maxPages and surfaces truncated_at_max_pages warning', async () => {
    const env = makeEnv(async () => pageOk([{ id: 1 }, { id: 2 }], true));
    const out = await pagedStRead(env, HEADERS, ENDPOINT, {}, { pageSize: 2, maxPages: 3 });
    expect(out.pageCount).toBe(3);
    expect(out.truncated).toBe(true);
    expect(out.warnings).toContain('truncated_at_max_pages');
    expect(env.ST_PROXY.fetch).toHaveBeenCalledTimes(3);
  });

  it('retries on 429 with Retry-After and succeeds', async () => {
    let attempt = 0;
    const env = makeEnv(async () => {
      attempt++;
      if (attempt === 1) {
        return new Response('rate limited', { status: 429, headers: { 'Retry-After': '0' } });
      }
      return pageOk([{ id: 1 }], false);
    });
    const out = await pagedStRead(env, HEADERS, ENDPOINT, {}, { retries: 3 });
    expect(out.items).toHaveLength(1);
    expect(out.pageCount).toBe(1);
    expect(env.ST_PROXY.fetch).toHaveBeenCalledTimes(2);
    expect(env.ST_RATE_LIMITER.get).toHaveBeenCalled();
  });

  it('retries on 503 with backoff and succeeds', async () => {
    let attempt = 0;
    const env = makeEnv(async () => {
      attempt++;
      if (attempt < 3) return new Response('upstream', { status: 503 });
      return pageOk([{ id: 1 }], false);
    });
    const out = await pagedStRead(env, HEADERS, ENDPOINT, {}, { retries: 3 });
    expect(out.items).toHaveLength(1);
    expect(env.ST_PROXY.fetch).toHaveBeenCalledTimes(3);
  });

  it('gives up after retries exhausted on 503 and records partialFailure without dropping prior items', async () => {
    let p = 0;
    const env = makeEnv(async () => {
      p++;
      if (p === 1) return pageOk([{ id: 1 }, { id: 2 }], true);
      return new Response('upstream', { status: 503 });
    });
    const out = await pagedStRead(env, HEADERS, ENDPOINT, {}, { pageSize: 2, retries: 1 });
    expect(out.items).toHaveLength(2);
    expect(out.partialFailures).toHaveLength(1);
    expect(out.partialFailures[0].status).toBe(503);
    expect(out.partialFailures[0].page).toBe(2);
    expect(out.warnings).toContain('partial_pagination_failure');
  });

  it('does not retry on 4xx (non-429) and stops paging without dropping prior items', async () => {
    let p = 0;
    const env = makeEnv(async () => {
      p++;
      if (p === 1) return pageOk([{ id: 1 }], true);
      return new Response('bad request', { status: 400 });
    });
    const out = await pagedStRead(env, HEADERS, ENDPOINT, {}, { pageSize: 1 });
    expect(out.items).toHaveLength(1);
    expect(out.partialFailures).toHaveLength(1);
    expect(out.partialFailures[0].status).toBe(400);
    expect(env.ST_PROXY.fetch).toHaveBeenCalledTimes(2);
  });

  it('aborts mid-loop when AbortSignal fires', async () => {
    const ctl = new AbortController();
    let p = 0;
    const env = makeEnv(async () => {
      p++;
      if (p === 1) {
        // Abort before the second page would be requested.
        ctl.abort();
        return pageOk([{ id: 1 }, { id: 2 }], true);
      }
      return pageOk([{ id: 3 }], false);
    });
    const out = await pagedStRead(env, HEADERS, ENDPOINT, {}, { pageSize: 2, signal: ctl.signal });
    expect(out.items).toHaveLength(2);
    expect(out.warnings).toContain('aborted');
    expect(env.ST_PROXY.fetch).toHaveBeenCalledTimes(1);
  });

  it('injects pageSize and page into the URL query', async () => {
    let capturedUrl = '';
    const env = makeEnv(async (url: string) => {
      capturedUrl = url;
      return pageOk([], false);
    });
    await pagedStRead(env, HEADERS, ENDPOINT, { businessUnitIds: '1' }, { pageSize: 50, startPage: 3 });
    expect(capturedUrl).toContain('pageSize%3D50');
    expect(capturedUrl).toContain('page%3D3');
    expect(capturedUrl).toContain('businessUnitIds%3D1');
  });
});
