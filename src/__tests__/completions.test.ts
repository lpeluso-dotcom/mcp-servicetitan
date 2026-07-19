// ============================================================
// completions.test.ts — Phase 2 Task 2.6
//
// Covers:
//   1. listBusinessUnits (src/name-cache.ts) — D1-backed, KV-cached
//      (namecache:business_units, 1800s TTL), never throws.
//   2. businessUnitIdCompletion / staticCompletion callbacks (unit,
//      no protocol machinery) — src/prompts/index.ts.
//   3. Protocol path: a real Client, connected to buildServer()'s
//      per-request McpServer, driving `completion/complete` against the
//      job-cost-margin prompt's businessUnitId argument (mirrors the
//      InMemoryTransport+Client pattern in mcp-protocol.test.ts /
//      catalog-resources.test.ts / prompts.test.ts).
//   4. staticCompletion / WINDOW_OPTIONS / DAYS_BACK_OPTIONS are exercised
//      at the unit level only — no current prompt wires a static
//      completion, so there's no protocol-path prompt arg to drive them
//      through; the exports stay for future use (e.g. a window-style arg).
//
// Mocking convention: matches the rest of this codebase — mock
// env.ST_PROXY.fetch (the single transport readD1 goes through) and a
// stateful in-memory PROXY_STATE KV mock, rather than mocking module
// functions directly (see catalog-resources.test.ts).
// ============================================================

import { describe, it, expect, vi } from 'vitest';
import { listBusinessUnits } from '../name-cache';
import { businessUnitIdCompletion, staticCompletion, WINDOW_OPTIONS, DAYS_BACK_OPTIONS } from '../prompts/index';

// ─── env fakes (same shape as catalog-resources.test.ts) ───────────────

function makeDB() {
  const stmt = {
    bind: vi.fn().mockReturnThis(),
    run: vi.fn().mockResolvedValue({ success: true }),
    first: vi.fn().mockResolvedValue(null),
  };
  return { prepare: vi.fn().mockReturnValue(stmt) };
}

/** Stateful in-memory KV mock — put() persists so a later get() sees it. */
function makeKv() {
  const store = new Map<string, string>();
  return {
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    _store: store,
  };
}

function makeStProxy(sqlHandler?: (sql: string, params: unknown[]) => unknown) {
  return {
    fetch: vi.fn(async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      if (u.pathname === '/api/sql/read') {
        const body = init?.body ? JSON.parse(init.body as string) : {};
        const result = sqlHandler?.(body.sql, body.params ?? []) ?? { success: true, results: [] };
        return new Response(JSON.stringify(result), { status: 200 });
      }
      return new Response('unmapped', { status: 404 });
    }),
  };
}

function makeEnv(sqlHandler?: (sql: string, params: unknown[]) => unknown) {
  return {
    DB: makeDB(),
    PROXY_STATE: makeKv(),
    ST_PROXY: makeStProxy(sqlHandler),
    MCP_SYNC_KEY: 'test-key',
    MCP_SERVICE_VERSION: '0.0.0-test',
    ST_TENANT_ID: '000000000',
  } as any;
}

const FIXTURE_BUS = [
  { id: 1, name: 'HVAC Service Residential' },
  { id: 2, name: 'Plumbing' },
  { id: 3, name: 'Electrical' },
];

// ─── 1. listBusinessUnits ────────────────────────────────────────────────

describe('listBusinessUnits (src/name-cache.ts)', () => {
  it('cache miss: reads business_units from D1 and returns id+name rows', async () => {
    const env = makeEnv((sql) => {
      expect(sql).toMatch(/^SELECT .* FROM business_units/i);
      expect(sql).toMatch(/active = 1/i);
      return {
        success: true,
        results: [
          { id: 1, name: 'HVAC Service Residential' },
          { id: 2, name: 'Plumbing' },
        ],
      };
    });

    const bus = await listBusinessUnits(env);

    expect(bus).toEqual([
      { id: 1, name: 'HVAC Service Residential' },
      { id: 2, name: 'Plumbing' },
    ]);
    // Result was cached under the documented key + TTL.
    expect(env.PROXY_STATE.put).toHaveBeenCalledTimes(1);
    const [key, value, options] = env.PROXY_STATE.put.mock.calls[0];
    expect(key).toBe('namecache:business_units');
    expect(JSON.parse(value)).toEqual(bus);
    expect(options).toMatchObject({ expirationTtl: 1800 });
  });

  it('cache hit: returns the cached value and never calls D1', async () => {
    const env = makeEnv(() => {
      throw new Error('D1 should not be called on a cache hit');
    });
    await env.PROXY_STATE.put('namecache:business_units', JSON.stringify(FIXTURE_BUS));
    env.ST_PROXY.fetch.mockClear();

    const bus = await listBusinessUnits(env);

    expect(bus).toEqual(FIXTURE_BUS);
    expect(env.ST_PROXY.fetch).not.toHaveBeenCalled();
  });

  it('source error: resolves to [] rather than throwing, and does not cache the failure', async () => {
    const env = makeEnv(() => ({ success: false, error: 'no such table: business_units' }));

    const bus = await listBusinessUnits(env);

    expect(bus).toEqual([]);
    expect(env.PROXY_STATE.put).not.toHaveBeenCalled();
  });

  it('KV read blip: falls through to a fresh D1 load rather than throwing', async () => {
    const env = makeEnv(() => ({ success: true, results: FIXTURE_BUS.map((b) => ({ id: b.id, name: b.name })) }));
    env.PROXY_STATE.get.mockRejectedValueOnce(new Error('KV unavailable'));

    const bus = await listBusinessUnits(env);

    expect(bus).toEqual(FIXTURE_BUS);
  });
});

// ─── 2. Completion callbacks — unit (no protocol machinery) ─────────────

describe('businessUnitIdCompletion (src/prompts/index.ts)', () => {
  function envWithBus() {
    return makeEnv(() => ({ success: true, results: FIXTURE_BUS }));
  }

  it('prefix "Plumb" resolves to the Plumbing BU id string', async () => {
    const complete = businessUnitIdCompletion(envWithBus());
    const values = await complete('Plumb');
    expect(values).toEqual(['2']);
  });

  it('empty value returns all BU ids, capped', async () => {
    const complete = businessUnitIdCompletion(envWithBus());
    const values = await complete('');
    expect(values.sort()).toEqual(['1', '2', '3']);
  });

  it('a non-matching value returns []', async () => {
    const complete = businessUnitIdCompletion(envWithBus());
    const values = await complete('Roofing');
    expect(values).toEqual([]);
  });

  it('matches by numeric id substring as well as name', async () => {
    const complete = businessUnitIdCompletion(envWithBus());
    const values = await complete('3');
    expect(values).toEqual(['3']);
  });

  it('a source error degrades to [] rather than throwing out of the completion', async () => {
    const env = makeEnv(() => ({ success: false, error: 'boom' }));
    const complete = businessUnitIdCompletion(env);
    const values = await complete('Plumb');
    expect(values).toEqual([]);
  });
});

describe('staticCompletion (src/prompts/index.ts)', () => {
  it('window: returns the 4 options filtered by prefix', async () => {
    const complete = staticCompletion(WINDOW_OPTIONS);
    expect(await complete('')).toEqual(['7d', '30d', '60d', '90d']);
    expect(await complete('9')).toEqual(['90d']);
    expect(await complete('999')).toEqual([]);
  });

  it('daysBack: returns the 4 options filtered by prefix', async () => {
    const complete = staticCompletion(DAYS_BACK_OPTIONS);
    expect(await complete('')).toEqual(['7', '14', '30', '60']);
    expect(await complete('6')).toEqual(['60']);
  });
});

// ─── 3+4. Protocol path — real Client, buildServer(), completion/complete ─

vi.mock('agents/mcp', () => ({ createMcpHandler: () => () => new Response() }));
vi.mock('../oauth', () => ({
  createOAuthProvider: () => ({ fetch: async () => new Response() }),
  handleOAuthRoute: async () => new Response(),
}));

const { buildServer } = await import('../index');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');

const execCtx = { waitUntil: () => undefined } as any;

async function connectedClient(env: ReturnType<typeof makeEnv>) {
  const server = buildServer(env, execCtx, { actor: 'test-completions', role: 'default' });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'completions-test-client', version: '0.0.0-test' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe('protocol path — completion/complete via buildServer()', () => {
  it('job-cost-margin.businessUnitId: completes "Plumb" to the Plumbing BU id', async () => {
    const env = makeEnv(() => ({ success: true, results: FIXTURE_BUS }));
    const client = await connectedClient(env);

    const result = await client.complete({
      ref: { type: 'ref/prompt', name: 'job-cost-margin' },
      argument: { name: 'businessUnitId', value: 'Plumb' },
    });

    expect(result.completion.values).toEqual(['2']);
  });

  it('job-cost-margin.businessUnitId: empty value returns all BU ids', async () => {
    const env = makeEnv(() => ({ success: true, results: FIXTURE_BUS }));
    const client = await connectedClient(env);

    const result = await client.complete({
      ref: { type: 'ref/prompt', name: 'job-cost-margin' },
      argument: { name: 'businessUnitId', value: '' },
    });

    expect(result.completion.values.sort()).toEqual(['1', '2', '3']);
  });

  it('pricebook-health.businessUnitId: completes "Elect" to the Electrical BU id', async () => {
    const env = makeEnv(() => ({ success: true, results: FIXTURE_BUS }));
    const client = await connectedClient(env);

    const result = await client.complete({
      ref: { type: 'ref/prompt', name: 'pricebook-health' },
      argument: { name: 'businessUnitId', value: 'Elect' },
    });

    expect(result.completion.values).toEqual(['3']);
  });

  it('a second request against a fresh buildServer() does not throw ("Cannot redefine property")', async () => {
    // Regression guard for the completable() re-registration hazard:
    // buildServer() runs registerPrompts() fresh per request, and
    // completable() decorates a zod schema in place — reusing the same
    // shared PROMPTS[].argsSchema object across requests would throw on
    // the second registerPrompt call. freshClone() in prompts/index.ts is
    // the fix; this proves two independent buildServer() calls both work.
    const env1 = makeEnv(() => ({ success: true, results: FIXTURE_BUS }));
    const env2 = makeEnv(() => ({ success: true, results: FIXTURE_BUS }));

    await expect(connectedClient(env1)).resolves.toBeDefined();
    await expect(connectedClient(env2)).resolves.toBeDefined();

    const client2 = await connectedClient(env2);
    const result = await client2.complete({
      ref: { type: 'ref/prompt', name: 'job-cost-margin' },
      argument: { name: 'businessUnitId', value: 'Elect' },
    });
    expect(result.completion.values).toEqual(['3']);
  });
});
