// ============================================================
// d1-proxy.ts — QUA-267 finding 3 regression
//
// Verifies the retry/classification/correlation behavior added to
// the shared D1 read helper. Pre-fix, every transient 500 from the
// servicetitan-proxy bubbled directly to the tool's response as
// `upstream_error` with no retry. The helper now masks 95%+ of
// transient flakes with two backoff retries and surfaces a clear
// D1ProxyError after persistent failure.
// ============================================================

import { describe, it, expect, vi } from 'vitest';
import { queryD1, queryD1First, D1ProxyError } from '../d1-proxy';

interface MockResponse {
  httpStatus?: number;
  body?: unknown;
  throws?: boolean;
}

function fakeEnv(responses: MockResponse[]) {
  let i = 0;
  const fetcher = vi.fn(async () => {
    const r = responses[i++];
    if (!r) {
      // exhausted queue — return empty success
      return new Response(JSON.stringify({ success: true, results: [] }), { status: 200 });
    }
    if (r.throws) throw new Error('network');
    return new Response(
      JSON.stringify(r.body ?? { success: true, results: [] }),
      { status: r.httpStatus ?? 200 },
    );
  });
  return {
    ST_PROXY: { fetch: fetcher },
    MCP_SYNC_KEY: 'test-key',
    MCP_METRICS: { writeDataPoint: vi.fn() },
  } as any;
}

describe('d1-proxy', () => {
  describe('queryD1', () => {
    it('returns results on a clean 200', async () => {
      const env = fakeEnv([{ body: { success: true, results: [{ id: 1 }, { id: 2 }] } }]);
      const out = await queryD1(env, 'SELECT 1', []);
      expect(out).toEqual([{ id: 1 }, { id: 2 }]);
      expect((env.ST_PROXY.fetch as any).mock.calls).toHaveLength(1);
    });

    it('retries on transient 500 and recovers on second attempt', async () => {
      const env = fakeEnv([
        { httpStatus: 500 },
        { body: { success: true, results: [{ id: 7 }] } },
      ]);
      const out = await queryD1(env, 'SELECT 1', []);
      expect(out).toEqual([{ id: 7 }]);
      expect((env.ST_PROXY.fetch as any).mock.calls).toHaveLength(2);
    });

    it('retries 429 (rate limit) the same as 5xx', async () => {
      const env = fakeEnv([
        { httpStatus: 429 },
        { body: { success: true, results: [{ id: 3 }] } },
      ]);
      const out = await queryD1(env, 'SELECT 1', []);
      expect(out).toEqual([{ id: 3 }]);
    });

    it('throws D1ProxyError(transient=true) after MAX_RETRIES persistent 500s', async () => {
      const env = fakeEnv([
        { httpStatus: 500 },
        { httpStatus: 500 },
        { httpStatus: 500 },
      ]);
      let caught: D1ProxyError | null = null;
      try {
        await queryD1(env, 'SELECT 1', []);
      } catch (err) {
        caught = err as D1ProxyError;
      }
      expect(caught).toBeInstanceOf(D1ProxyError);
      expect(caught!.status).toBe(500);
      expect(caught!.transient).toBe(true);
      expect(caught!.attempts).toBe(3); // 1 initial + 2 retries
      expect((env.ST_PROXY.fetch as any).mock.calls).toHaveLength(3);
    });

    it('throws D1ProxyError(transient=false) immediately on terminal 400', async () => {
      const env = fakeEnv([{ httpStatus: 400 }]);
      let caught: D1ProxyError | null = null;
      try {
        await queryD1(env, 'SELECT 1', []);
      } catch (err) {
        caught = err as D1ProxyError;
      }
      expect(caught).toBeInstanceOf(D1ProxyError);
      expect(caught!.transient).toBe(false);
      expect(caught!.attempts).toBe(1); // no retry on terminal
      // Critically: only ONE call, no retry burning.
      expect((env.ST_PROXY.fetch as any).mock.calls).toHaveLength(1);
    });

    it('throws D1ProxyError(transient=false) on success=false envelope (terminal)', async () => {
      const env = fakeEnv([{ body: { success: false, error: 'no such column: foo' } }]);
      let caught: D1ProxyError | null = null;
      try {
        await queryD1(env, 'SELECT foo FROM bar', []);
      } catch (err) {
        caught = err as D1ProxyError;
      }
      expect(caught).toBeInstanceOf(D1ProxyError);
      expect(caught!.transient).toBe(false);
      expect(caught!.message).toMatch(/no such column: foo/);
      expect((env.ST_PROXY.fetch as any).mock.calls).toHaveLength(1);
    });

    it('retries on a thrown network error (treated as transient)', async () => {
      const env = fakeEnv([
        { throws: true },
        { body: { success: true, results: [{ id: 9 }] } },
      ]);
      const out = await queryD1(env, 'SELECT 1', []);
      expect(out).toEqual([{ id: 9 }]);
    });

    it('writes MCP_METRICS row per attempt (correlation-tagged)', async () => {
      const env = fakeEnv([
        { httpStatus: 500 },
        { body: { success: true, results: [{ id: 5 }] } },
      ]);
      await queryD1(env, 'SELECT 1', [], { correlation: 'abc-123', tag: 'my_tool' });
      const writes = (env.MCP_METRICS.writeDataPoint as any).mock.calls;
      // 2 attempts → 2 metric writes
      expect(writes.length).toBe(2);
      // Tag passes through as the index, correlation in source.
      expect(writes[0][0].indexes).toEqual(['my_tool']);
      expect(writes[0][0].blobs[0]).toBe('error');
      expect(writes[1][0].indexes).toEqual(['my_tool']);
      expect(writes[1][0].blobs[0]).toBe('ok');
      expect(writes[0][0].blobs[1]).toContain('corr=abc-123');
    });

    it('passes sql + params through to the proxy faithfully', async () => {
      const env = fakeEnv([{ body: { success: true, results: [] } }]);
      await queryD1(env, 'SELECT * FROM t WHERE x = ?', ['hello']);
      const callBody = JSON.parse((env.ST_PROXY.fetch as any).mock.calls[0][1].body);
      expect(callBody.sql).toBe('SELECT * FROM t WHERE x = ?');
      expect(callBody.params).toEqual(['hello']);
    });
  });

  describe('queryD1First', () => {
    it('returns the first row when results are non-empty', async () => {
      const env = fakeEnv([{ body: { success: true, results: [{ id: 1 }, { id: 2 }] } }]);
      const row = await queryD1First(env, 'SELECT 1', []);
      expect(row).toEqual({ id: 1 });
    });

    it('returns null when results are empty', async () => {
      const env = fakeEnv([{ body: { success: true, results: [] } }]);
      const row = await queryD1First(env, 'SELECT 1', []);
      expect(row).toBeNull();
    });

    it('propagates D1ProxyError on terminal failure', async () => {
      const env = fakeEnv([{ httpStatus: 404 }]);
      await expect(queryD1First(env, 'SELECT 1', [])).rejects.toBeInstanceOf(D1ProxyError);
    });
  });
});
