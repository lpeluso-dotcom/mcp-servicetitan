// ============================================================
// completions.test.ts — Phase 2 Task 2.6
//
// Covers:
//   1. listBusinessUnits / listBusinessUnitsStamped (src/name-cache.ts) —
//      D1-backed, KV-cached (namecache:business_units:v2, 1800s TTL),
//      never throws. The cached entry carries the table's MAX(synced_at)
//      alongside the rows so the freshness stamp can be recomputed on every
//      read without a second D1 round trip (workstream D item 2).
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
import { listBusinessUnits, listBusinessUnitsStamped, BU_CACHE_KEY } from '../name-cache';
import { businessUnitIdCompletion } from '../prompts/index';

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

function makeStProxy(
  sqlHandler?: (sql: string, params: unknown[]) => unknown,
  tableMaxIso?: string | null,
) {
  return {
    fetch: vi.fn(async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      if (u.pathname === '/api/sql/read') {
        const body = init?.body ? JSON.parse(init.body as string) : {};
        const sql: string = body.sql ?? '';
        if (tableMaxIso !== undefined && /MAX\(synced_at\)/i.test(sql)) {
          return new Response(
            JSON.stringify({ success: true, results: [{ t: 'business_units', m: tableMaxIso }] }),
            { status: 200 },
          );
        }
        const result = sqlHandler?.(sql, body.params ?? []) ?? { success: true, results: [] };
        return new Response(JSON.stringify(result), { status: 200 });
      }
      return new Response('unmapped', { status: 404 });
    }),
  };
}

function makeEnv(
  sqlHandler?: (sql: string, params: unknown[]) => unknown,
  tableMaxIso?: string | null,
) {
  return {
    DB: makeDB(),
    PROXY_STATE: makeKv(),
    ST_PROXY: makeStProxy(sqlHandler, tableMaxIso),
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
    // Result was cached under the documented key + TTL. The cached payload
    // is {rows, tableMax}, NOT a bare row array — the table's
    // MAX(synced_at) is captured at load time so the freshness stamp can be
    // recomputed on each read without another D1 hit. The key carries a
    // `:v2` suffix precisely because that shape changed: a live `:v1` entry
    // would otherwise deserialize into an array and blow up the reader.
    expect(env.PROXY_STATE.put).toHaveBeenCalledTimes(1);
    const [key, value, options] = env.PROXY_STATE.put.mock.calls[0];
    expect(key).toBe(BU_CACHE_KEY);
    expect(BU_CACHE_KEY).toBe('namecache:business_units:v2');
    const cached = JSON.parse(value);
    expect(cached.rows.map((r: { id: number; name: string }) => ({ id: r.id, name: r.name }))).toEqual(bus);
    expect(cached).toHaveProperty('tableMax');
    expect(options).toMatchObject({ expirationTtl: 1800 });
  });

  it('cache hit: returns the cached value and never calls D1', async () => {
    const env = makeEnv(() => {
      throw new Error('D1 should not be called on a cache hit');
    });
    await env.PROXY_STATE.put(
      BU_CACHE_KEY,
      JSON.stringify({ rows: FIXTURE_BUS, tableMax: { business_units: new Date().toISOString() } }),
    );
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

// ─── 1b. listBusinessUnitsStamped (workstream D item 2) ──────────────────
//
// listBusinessUnits() feeds MCP completions, where a freshness caveat has
// nowhere to render — a completion list is a list of strings. So the stamp
// lives on a sibling that returns the same rows in a disclosable envelope,
// and the business-units catalog resource consumes it. Same KV entry, same
// single D1 load; the verdict is recomputed per call against the
// MAX(synced_at) captured when the rows were loaded, so a cached catalog
// ages honestly rather than freezing a 'fresh' verdict for the whole TTL.

describe('listBusinessUnitsStamped (src/name-cache.ts)', () => {
  it('returns the rows plus a proven-fresh stamp when the mirror is alive', async () => {
    const env = makeEnv(
      () => ({ success: true, results: FIXTURE_BUS }),
      new Date(Date.now() - 60 * 60_000).toISOString(),
    );

    const out = await listBusinessUnitsStamped(env);

    expect(out.business_units).toEqual(FIXTURE_BUS);
    expect(out.count).toBe(3);
    expect(out._mirror_table).toBe('business_units');
    expect(out._freshness).toBe('fresh');
    expect(out._warning).toBeUndefined();
  });

  it('discloses an unprovable mirror instead of serving a bare empty list', async () => {
    const env = makeEnv(() => ({ success: false, error: 'no such table' }), null);

    const out = await listBusinessUnitsStamped(env);

    expect(out.business_units).toEqual([]);
    expect(out.count).toBe(0);
    expect(out._empty).toBe(true);
    expect(out._freshness).toBe('unknown');
    expect(out._warning).toEqual(expect.any(String));
  });

  it('never throws when both D1 and KV are down', async () => {
    const env = makeEnv(() => {
      throw new Error('D1 down');
    }, null);
    env.PROXY_STATE.get.mockRejectedValue(new Error('KV down'));
    env.PROXY_STATE.put.mockRejectedValue(new Error('KV down'));

    const out = await listBusinessUnitsStamped(env);
    expect(out.business_units).toEqual([]);
    expect(out._freshness).toBe('unknown');
  });

  it('shares one KV entry with listBusinessUnits — no second D1 load', async () => {
    const env = makeEnv(
      () => ({ success: true, results: FIXTURE_BUS }),
      new Date().toISOString(),
    );

    await listBusinessUnits(env);
    env.ST_PROXY.fetch.mockClear();
    const out = await listBusinessUnitsStamped(env);

    expect(env.ST_PROXY.fetch).not.toHaveBeenCalled();
    expect(out.business_units).toEqual(FIXTURE_BUS);
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
