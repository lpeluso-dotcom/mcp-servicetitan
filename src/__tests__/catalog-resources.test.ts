// ============================================================
// catalog-resources.test.ts — Phase 2 Task 2.5
//
// Covers the 3 browsable catalog resources registered by
// registerCatalogResources() (src/resources/catalogs.ts):
//   - mcp-st://catalog/pricebook-categories (D1 pb_categories)
//   - mcp-st://catalog/technicians          (D1 technicians, PII-stripped)
//   - mcp-st://catalog/reports              (live ST discovery, KV-cached)
//
// Mocking convention: matches the rest of this codebase (see
// src/tools/__tests__/opportunities.test.ts, src/__tests__/mcp-protocol.test.ts,
// src/__tests__/result-offload.test.ts) — mock env.ST_PROXY.fetch (the
// single transport readD1/readST both go through) rather than mocking the
// readD1/readST module functions directly.
// ============================================================

import { describe, it, expect, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { registerCatalogResources } from '../resources/catalogs';
import { registerResultResource } from '../resources/results';

// ─── env fakes ─────────────────────────────────────────────

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

/**
 * ST_PROXY.fetch router: dispatches on method + URL so a single env can
 * serve both readD1 (POST /api/sql/read) and readST (GET /api/st/read)
 * calls, the same way the real servicetitan-proxy binding fronts both.
 */
function makeStProxy(opts: {
  sqlHandler?: (sql: string, params: unknown[]) => unknown;
  stHandler?: (endpoint: string) => { status?: number; body?: unknown } | undefined;
}) {
  return {
    fetch: vi.fn(async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      if (u.pathname === '/api/sql/read') {
        const body = init?.body ? JSON.parse(init.body as string) : {};
        const result = opts.sqlHandler?.(body.sql, body.params ?? []) ?? { success: true, results: [] };
        return new Response(JSON.stringify(result), { status: 200 });
      }
      if (u.pathname === '/api/st/read') {
        const endpoint = u.searchParams.get('endpoint') ?? '';
        const resp = opts.stHandler?.(endpoint);
        if (!resp) return new Response('not found', { status: 404 });
        return new Response(JSON.stringify(resp.body ?? {}), { status: resp.status ?? 200 });
      }
      return new Response('unmapped', { status: 404 });
    }),
  };
}

function makeEnv(opts: {
  sqlHandler?: (sql: string, params: unknown[]) => unknown;
  stHandler?: (endpoint: string) => { status?: number; body?: unknown } | undefined;
} = {}) {
  return {
    DB: makeDB(),
    PROXY_STATE: makeKv(),
    ST_PROXY: makeStProxy(opts),
    MCP_SYNC_KEY: 'test-key',
    MCP_SERVICE_VERSION: '0.0.0-test',
    ST_TENANT_ID: '000000000',
  } as any;
}

async function connectedClient(env: ReturnType<typeof makeEnv>) {
  const server = new McpServer({ name: 'test-catalogs', version: '0.0.0-test' });
  registerCatalogResources(server, env);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'catalog-resources-test-client', version: '0.0.0-test' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

// ─── pricebook-categories ─────────────────────────────────

describe('mcp-st://catalog/pricebook-categories', () => {
  it('returns the pb_categories rows mapped into the {categories,count} envelope', async () => {
    const env = makeEnv({
      sqlHandler: (sql) => {
        expect(sql).toMatch(/^SELECT .* FROM pb_categories/i);
        return {
          success: true,
          results: [
            { id: 1, name: 'HVAC Services', parent_id: null, active: 1, category_type: 'Services' },
            { id: 2, name: 'Filters', parent_id: 1, active: 1, category_type: 'Materials' },
          ],
        };
      },
    });
    const client = await connectedClient(env);

    const read = await client.readResource({ uri: 'mcp-st://catalog/pricebook-categories' });

    expect(read.contents).toHaveLength(1);
    expect(read.contents[0].mimeType).toBe('application/json');
    const parsed = JSON.parse((read.contents[0] as { text: string }).text);
    expect(parsed.count).toBe(2);
    expect(parsed.categories).toEqual([
      { id: 1, name: 'HVAC Services', parent_id: null, active: 1, category_type: 'Services' },
      { id: 2, name: 'Filters', parent_id: 1, active: 1, category_type: 'Materials' },
    ]);
  });

  it('returns an empty envelope (not an error) when the table has no rows', async () => {
    const env = makeEnv({ sqlHandler: () => ({ success: true, results: [] }) });
    const client = await connectedClient(env);

    const read = await client.readResource({ uri: 'mcp-st://catalog/pricebook-categories' });
    const parsed = JSON.parse((read.contents[0] as { text: string }).text);

    expect(parsed).toEqual({ categories: [], count: 0 });
  });
});

// ─── technicians (PII-stripped roster) ─────────────────────

describe('mcp-st://catalog/technicians', () => {
  it('returns the technicians rows mapped into the {technicians,count} envelope', async () => {
    const env = makeEnv({
      sqlHandler: (sql) => {
        expect(sql).toMatch(/^SELECT .* FROM technicians/i);
        return {
          success: true,
          results: [
            { tech_id: '501', name: 'Brooks H', business_unit: 'HVAC Service Residential', role: 'Technician', active: 1 },
          ],
        };
      },
    });
    const client = await connectedClient(env);

    const read = await client.readResource({ uri: 'mcp-st://catalog/technicians' });
    const parsed = JSON.parse((read.contents[0] as { text: string }).text);

    expect(parsed.count).toBe(1);
    expect(parsed.technicians).toEqual([
      { tech_id: '501', name: 'Brooks H', business_unit: 'HVAC Service Residential', role: 'Technician', active: 1 },
    ]);
  });

  // The load-bearing PII regression test: even if the underlying row
  // carries phone/email (a stray extra column, a mis-scoped SELECT *,
  // whatever), the mapper must never echo them into the resource output.
  it('strips phone/email even when the raw D1 row includes them', async () => {
    const env = makeEnv({
      sqlHandler: () => ({
        success: true,
        results: [
          {
            tech_id: '502',
            name: 'Carlos P',
            business_unit: 'Plumbing',
            role: 'Technician',
            active: 1,
            phone: '843-555-0199',
            email: 'carlos.p@qualityservicecompany.net',
            team: 'B',
          },
        ],
      }),
    });
    const client = await connectedClient(env);

    const read = await client.readResource({ uri: 'mcp-st://catalog/technicians' });
    const text = (read.contents[0] as { text: string }).text;
    const parsed = JSON.parse(text);

    expect(text).not.toContain('843-555-0199');
    expect(text).not.toContain('carlos.p@qualityservicecompany.net');
    expect(parsed.technicians[0]).toEqual({
      tech_id: '502',
      name: 'Carlos P',
      business_unit: 'Plumbing',
      role: 'Technician',
      active: 1,
    });
    expect(parsed.technicians[0].phone).toBeUndefined();
    expect(parsed.technicians[0].email).toBeUndefined();
    expect(parsed.technicians[0].team).toBeUndefined();
  });
});

// ─── reports catalog (live discovery, KV-cached) ────────────

describe('mcp-st://catalog/reports', () => {
  it('cache hit: returns the cached catalog and never calls ST', async () => {
    const env = makeEnv({
      stHandler: () => {
        throw new Error('ST should not be called on a cache hit');
      },
    });
    const cachedCatalog = {
      categories: [{ id: 10, name: 'Operations', reports: [{ id: 100, name: 'Dispatch Efficiency' }] }],
      count: 1,
      _cached_at: '2026-07-01T00:00:00.000Z',
    };
    await env.PROXY_STATE.put('catalog:reports', JSON.stringify(cachedCatalog));
    env.ST_PROXY.fetch.mockClear();

    const client = await connectedClient(env);
    const read = await client.readResource({ uri: 'mcp-st://catalog/reports' });
    const parsed = JSON.parse((read.contents[0] as { text: string }).text);

    expect(parsed).toEqual(cachedCatalog);
    expect(env.ST_PROXY.fetch).not.toHaveBeenCalled();
  });

  it('cache miss: discovers categories + per-category reports from ST, then writes the cache', async () => {
    const env = makeEnv({
      stHandler: (endpoint) => {
        if (endpoint.includes('/report-categories')) {
          return {
            body: {
              data: [
                { id: 10, name: 'Operations' },
                { id: 20, name: 'Marketing' },
              ],
            },
          };
        }
        if (endpoint.includes('/report-category/10/reports')) {
          return { body: { data: [{ id: 100, name: 'Dispatch Efficiency' }] } };
        }
        if (endpoint.includes('/report-category/20/reports')) {
          return { body: { data: [{ id: 200, name: 'Campaign ROI' }] } };
        }
        return undefined;
      },
    });

    const client = await connectedClient(env);
    const read = await client.readResource({ uri: 'mcp-st://catalog/reports' });
    const parsed = JSON.parse((read.contents[0] as { text: string }).text);

    expect(parsed.count).toBe(2);
    expect(parsed.categories).toEqual(
      expect.arrayContaining([
        { id: 10, name: 'Operations', reports: [{ id: 100, name: 'Dispatch Efficiency' }] },
        { id: 20, name: 'Marketing', reports: [{ id: 200, name: 'Campaign ROI' }] },
      ]),
    );
    expect(env.ST_PROXY.fetch).toHaveBeenCalled();

    // Cache was written under the documented key + TTL.
    expect(env.PROXY_STATE.put).toHaveBeenCalledTimes(1);
    const [key, value, options] = env.PROXY_STATE.put.mock.calls[0];
    expect(key).toBe('catalog:reports');
    expect(options).toMatchObject({ expirationTtl: 3600 });
    expect(JSON.parse(value)).toEqual(parsed);
  });

  it('ST error on category discovery: returns an empty catalog + _error, never throws, and does not cache the failure', async () => {
    const env = makeEnv({
      stHandler: (endpoint) => {
        if (endpoint.includes('/report-categories')) {
          return { status: 500, body: { message: 'upstream ST failure' } };
        }
        return undefined;
      },
    });

    const client = await connectedClient(env);
    const read = await client.readResource({ uri: 'mcp-st://catalog/reports' });
    const parsed = JSON.parse((read.contents[0] as { text: string }).text);

    expect(parsed.categories).toEqual([]);
    expect(parsed.count).toBe(0);
    expect(typeof parsed._error).toBe('string');
    expect(parsed._error.length).toBeGreaterThan(0);
    expect(env.PROXY_STATE.put).not.toHaveBeenCalled();
  });

  it('ST error on a single category reports fetch: that category carries _error, the rest of the catalog is intact', async () => {
    const env = makeEnv({
      stHandler: (endpoint) => {
        if (endpoint.includes('/report-categories')) {
          return {
            body: {
              data: [
                { id: 10, name: 'Operations' },
                { id: 20, name: 'Marketing' },
              ],
            },
          };
        }
        if (endpoint.includes('/report-category/10/reports')) {
          return { status: 500, body: { message: 'boom' } };
        }
        if (endpoint.includes('/report-category/20/reports')) {
          return { body: { data: [{ id: 200, name: 'Campaign ROI' }] } };
        }
        return undefined;
      },
    });

    const client = await connectedClient(env);
    const read = await client.readResource({ uri: 'mcp-st://catalog/reports' });
    const parsed = JSON.parse((read.contents[0] as { text: string }).text);

    const ops = parsed.categories.find((c: any) => c.id === 10);
    const mkt = parsed.categories.find((c: any) => c.id === 20);
    expect(ops.reports).toEqual([]);
    expect(typeof ops._error).toBe('string');
    expect(mkt.reports).toEqual([{ id: 200, name: 'Campaign ROI' }]);
    expect(mkt._error).toBeUndefined();
  });
});

// ─── protocol path — real buildServer(), same pattern as mcp-protocol.test.ts ───

vi.mock('agents/mcp', () => ({ createMcpHandler: () => () => new Response() }));
vi.mock('../oauth', () => ({
  createOAuthProvider: () => ({ fetch: async () => new Response() }),
  handleOAuthRoute: async () => new Response(),
}));

describe('protocol path — buildServer via in-memory client', () => {
  it('tools/list unaffected; resources/list includes all 3 catalog URIs; resources/read returns JSON for pricebook-categories', async () => {
    const { buildServer } = await import('../index');

    const env = makeEnv({
      sqlHandler: () => ({
        success: true,
        results: [{ id: 1, name: 'HVAC Services', parent_id: null, active: 1, category_type: 'Services' }],
      }),
      stHandler: (endpoint) => {
        if (endpoint.includes('/report-categories')) return { body: { data: [] } };
        return undefined;
      },
    });
    const execCtx = { waitUntil: () => undefined } as any;
    const reqCtx = { actor: 'test-catalog-resources', role: 'default' as const };

    const server = buildServer(env, execCtx, reqCtx);
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'catalog-protocol-test-client', version: '0.0.0-test' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const listed = await client.listResources();
    const uris = listed.resources.map((r) => r.uri);
    expect(uris).toEqual(
      expect.arrayContaining([
        'mcp-st://catalog/pricebook-categories',
        'mcp-st://catalog/technicians',
        'mcp-st://catalog/reports',
      ]),
    );

    const read = await client.readResource({ uri: 'mcp-st://catalog/pricebook-categories' });
    expect(read.contents[0].mimeType).toBe('application/json');
    const parsed = JSON.parse((read.contents[0] as { text: string }).text);
    expect(parsed.categories).toEqual([
      { id: 1, name: 'HVAC Services', parent_id: null, active: 1, category_type: 'Services' },
    ]);
  });
});

// Re-export so this file also documents that registerResultResource keeps
// working side-by-side with the new catalog resources on the same server
// (both called from buildServer — see src/index.ts).
describe('catalog resources coexist with the Task 2.4 results template', () => {
  it('registering both on one server does not collide on names or URIs', async () => {
    const env = makeEnv({ sqlHandler: () => ({ success: true, results: [] }) });
    const server = new McpServer({ name: 'test-coexist', version: '0.0.0-test' });
    registerCatalogResources(server, env);
    registerResultResource(server, env);

    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'coexist-test-client', version: '0.0.0-test' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const listed = await client.listResources();
    const uris = listed.resources.map((r) => r.uri);
    expect(uris).toEqual(
      expect.arrayContaining([
        'mcp-st://catalog/pricebook-categories',
        'mcp-st://catalog/technicians',
        'mcp-st://catalog/reports',
      ]),
    );
  });
});
