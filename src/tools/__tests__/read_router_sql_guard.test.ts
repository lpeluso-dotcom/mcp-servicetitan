// ============================================================
// F-05 — read-router.queryD1 client-side SELECT guard.
//
// taylor-ai's /internal/query-d1 RPC enforces SELECT-only on the server side.
// This test pins the worker-side defense-in-depth check that rejects mutations
// before they ever leave the worker.
// ============================================================

import { describe, it, expect, vi } from 'vitest';
import { ReadRouter } from '../../read-router';
import type { Env } from '../../env';

function makeEnv() {
  const fetch = vi.fn(async () =>
    new Response(JSON.stringify({ rows: [], updatedAt: 0 }), { status: 200 })
  );
  const env = {
    TAYLOR_AI: { fetch },
    MCP_SYNC_KEY: 'test-secret-key',
    MCP_SERVICE_VERSION: '1.2.0-test',
  } as unknown as Env;
  return { env, fetch };
}

describe('ReadRouter.queryD1 SQL guard', () => {
  it('passes a valid SELECT through to taylor-ai', async () => {
    const { env, fetch } = makeEnv();
    const router = new ReadRouter(env);
    const result = await router.queryD1('SELECT * FROM customers WHERE id = ?', [1]);
    expect(result).toEqual({ rows: [], updatedAt: 0 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('passes lowercase select case-insensitively', async () => {
    const { env, fetch } = makeEnv();
    const router = new ReadRouter(env);
    await router.queryD1('select * from jobs', []);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('passes SELECT with leading whitespace', async () => {
    const { env, fetch } = makeEnv();
    const router = new ReadRouter(env);
    await router.queryD1('   SELECT 1', []);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects DELETE without making the RPC call', async () => {
    const { env, fetch } = makeEnv();
    const router = new ReadRouter(env);
    await expect(router.queryD1('DELETE FROM customers', [])).rejects.toThrow(/only SELECT/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects INSERT, UPDATE, DROP, ALTER, TRUNCATE', async () => {
    const { env, fetch } = makeEnv();
    const router = new ReadRouter(env);
    for (const sql of [
      'INSERT INTO customers (id) VALUES (1)',
      'UPDATE customers SET name = "x"',
      'DROP TABLE customers',
      'ALTER TABLE customers ADD COLUMN x TEXT',
      'TRUNCATE TABLE customers',
    ]) {
      await expect(router.queryD1(sql, [])).rejects.toThrow(/only SELECT/);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects empty / whitespace-only SQL', async () => {
    const { env, fetch } = makeEnv();
    const router = new ReadRouter(env);
    await expect(router.queryD1('', [])).rejects.toThrow(/only SELECT/);
    await expect(router.queryD1('   ', [])).rejects.toThrow(/only SELECT/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects a leading semicolon followed by mutation', async () => {
    // ;DELETE doesn't start with SELECT and the regex anchors at start, so this is rejected.
    const { env, fetch } = makeEnv();
    const router = new ReadRouter(env);
    await expect(router.queryD1(';DELETE FROM customers', [])).rejects.toThrow(/only SELECT/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects SQL that contains SELECT but does not start with it', async () => {
    const { env, fetch } = makeEnv();
    const router = new ReadRouter(env);
    await expect(
      router.queryD1('-- SELECT looks like a comment\nDELETE FROM customers', [])
    ).rejects.toThrow(/only SELECT/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
