// ============================================================
// name-resolver.test.ts — v1.4 BU + technician name → ID resolver.
// All fixtures synthetic; resolver is tier-driven (exact > prefix > contains)
// with read/write asymmetric ambiguity handling.
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  resolveBusinessUnit,
  resolveTechnician,
  _clearResolverCache,
  RESOLVER_INDEX_TTL_MS,
} from '../../name-resolver';
import { McpError } from '../../errors';

const BU_ROWS = [
  { id: 1, name: 'Service' },
  { id: 2, name: 'Service Plumbing' },
  { id: 3, name: 'Install' },
  { id: 4, name: 'Maintenance Service' },
];

const TECH_ROWS = [
  { id: 100, name: 'Tech A' },
  { id: 101, name: 'Tech B' },
  { id: 102, name: 'Tech Alpha' },
];

function makeEnv(d1Rows: { id: number; name: string }[], cacheStore = new Map<string, string>()): any {
  // name-resolver now reads via readD1 (src/d1.ts → servicetitan-proxy /api/sql/read),
  // whose success shape is { success: true, results: Row[] } — not the dead
  // /internal/query-d1 { rows, updatedAt } contract.
  const readD1Resp = { success: true, results: d1Rows };
  return {
    ST_PROXY: {
      fetch: vi.fn(async () => new Response(JSON.stringify(readD1Resp), { status: 200 })),
    },
    DB: {
      prepare: vi.fn().mockImplementation((sql: string) => ({
        bind: vi.fn().mockReturnThis(),
        first: vi.fn().mockImplementation(async () => {
          if (/SELECT value, expires_at FROM mcp_cache/i.test(sql)) {
            for (const [, v] of cacheStore) return JSON.parse(v) as { value: string; expires_at: number };
            return null;
          }
          return null;
        }),
        run: vi.fn().mockImplementation(async () => {
          // capture INSERT OR REPLACE
          return { success: true };
        }),
        all: vi.fn().mockResolvedValue({ results: [] }),
      })),
    },
    MCP_SYNC_KEY: 'test',
    MCP_SERVICE_VERSION: '0.0.0-test',
  };
}

beforeEach(() => {
  _clearResolverCache();
});

describe('resolveBusinessUnit', () => {
  it('passes through numeric input without D1 hit', async () => {
    const env = makeEnv([]);
    const out = await resolveBusinessUnit(env, 7, 'read');
    expect(out).toEqual({ id: 7, resolved: 'numeric', ambiguous: false });
    expect(env.ST_PROXY.fetch).not.toHaveBeenCalled();
  });

  it('passes through stringified-numeric input without D1 hit', async () => {
    const env = makeEnv([]);
    const out = await resolveBusinessUnit(env, '42', 'read');
    expect(out).toEqual({ id: 42, resolved: 'numeric', ambiguous: false });
    expect(env.ST_PROXY.fetch).not.toHaveBeenCalled();
  });

  it('resolves exact match (case-insensitive)', async () => {
    const env = makeEnv(BU_ROWS);
    const out = await resolveBusinessUnit(env, 'install', 'read');
    expect(out.id).toBe(3);
    expect(out.resolved).toBe('exact');
    expect(out.ambiguous).toBe(false);
  });

  it('resolves prefix match when no exact', async () => {
    const env = makeEnv([{ id: 5, name: 'Commercial Plumbing' }]);
    const out = await resolveBusinessUnit(env, 'comm', 'read');
    expect(out.id).toBe(5);
    expect(out.resolved).toBe('prefix');
  });

  it('resolves contains match when no exact or prefix', async () => {
    const env = makeEnv([{ id: 6, name: 'Northern Region Service' }]);
    const out = await resolveBusinessUnit(env, 'region', 'read');
    expect(out.id).toBe(6);
    expect(out.resolved).toBe('contains');
  });

  it('read mode: ambiguous match returns first deterministically with ambiguous=true', async () => {
    const env = makeEnv(BU_ROWS);
    // "Service" exact-matches id=1 but prefix-matches id=1, 2 — exact tier resolves uniquely.
    // Test prefix ambiguity: query "Serv" matches "Service" + "Service Plumbing" at prefix tier.
    const out = await resolveBusinessUnit(env, 'Serv', 'read');
    expect(out.ambiguous).toBe(true);
    expect(out.candidates).toBeDefined();
    expect(out.candidates!.map((c) => c.id).sort()).toEqual([1, 2]);
    // First by ascending id
    expect(out.id).toBe(1);
    expect(out.resolved).toBe('prefix');
  });

  it('write mode: ambiguous match throws validation_error', async () => {
    const env = makeEnv(BU_ROWS);
    await expect(resolveBusinessUnit(env, 'Serv', 'write')).rejects.toMatchObject({
      name: 'McpError',
      code: 'validation_error',
    });
  });

  it('throws validation_error when name is unresolved', async () => {
    const env = makeEnv(BU_ROWS);
    await expect(resolveBusinessUnit(env, 'Nonexistent', 'read')).rejects.toBeInstanceOf(McpError);
    await expect(resolveBusinessUnit(env, 'Nonexistent', 'write')).rejects.toBeInstanceOf(McpError);
  });

  it('memoizes the index: repeated lookups reuse one index load', async () => {
    const env = makeEnv(BU_ROWS);
    await resolveBusinessUnit(env, 'install', 'read');
    const afterFirst = env.ST_PROXY.fetch.mock.calls.length;
    await resolveBusinessUnit(env, 'maintenance', 'read');
    await resolveBusinessUnit(env, 'service plumbing', 'read');
    // Two D1 round trips per LOAD (the index SELECT + the fetchTableMax
    // MAX(synced_at) probe that backs the freshness stamp), and the load
    // happens once — so the count must not move across lookups 2 and 3.
    expect(env.ST_PROXY.fetch.mock.calls.length).toBe(afterFirst);
    expect(afterFirst).toBe(2);
  });
});

describe('resolveTechnician', () => {
  it('resolves exact technician name', async () => {
    const env = makeEnv(TECH_ROWS);
    const out = await resolveTechnician(env, 'Tech B', 'read');
    expect(out.id).toBe(101);
    expect(out.resolved).toBe('exact');
  });

  it('resolves prefix technician name', async () => {
    const env = makeEnv(TECH_ROWS);
    const out = await resolveTechnician(env, 'Tech Al', 'read');
    expect(out.id).toBe(102);
    expect(out.resolved).toBe('prefix');
  });

  it('write mode: ambiguous technician name throws', async () => {
    const env = makeEnv(TECH_ROWS);
    // "Tech" prefix matches all three
    await expect(resolveTechnician(env, 'Tech', 'write')).rejects.toMatchObject({
      code: 'validation_error',
    });
  });

  it('uses separate cache namespace from BU resolver', async () => {
    const env = makeEnv(TECH_ROWS);
    const out = await resolveTechnician(env, 'Tech A', 'read');
    expect(out.id).toBe(100);
    // The ST_PROXY mock returns the same payload regardless of SQL — the test just
    // confirms that resolveTechnician completes without bleeding BU state.
    // 2 calls = the index SELECT + the fetchTableMax freshness probe.
    expect(env.ST_PROXY.fetch).toHaveBeenCalledTimes(2);
  });
});

// ============================================================
// Freshness disclosure (workstream D item 2) + index TTL (item 4).
//
// name-resolver is the single highest-traffic mirror reader in the worker —
// EVERY `*Name` argument on every tool lands here — and until now it read
// `business_units` / `technicians` with a raw readD1 and disclosed nothing.
// A frozen roster mirror therefore surfaced as a confident "technicianName
// not found", which reads as "no such tech" rather than "the mirror is
// broken". That is the exact failure class src/mirror-freshness.ts exists
// to stop.
// ============================================================

/**
 * SQL-routed env: the fetchTableMax probe (`... MAX(synced_at) ...`) is
 * answered separately from the index SELECT, so a test can pin a real
 * table-level freshness verdict instead of the accidental one the
 * same-payload-for-everything mock produces.
 */
function makeRoutedEnv(
  d1Rows: { id: number; name: string }[],
  tableMaxIso: string | null,
): any {
  return {
    ST_PROXY: {
      fetch: vi.fn(async (_url: string, init?: RequestInit) => {
        const body = init?.body ? JSON.parse(init.body as string) : {};
        const sql: string = body.sql ?? '';
        if (/MAX\(synced_at\)/i.test(sql)) {
          const table = /FROM\s+(\w+)/i.exec(sql)?.[1] ?? 'unknown';
          return new Response(
            JSON.stringify({ success: true, results: [{ t: table, m: tableMaxIso }] }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ success: true, results: d1Rows }), { status: 200 });
      }),
    },
    MCP_SYNC_KEY: 'test',
    MCP_SERVICE_VERSION: '0.0.0-test',
  };
}

describe('name-resolver mirror freshness', () => {
  it('stamps a resolution with a proven-fresh verdict for its mirror table', async () => {
    const env = makeRoutedEnv(BU_ROWS, new Date(Date.now() - 3 * 3_600_000).toISOString());
    const out = await resolveBusinessUnit(env, 'install', 'read');

    expect(out.id).toBe(3);
    expect(out.mirror).toBeDefined();
    expect(out.mirror!._mirror_table).toBe('business_units');
    expect(out.mirror!._freshness).toBe('fresh');
    expect(out.mirror!._warning).toBeUndefined();
    expect(out.mirror!._tables).toMatchObject({ business_units: { freshness: 'fresh' } });
  });

  it('stamps `unknown` with a warning when the table cannot prove its sync is alive', async () => {
    const env = makeRoutedEnv(TECH_ROWS, null);
    const out = await resolveTechnician(env, 'Tech B', 'read');

    expect(out.id).toBe(101);
    expect(out.mirror!._mirror_table).toBe('technicians');
    expect(out.mirror!._freshness).toBe('unknown');
    expect(out.mirror!._warning).toMatch(/technicians/);
  });

  it('numeric pass-through carries no stamp — it never touches the mirror', async () => {
    const env = makeRoutedEnv(BU_ROWS, new Date().toISOString());
    const out = await resolveBusinessUnit(env, 7, 'read');

    expect(out).toEqual({ id: 7, resolved: 'numeric', ambiguous: false });
    expect(out.mirror).toBeUndefined();
    expect(env.ST_PROXY.fetch).not.toHaveBeenCalled();
  });

  it('a not-found throw discloses that the miss may be the mirror, not ServiceTitan', async () => {
    const env = makeRoutedEnv(TECH_ROWS, null);
    await expect(resolveTechnician(env, 'Nonexistent Person', 'read')).rejects.toMatchObject({
      code: 'validation_error',
    });
    // The message must name the mirror caveat, not just "not found".
    await expect(resolveTechnician(env, 'Nonexistent Person', 'read')).rejects.toThrow(/mirror/i);
  });

  it('a not-found throw against a PROVEN-fresh mirror stays a plain miss', async () => {
    const env = makeRoutedEnv(TECH_ROWS, new Date().toISOString());
    // No mirror hedge when the mirror is provably alive — a hedge on every
    // typo is the cry-wolf failure mode mirror-freshness.ts is built to avoid.
    let msg = '';
    try {
      await resolveTechnician(env, 'Nonexistent Person', 'read');
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/technicianName not found/);
    expect(msg).not.toMatch(/mirror/i);
  });
});

describe('name-resolver index TTL', () => {
  it('exports a TTL between 5 and 10 minutes', () => {
    expect(RESOLVER_INDEX_TTL_MS).toBeGreaterThanOrEqual(5 * 60_000);
    expect(RESOLVER_INDEX_TTL_MS).toBeLessThanOrEqual(10 * 60_000);
  });

  it('reuses the memo inside the TTL and reloads after it', async () => {
    const t0 = 1_800_000_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(t0);
    try {
      const env = makeEnv(BU_ROWS);
      await resolveBusinessUnit(env, 'install', 'read');
      const afterLoad = env.ST_PROXY.fetch.mock.calls.length;
      expect(afterLoad).toBeGreaterThan(0);

      nowSpy.mockReturnValue(t0 + RESOLVER_INDEX_TTL_MS - 1_000);
      await resolveBusinessUnit(env, 'install', 'read');
      expect(env.ST_PROXY.fetch.mock.calls.length).toBe(afterLoad);

      nowSpy.mockReturnValue(t0 + RESOLVER_INDEX_TTL_MS + 1_000);
      await resolveBusinessUnit(env, 'install', 'read');
      expect(env.ST_PROXY.fetch.mock.calls.length).toBeGreaterThan(afterLoad);
    } finally {
      nowSpy.mockRestore();
    }
  });

  // The business reason the TTL exists: KIND_CONFIG filters `WHERE active = 1`,
  // so a tech activated in ServiceTitan after the isolate warmed used to stay
  // invisible for the isolate's entire life — unbounded, because a hot isolate
  // lives far longer than the "~minutes" the old in-code rationale assumed.
  it('a newly activated technician becomes resolvable after the TTL', async () => {
    const t0 = 1_800_000_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(t0);
    try {
      let roster = [...TECH_ROWS];
      const env: any = {
        ST_PROXY: {
          fetch: vi.fn(
            async () =>
              new Response(JSON.stringify({ success: true, results: roster }), { status: 200 }),
          ),
        },
        MCP_SYNC_KEY: 'test',
        MCP_SERVICE_VERSION: '0.0.0-test',
      };

      await expect(resolveTechnician(env, 'Tech Zulu', 'read')).rejects.toBeInstanceOf(McpError);

      roster = [...TECH_ROWS, { id: 999, name: 'Tech Zulu' }];

      // Still invisible inside the TTL...
      nowSpy.mockReturnValue(t0 + 60_000);
      await expect(resolveTechnician(env, 'Tech Zulu', 'read')).rejects.toBeInstanceOf(McpError);

      // ...and visible once it expires.
      nowSpy.mockReturnValue(t0 + RESOLVER_INDEX_TTL_MS + 1_000);
      const out = await resolveTechnician(env, 'Tech Zulu', 'read');
      expect(out.id).toBe(999);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('_clearResolverCache() still forces an immediate reload', async () => {
    const env = makeEnv(BU_ROWS);
    await resolveBusinessUnit(env, 'install', 'read');
    const afterLoad = env.ST_PROXY.fetch.mock.calls.length;
    _clearResolverCache();
    await resolveBusinessUnit(env, 'install', 'read');
    expect(env.ST_PROXY.fetch.mock.calls.length).toBeGreaterThan(afterLoad);
  });

  it('a failed load is not cached — the next call retries', async () => {
    // A fresh Response per call: a Response body can only be read once, so a
    // single shared mock object would fail the SECOND read for the wrong
    // reason. Only the first index SELECT fails; the freshness probe and all
    // later reads succeed.
    let indexReads = 0;
    const env: any = {
      ST_PROXY: {
        fetch: vi.fn(async (_url: string, init?: RequestInit) => {
          const sql: string = init?.body ? JSON.parse(init.body as string).sql : '';
          if (/MAX\(synced_at\)/i.test(sql)) {
            return new Response(
              JSON.stringify({ success: true, results: [{ t: 'business_units', m: null }] }),
              { status: 200 },
            );
          }
          indexReads += 1;
          if (indexReads === 1) {
            return new Response(JSON.stringify({ success: false, error: 'boom' }), { status: 500 });
          }
          return new Response(JSON.stringify({ success: true, results: BU_ROWS }), { status: 200 });
        }),
      },
      MCP_SYNC_KEY: 'test',
      MCP_SERVICE_VERSION: '0.0.0-test',
    };
    await expect(resolveBusinessUnit(env, 'install', 'read')).rejects.toMatchObject({
      code: 'upstream_error',
    });
    const out = await resolveBusinessUnit(env, 'install', 'read');
    expect(out.id).toBe(3);
    expect(indexReads).toBe(2);
  });
});
