// ============================================================
// F3 tests — composite fanout helper (gatherFetches)
// Verifies all-OK, all-failed, mixed, HTTP non-OK, and JSON parse paths.
// ============================================================

import { describe, it, expect } from 'vitest';
import { gatherFetches, gatherFetchesWithTruncation } from '../../composite-helpers';

function ok(payload: unknown): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } }));
}

function bad(status: number, body = 'fail'): Promise<Response> {
  return Promise.resolve(new Response(body, { status, statusText: 'Server Error' }));
}

function thrown(msg: string): Promise<Response> {
  return Promise.reject(new TypeError(msg));
}

function malformed(): Promise<Response> {
  return Promise.resolve(new Response('not-json', { status: 200, headers: { 'content-type': 'application/json' } }));
}

describe('gatherFetches', () => {
  it('returns ok=true with no failures when every call succeeds', async () => {
    const out = await gatherFetches([
      { name: 'a', promise: ok({ data: [1, 2] }) },
      { name: 'b', promise: ok({ data: [3] }) },
    ]);
    expect(out.partial).toBe(false);
    expect(out.failures).toEqual([]);
    expect(out.results.a).toEqual([1, 2]);
    expect(out.results.b).toEqual([3]);
  });

  it('returns inner json when no .data wrapper', async () => {
    const out = await gatherFetches([{ name: 'a', promise: ok({ id: 42 }) }]);
    expect(out.results.a).toEqual({ id: 42 });
  });

  it('flags partial=true and surfaces a single rejection', async () => {
    const out = await gatherFetches([
      { name: 'a', promise: ok({ data: [1] }) },
      { name: 'b', promise: thrown('socket timeout') },
    ]);
    expect(out.partial).toBe(true);
    expect(out.results.a).toEqual([1]);
    expect(out.results.b).toBeNull();
    expect(out.failures).toHaveLength(1);
    expect(out.failures[0]).toMatchObject({
      call: 'b',
      error_class: 'TypeError',
      message: 'socket timeout',
    });
  });

  it('flags partial=true on HTTP non-OK and reports status in message', async () => {
    const out = await gatherFetches([
      { name: 'a', promise: bad(503, 'gateway') },
    ]);
    expect(out.partial).toBe(true);
    expect(out.results.a).toBeNull();
    expect(out.failures[0]).toMatchObject({ call: 'a', error_class: 'HTTPError' });
    expect(out.failures[0].message).toContain('503');
  });

  it('flags partial=true on JSON parse error', async () => {
    const out = await gatherFetches([
      { name: 'a', promise: malformed() },
    ]);
    expect(out.partial).toBe(true);
    expect(out.results.a).toBeNull();
    expect(out.failures[0]).toMatchObject({ call: 'a', error_class: 'JSONParseError' });
  });

  it('handles mixed success/failure across many calls', async () => {
    const out = await gatherFetches([
      { name: 'cust', promise: ok({ data: [{ id: 1 }] }) },
      { name: 'jobs', promise: bad(500) },
      { name: 'inv', promise: thrown('abort') },
      { name: 'memb', promise: ok({ data: [] }) },
    ]);
    expect(out.partial).toBe(true);
    expect(out.results.cust).toEqual([{ id: 1 }]);
    expect(out.results.memb).toEqual([]);
    expect(out.results.jobs).toBeNull();
    expect(out.results.inv).toBeNull();
    expect(out.failures.map((f) => f.call).sort()).toEqual(['inv', 'jobs']);
  });

  it('returns empty results object on empty input', async () => {
    const out = await gatherFetches([]);
    expect(out.partial).toBe(false);
    expect(out.failures).toEqual([]);
    expect(out.results).toEqual({});
  });

  it('preserves call order for failures array', async () => {
    const out = await gatherFetches([
      { name: 'a', promise: thrown('a fail') },
      { name: 'b', promise: ok({ data: 'ok' }) },
      { name: 'c', promise: thrown('c fail') },
    ]);
    expect(out.failures.map((f) => f.call)).toEqual(['a', 'c']);
  });
});

// ── F-11: truncation disclosure ─────────────────────────────
describe('gatherFetchesWithTruncation', () => {
  function resp(body: unknown): Promise<Response> {
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  }

  it('flags arms whose ST response has hasMore:true, returns .data as results', async () => {
    const out = await gatherFetchesWithTruncation([
      { name: 'jobs', promise: resp({ data: [{ id: 1 }], hasMore: true }) },
      { name: 'invoices', promise: resp({ data: [{ id: 2 }], hasMore: false }) },
      { name: 'locations', promise: resp({ data: [{ id: 3 }] }) }, // hasMore absent
    ]);
    expect(out.results.jobs).toEqual([{ id: 1 }]);
    expect(out.results.invoices).toEqual([{ id: 2 }]);
    expect(out.results.locations).toEqual([{ id: 3 }]);
    expect(out.truncated).toEqual(['jobs']);
    expect(out.partial).toBe(false);
    expect(out.failures).toEqual([]);
  });

  it('a failed arm is not in truncated and is reported in failures', async () => {
    const out = await gatherFetchesWithTruncation([
      { name: 'jobs', promise: resp({ data: [], hasMore: true }) },
      { name: 'invoices', promise: Promise.resolve(new Response('x', { status: 503, statusText: 'Bad Gateway' })) },
    ]);
    expect(out.truncated).toEqual(['jobs']);
    expect(out.partial).toBe(true);
    expect(out.failures[0]).toMatchObject({ call: 'invoices', error_class: 'HTTPError' });
    expect(out.results.invoices).toBeNull();
  });
});
