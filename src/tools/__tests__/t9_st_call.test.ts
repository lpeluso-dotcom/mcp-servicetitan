// ============================================================
// T9 tests — st_call raw gateway (admin-only)
// Verifies: path middleware (all 4 corrections + strip + reject),
// method routing (GET → /read, non-GET → /write), dryRun default.
// ============================================================

import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { st_call } from '../st_call';

const CORRELATION = 'test-corr';
const CTX = { actor: 'vitest', correlation: CORRELATION };

function makeDB(firstResult: unknown = null) {
  const stmt = {
    bind: vi.fn().mockReturnThis(),
    run: vi.fn().mockResolvedValue({ success: true }),
    first: vi.fn().mockResolvedValue(firstResult),
  };
  return { prepare: vi.fn().mockReturnValue(stmt) };
}

function makeEnv(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>): any {
  return {
    ST_PROXY: { fetch: vi.fn(fetchImpl) },
    MCP_SYNC_KEY: 'test-key',
    MCP_SERVICE_VERSION: '0.0.0-test',
    DB: makeDB(),
    PROXY_STATE: {},
    SIRO_API_TOKEN: '',
  };
}

function liveOk(data: unknown) {
  return async () => new Response(JSON.stringify({ data }), { status: 200 });
}

function dryRunFetch() {
  return async (url: string) => {
    if (url.includes('dryRun=1')) return new Response(JSON.stringify({ echo: true }), { status: 200 });
    throw new Error(`unexpected URL: ${url}`);
  };
}

// ── Schema ────────────────────────────────────────────────────

describe('st_call schema', () => {
  const s = z.object(st_call.zodSchema);

  it('is adminOnly', () => {
    expect(st_call.adminOnly).toBe(true);
  });

  it('requires method and path', () => {
    expect(s.safeParse({}).success).toBe(false);
    expect(s.safeParse({ method: 'GET' }).success).toBe(false);
    expect(s.safeParse({ path: '/crm/v2/customers' }).success).toBe(false);
  });

  it('accepts GET with path', () => {
    expect(s.safeParse({ method: 'GET', path: '/crm/v2/tenant/000000000/customers' }).success).toBe(true);
  });

  it('accepts POST with body', () => {
    expect(s.safeParse({ method: 'POST', path: '/jpm/v2/tenant/000000000/jobs', body: { foo: 1 } }).success).toBe(true);
  });

  it('rejects unknown method', () => {
    expect(s.safeParse({ method: 'CONNECT', path: '/foo' }).success).toBe(false);
  });
});

// ── Path middleware ───────────────────────────────────────────

describe('st_call path middleware', () => {
  it('rejects paths not starting with /', async () => {
    const env = makeEnv(liveOk({}));
    await expect(st_call.handler(env, { method: 'GET', path: 'crm/v2/customers' }, CTX))
      .rejects.toMatchObject({ code: 'validation_error' });
  });

  it('correction 1: /task-management/ → /taskmanagement/', async () => {
    const env = makeEnv(liveOk([]));
    await st_call.handler(env, { method: 'GET', path: '/task-management/v2/tenant/000000000/tasks' }, CTX);
    const [url] = env.ST_PROXY.fetch.mock.calls[0];
    expect(url).toContain('taskmanagement');
    expect(url).not.toContain('task-management');
  });

  it('correction 2: auto-injects tenant ID when missing', async () => {
    const env = makeEnv(liveOk([]));
    await st_call.handler(env, { method: 'GET', path: '/crm/v2/customers' }, CTX);
    const [url] = env.ST_PROXY.fetch.mock.calls[0];
    expect(url).toContain('000000000');
  });

  it('correction 2: does not double-inject tenant ID when already present', async () => {
    const env = makeEnv(liveOk([]));
    await st_call.handler(env, { method: 'GET', path: '/crm/v2/tenant/000000000/customers' }, CTX);
    const [url] = env.ST_PROXY.fetch.mock.calls[0];
    const matches = (url as string).match(/000000000/g);
    expect(matches?.length).toBe(1);
  });

  it('strips trailing slash on GET', async () => {
    const env = makeEnv(liveOk([]));
    await st_call.handler(env, { method: 'GET', path: '/crm/v2/tenant/000000000/customers/' }, CTX);
    const [url] = env.ST_PROXY.fetch.mock.calls[0];
    // endpoint param should not have trailing slash
    const endpointParam = new URL(url).searchParams.get('endpoint') ?? '';
    expect(endpointParam.endsWith('/')).toBe(false);
  });

  it('does not strip trailing slash for ODATA paths', async () => {
    const env = makeEnv(liveOk([]));
    await st_call.handler(env, { method: 'GET', path: '/crm/v2/tenant/000000000/customers/$query' }, CTX);
    const [url] = env.ST_PROXY.fetch.mock.calls[0];
    // $query is percent-encoded in the URL; decode to verify passthrough
    expect(decodeURIComponent(url)).toContain('$query');
  });
});

// ── Body middleware ───────────────────────────────────────────

describe('st_call body middleware', () => {
  it('correction 3: isConfigurable → isConfigurableEquipment on PATCH', async () => {
    const env = makeEnv(dryRunFetch());
    const result: any = await st_call.handler(env, {
      method: 'PATCH',
      path: '/pricebook/v2/tenant/000000000/equipment/1',
      body: { isConfigurable: true, name: 'Test' },
    }, CTX);
    expect(result.payload.isConfigurableEquipment).toBe(true);
    expect(result.payload.isConfigurable).toBeUndefined();
  });

  it('correction 4: useStaticPrice → useStaticPrices on write bodies', async () => {
    const env = makeEnv(dryRunFetch());
    const result: any = await st_call.handler(env, {
      method: 'PATCH',
      path: '/pricebook/v2/tenant/000000000/services/1',
      body: { useStaticPrice: true, price: 100 },
    }, CTX);
    expect(result.payload.useStaticPrices).toBe(true);
    expect(result.payload.useStaticPrice).toBeUndefined();
  });
});

// ── Routing ───────────────────────────────────────────────────

describe('st_call routing', () => {
  it('GET routes to /api/st/read', async () => {
    const env = makeEnv(liveOk([]));
    await st_call.handler(env, { method: 'GET', path: '/crm/v2/tenant/000000000/customers' }, CTX);
    const [url] = env.ST_PROXY.fetch.mock.calls[0];
    expect(url).toContain('/api/st/read');
  });

  it('POST routes to /api/st/write with dryRun=true default', async () => {
    const env = makeEnv(dryRunFetch());
    const result: any = await st_call.handler(env, {
      method: 'POST',
      path: '/jpm/v2/tenant/000000000/jobs',
      body: { foo: 1 },
    }, CTX);
    expect(result.dryRun).toBe(true);
  });

  it('GET with query object appends params to URL', async () => {
    const env = makeEnv(liveOk([]));
    await st_call.handler(env, {
      method: 'GET',
      path: '/crm/v2/tenant/000000000/customers',
      query: { name: 'Alice', pageSize: 50 },
    }, CTX);
    const [url] = env.ST_PROXY.fetch.mock.calls[0];
    expect(url).toContain('Alice');
    expect(url).toContain('50');
  });
});
