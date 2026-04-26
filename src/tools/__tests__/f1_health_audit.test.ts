// ============================================================
// F1 tests — /admin/health/audit probe
// Strategy: mock env.DB; build a minimal Hono app with the same
// handler the worker registers in src/index.ts.
// ============================================================

import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { auditHealthHandler } from '../../routes/admin-health-audit';

function makeDB(lastAudit: number | null, lastError: number | null) {
  const stmt = (val: { last_ts: number | null }) => ({
    bind: vi.fn().mockReturnThis(),
    first: vi.fn().mockResolvedValue(val),
  });
  return {
    prepare: vi.fn((sql: string) => {
      if (/audit_log/i.test(sql)) return stmt({ last_ts: lastAudit });
      if (/error_log/i.test(sql)) return stmt({ last_ts: lastError });
      throw new Error(`unexpected SQL: ${sql}`);
    }),
  };
}

function makeApp(env: any) {
  const app = new Hono<{ Bindings: any }>();
  app.get('/admin/health/audit', auditHealthHandler);
  return (req: Request) => app.fetch(req, env);
}

const KEY = 'test-sync-key';

describe('GET /admin/health/audit', () => {
  it('rejects missing X-Sync-Key with 401', async () => {
    const env = { DB: makeDB(null, null), MCP_SYNC_KEY: KEY, MCP_SERVICE_VERSION: '1.1.0-test' };
    const fetch = makeApp(env);
    const res = await fetch(new Request('http://x/admin/health/audit'));
    expect(res.status).toBe(401);
  });

  it('rejects wrong X-Sync-Key with 401', async () => {
    const env = { DB: makeDB(null, null), MCP_SYNC_KEY: KEY, MCP_SERVICE_VERSION: '1.1.0-test' };
    const fetch = makeApp(env);
    const res = await fetch(
      new Request('http://x/admin/health/audit', { headers: { 'x-sync-key': 'nope' } })
    );
    expect(res.status).toBe(401);
  });

  it('reports silence when audit_log is empty', async () => {
    const env = { DB: makeDB(null, null), MCP_SYNC_KEY: KEY, MCP_SERVICE_VERSION: '1.1.0-test' };
    const fetch = makeApp(env);
    const res = await fetch(
      new Request('http://x/admin/health/audit', { headers: { 'x-sync-key': KEY } })
    );
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.ok).toBe(true);
    expect(body.is_silent).toBe(true);
    expect(body.last_audit_ts).toBeNull();
    expect(body.last_audit_iso).toBeNull();
    expect(body.last_audit_age_ms).toBeNull();
    expect(body._hint).toMatch(/no audit activity/i);
  });

  it('reports active when audit_log has a recent row', async () => {
    const recent = Date.now() - 60_000; // 1 min ago
    const env = { DB: makeDB(recent, null), MCP_SYNC_KEY: KEY, MCP_SERVICE_VERSION: '1.1.0-test' };
    const fetch = makeApp(env);
    const res = await fetch(
      new Request('http://x/admin/health/audit', { headers: { 'x-sync-key': KEY } })
    );
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.is_silent).toBe(false);
    expect(body.last_audit_ts).toBe(recent);
    expect(body.last_audit_iso).toBe(new Date(recent).toISOString());
    expect(body.last_audit_age_ms).toBeGreaterThanOrEqual(0);
    expect(body._hint).toBeNull();
  });

  it('reports silent when last audit is older than the 1h threshold', async () => {
    const old = Date.now() - 2 * 60 * 60 * 1000; // 2h ago
    const env = { DB: makeDB(old, null), MCP_SYNC_KEY: KEY, MCP_SERVICE_VERSION: '1.1.0-test' };
    const fetch = makeApp(env);
    const res = await fetch(
      new Request('http://x/admin/health/audit', { headers: { 'x-sync-key': KEY } })
    );
    const body: any = await res.json();
    expect(body.is_silent).toBe(true);
    expect(body.last_audit_age_ms).toBeGreaterThan(60 * 60 * 1000);
  });

  it('surfaces last error_log timestamp', async () => {
    const auditTs = Date.now() - 1000;
    const errorTs = Date.now() - 5000;
    const env = { DB: makeDB(auditTs, errorTs), MCP_SYNC_KEY: KEY, MCP_SERVICE_VERSION: '1.1.0-test' };
    const fetch = makeApp(env);
    const res = await fetch(
      new Request('http://x/admin/health/audit', { headers: { 'x-sync-key': KEY } })
    );
    const body: any = await res.json();
    expect(body.last_error_ts).toBe(errorTs);
    expect(body.last_error_iso).toBe(new Date(errorTs).toISOString());
  });

  it('returns 500 with detail when D1 throws', async () => {
    const env: any = {
      DB: { prepare: vi.fn(() => { throw new Error('D1 down'); }) },
      MCP_SYNC_KEY: KEY,
      MCP_SERVICE_VERSION: '1.1.0-test',
    };
    const fetch = makeApp(env);
    const res = await fetch(
      new Request('http://x/admin/health/audit', { headers: { 'x-sync-key': KEY } })
    );
    expect(res.status).toBe(500);
    const body: any = await res.json();
    expect(body.error).toBe('probe failed');
    expect(body.detail).toMatch(/D1 down/);
  });
});
