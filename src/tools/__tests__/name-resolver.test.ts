// ============================================================
// name-resolver.test.ts — v1.4 BU + technician name → ID resolver.
// All fixtures synthetic; resolver is tier-driven (exact > prefix > contains)
// with read/write asymmetric ambiguity handling.
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveBusinessUnit, resolveTechnician, _clearResolverCache } from '../../name-resolver';
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
  const queryD1Resp = { rows: d1Rows, updatedAt: Date.now() };
  return {
    ST_PROXY: {
      fetch: vi.fn(async () => new Response(JSON.stringify(queryD1Resp), { status: 200 })),
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

  it('memoizes the index and only hits D1 once for repeated lookups', async () => {
    const env = makeEnv(BU_ROWS);
    await resolveBusinessUnit(env, 'install', 'read');
    await resolveBusinessUnit(env, 'maintenance', 'read');
    await resolveBusinessUnit(env, 'service plumbing', 'read');
    expect(env.ST_PROXY.fetch).toHaveBeenCalledTimes(1);
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
    expect(env.ST_PROXY.fetch).toHaveBeenCalledTimes(1);
  });
});
