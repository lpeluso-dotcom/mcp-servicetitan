// ============================================================
// MB-1 / QUA-1141 — mirror freshness disclosure.
//
// v2 (adversarial-review redesign, findings F1/F2/F5):
//
// F1 — mirrors are INCREMENTALLY synced: unchanged rows keep their original
//   synced_at forever (prod: 5 of 43,093 pb_services rows synced <48h), so
//   deriving staleness from the newest RETURNED row's synced_at called
//   healthy mirrors STALE on most real calls. The fix: freshness comes from
//   the TABLE-level MAX(synced_at) (opts.tableMax, fetched via
//   fetchTableMax's one UNION ALL probe). Row-level age alone can still
//   PROVE freshness (a recently-synced row is proof the sync ran) but can
//   never prove staleness — degraded mode says 'unknown', never 'stale'.
//
// F2 — multi-table stamps used the global MAX across independently-synced
//   tables, so one fresh pb_services row hid a week-frozen pb_equipment.
//   The fix: per-table verdicts in `_tables`, worst-table headline.
//
// F5 — a miss on a provably-alive table used to warn "mirror may be empty
//   or sync failed". With a fresh table MAX, zero rows is a REAL zero as of
//   the last sync: `_empty: true`, freshness 'fresh', no scary warning.
// ============================================================

import { describe, it, expect, vi } from 'vitest';
import { stampMirrorFreshness, fetchTableMax, STALE_THRESHOLD_HOURS } from '../mirror-freshness';

const NOW = Date.parse('2026-08-01T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

// ────────────────────────────────────────────────────────────────────
// TABLE-LEVEL MODE (tableMax provided) — the primary path post-redesign
// ────────────────────────────────────────────────────────────────────

describe('stampMirrorFreshness — tableMax mode: per-table verdicts', () => {
  it('all tables fresh → headline fresh, per-table map present', () => {
    const s = stampMirrorFreshness([{ id: 1 }], {
      table: 'pb_services+pb_materials',
      now: NOW,
      tableMax: { pb_services: hoursAgo(3), pb_materials: hoursAgo(10) },
    });
    expect(s._freshness).toBe('fresh');
    expect(s._warning).toBeUndefined();
    expect(s._tables).toEqual({
      pb_services: { stale_hours: 3, freshness: 'fresh' },
      pb_materials: { stale_hours: 10, freshness: 'fresh' },
    });
    // Worst (oldest) table's age headlines _stale_hours.
    expect(s._stale_hours).toBe(10);
    expect(s._mirror_table).toBe('pb_services+pb_materials');
  });

  // Pinned behavior (a): the F2 fix. Prod MAXes on 2026-08-02: pb_equipment
  // 04:28 vs pb_services 13:21 — a frozen table must never hide behind a
  // fresh sibling.
  it('one frozen table of three → headline unknown (quiet-or-frozen), warning NAMES the table', () => {
    const s = stampMirrorFreshness([{ id: 1 }], {
      table: 'pb_services+pb_materials+pb_equipment',
      now: NOW,
      tableMax: {
        pb_services: hoursAgo(2),
        pb_materials: hoursAgo(5),
        pb_equipment: hoursAgo(24 * 7), // frozen a week
      },
    });
    expect(s._freshness).toBe('unknown');
    expect(s._warning).toMatch(/no row change in|indistinguishable/);
    expect(s._warning).toMatch(/pb_equipment/);
    // The fresh siblings are NOT blamed in the stale warning.
    expect(s._warning).not.toMatch(/`pb_services`.*threshold/);
    expect(s._stale_hours).toBe(168);
    expect(s._tables!.pb_equipment.freshness).toBe('unknown');
    expect(s._tables!.pb_services.freshness).toBe('fresh');
  });

  // Pinned behavior (b): an empty table has MAX(synced_at) = NULL — it
  // cannot prove its sync is alive (this is the production `opportunities`
  // empty-mirror case under the new design).
  it('empty table (MAX null) → unknown, warning names the table that cannot prove liveness', () => {
    const s = stampMirrorFreshness([], {
      table: 'opportunities',
      now: NOW,
      tableMax: { opportunities: null },
    });
    expect(s._freshness).toBe('unknown');
    expect(s._stale_hours).toBeNull();
    expect(s._empty).toBe(true);
    expect(s._tables).toEqual({ opportunities: { stale_hours: null, freshness: 'unknown' } });
    expect(s._warning).toMatch(/opportunities/);
    expect(s._warning).toMatch(/not proof/i);
  });

  it('unparseable table MAX → that table unknown', () => {
    const s = stampMirrorFreshness([{ id: 1 }], {
      table: 'a+b',
      now: NOW,
      tableMax: { a: hoursAgo(1), b: 'garbage' },
    });
    expect(s._tables!.a.freshness).toBe('fresh');
    expect(s._tables!.b.freshness).toBe('unknown');
    expect(s._freshness).toBe('unknown');
    // Worst observed age is factual and reported even under an 'unknown'
    // headline (only ever null when NO table produced a timestamp).
    expect(s._stale_hours).toBe(1);
    expect(s._warning).toMatch(/`b`/);
  });

  it('a quiet-or-frozen table forces the headline to unknown', () => {
    const s = stampMirrorFreshness([{ id: 1 }], {
      table: 'a+b',
      now: NOW,
      tableMax: { a: hoursAgo(24 * 10), b: null },
    });
    expect(s._freshness).toBe('unknown');
    expect(s._warning).toMatch(/no row change in|indistinguishable/);
    // The unknown table is still called out.
    expect(s._warning).toMatch(/`b`/);
    expect(s._stale_hours).toBe(240);
  });

  // Pinned behavior (c): the F5 fix — honest empty semantics. A live mirror
  // returning zero matching rows is a REAL zero as of the last sync.
  it('zero matching rows on a live (fresh) table → fresh, _empty true, NO warning', () => {
    const s = stampMirrorFreshness([], {
      table: 'technicians',
      now: NOW,
      tableMax: { technicians: hoursAgo(4) },
    });
    expect(s._freshness).toBe('fresh');
    expect(s._empty).toBe(true);
    expect(s._warning).toBeUndefined();
    expect(s._stale_hours).toBe(4);
  });

  it('accepts epoch-millis table MAX values', () => {
    const s = stampMirrorFreshness([], {
      table: 'technicians',
      now: NOW,
      tableMax: { technicians: NOW - 6 * 3_600_000 },
    });
    expect(s._freshness).toBe('fresh');
    expect(s._tables!.technicians.stale_hours).toBe(6);
  });

  // F1 core scenario under the new design: returned rows are OLD (incremental
  // sync — unchanged rows keep old synced_at) but the table MAX is fresh. The
  // old design cried STALE here on most real calls; the new one must not.
  it('old returned rows + fresh table MAX → fresh (rows do not vote when the table can)', () => {
    const s = stampMirrorFreshness(
      [{ synced_at: hoursAgo(24 * 90) }, { synced_at: hoursAgo(24 * 30) }],
      { table: 'pb_services', now: NOW, tableMax: { pb_services: hoursAgo(2) } },
    );
    expect(s._freshness).toBe('fresh');
    expect(s._warning).toBeUndefined();
    expect(s._stale_hours).toBe(2);
  });

  it('exactly-at-threshold table MAX is fresh, past it is unknown (quiet-or-frozen)', () => {
    const at = stampMirrorFreshness([], {
      table: 't', now: NOW, tableMax: { t: hoursAgo(STALE_THRESHOLD_HOURS) },
    });
    expect(at._freshness).toBe('fresh');
    const past = stampMirrorFreshness([], {
      table: 't', now: NOW, tableMax: { t: hoursAgo(STALE_THRESHOLD_HOURS + 0.5) },
    });
    expect(past._freshness).toBe('unknown');
  });

  it('an empty tableMax object degrades to row-level mode (fetchTableMax failure contract)', () => {
    const s = stampMirrorFreshness([{ synced_at: hoursAgo(2) }], {
      table: 'technicians', now: NOW, tableMax: {},
    });
    // Degraded mode — no _tables map, row-level proof still allowed.
    expect(s._tables).toBeUndefined();
    expect(s._freshness).toBe('fresh');
  });
});

// ────────────────────────────────────────────────────────────────────
// DEGRADED MODE (no tableMax) — back-compat path for adopters that
// missed the probe. Row age can PROVE freshness, never staleness (F1).
// ────────────────────────────────────────────────────────────────────

describe('stampMirrorFreshness — degraded mode: fresh rows still prove freshness', () => {
  it('reports fresh and computes age from the NEWEST row', () => {
    const s = stampMirrorFreshness(
      [{ synced_at: hoursAgo(10) }, { synced_at: hoursAgo(2) }, { synced_at: hoursAgo(30) }],
      { table: 'opportunities', now: NOW }
    );
    expect(s._freshness).toBe('fresh');
    expect(s._stale_hours).toBe(2);
    expect(s._warning).toBeUndefined();
    expect(s._tables).toBeUndefined();
  });

  it('accepts epoch-millis numbers as well as ISO strings', () => {
    const s = stampMirrorFreshness([{ synced_at: NOW - 3 * 3_600_000 }], {
      table: 'opportunities', now: NOW,
    });
    expect(s._stale_hours).toBe(3);
    expect(s._freshness).toBe('fresh');
  });

  it('honours a custom syncedAtField', () => {
    const s = stampMirrorFreshness([{ last_sync: hoursAgo(4) }], {
      table: 'dispatch_pro_alerts', syncedAtField: 'last_sync', now: NOW,
    });
    expect(s._stale_hours).toBe(4);
  });

  it('clamps clock skew to 0 rather than reporting negative age', () => {
    const s = stampMirrorFreshness([{ synced_at: new Date(NOW + 60_000).toISOString() }], {
      table: 'opportunities', now: NOW,
    });
    expect(s._stale_hours).toBe(0);
    expect(s._freshness).toBe('fresh');
  });

  it('always names the table it is describing', () => {
    expect(stampMirrorFreshness([], { table: 'estimates', now: NOW })._mirror_table).toBe('estimates');
  });
});

// Pinned behavior (d): the F1 fix in degraded mode. Old rows are how an
// incrementally-synced mirror looks on a NORMAL day — row-level age cannot
// distinguish old-but-final data from a frozen sync, so it must never
// yield 'stale' (crying wolf teaches callers to ignore the stamp).
describe('stampMirrorFreshness — degraded mode: old rows are UNKNOWN, never stale', () => {
  it('an old newest-row yields unknown — NEVER stale', () => {
    const s = stampMirrorFreshness([{ synced_at: hoursAgo(24 * 31) }], {
      table: 'job_timesheets', now: NOW,
    });
    expect(s._freshness).toBe('unknown');
    expect(s._freshness).not.toBe('stale');
    expect(s._warning).toMatch(/job_timesheets/);
    expect(s._warning).toMatch(/cannot distinguish/i);
    // The observed row age is still reported as information.
    expect(s._stale_hours).toBe(744);
  });

  it('exactly-at-threshold is fresh; past it degrades to unknown (not stale)', () => {
    const at = stampMirrorFreshness([{ synced_at: hoursAgo(STALE_THRESHOLD_HOURS) }], {
      table: 'opportunities', now: NOW,
    });
    expect(at._freshness).toBe('fresh');

    const past = stampMirrorFreshness([{ synced_at: hoursAgo(STALE_THRESHOLD_HOURS + 0.5) }], {
      table: 'opportunities', now: NOW,
    });
    expect(past._freshness).toBe('unknown');
  });
});

describe('stampMirrorFreshness — degraded mode: empty and unprovable inputs stay unknown', () => {
  it('does NOT claim freshness for an empty result', () => {
    const s = stampMirrorFreshness([], { table: 'opportunities', now: NOW });
    expect(s._freshness).toBe('unknown');
    expect(s._stale_hours).toBeNull();
    expect(s._empty).toBe(true);
    expect(s._warning).toMatch(/not proof/i);
    expect(s._warning).toMatch(/opportunities/);
  });

  it('sets _empty so a caller can branch on it without parsing prose', () => {
    expect(stampMirrorFreshness([], { table: 'opportunities', now: NOW })._empty).toBe(true);
    expect(
      stampMirrorFreshness([{ synced_at: hoursAgo(1) }], { table: 'opportunities', now: NOW })._empty
    ).toBe(false);
  });

  it('returns unknown when rows carry no synced_at column', () => {
    const s = stampMirrorFreshness([{ opportunity_id: 1 }, { opportunity_id: 2 }], {
      table: 'opportunities', now: NOW,
    });
    expect(s._freshness).toBe('unknown');
    expect(s._stale_hours).toBeNull();
    expect(s._empty).toBe(false);
    expect(s._warning).toMatch(/synced_at/);
  });

  it('returns unknown when every synced_at is null or unparseable junk', () => {
    const s = stampMirrorFreshness(
      [{ synced_at: null }, { synced_at: '' }, { synced_at: 'not-a-date' }],
      { table: 'opportunities', now: NOW }
    );
    expect(s._freshness).toBe('unknown');
    expect(s._stale_hours).toBeNull();
  });

  it('uses the max of the PARSEABLE values when some rows are junk', () => {
    const s = stampMirrorFreshness(
      [{ synced_at: 'garbage' }, { synced_at: hoursAgo(5) }, { synced_at: null }],
      { table: 'opportunities', now: NOW }
    );
    expect(s._freshness).toBe('fresh');
    expect(s._stale_hours).toBe(5);
  });
});

// ────────────────────────────────────────────────────────────────────
// fetchTableMax — the one-query table-level probe
// ────────────────────────────────────────────────────────────────────

describe('fetchTableMax', () => {
  function envCapturing(results: unknown, status = 200) {
    const bodies: Array<{ sql: string; params: unknown[] }> = [];
    const fetcher = vi.fn(async (_url: any, init?: RequestInit) => {
      bodies.push(init?.body ? JSON.parse(init.body as string) : {});
      if (status !== 200) return new Response('boom', { status });
      return new Response(JSON.stringify({ success: true, results }), { status: 200 });
    });
    return { env: { ST_PROXY: { fetch: fetcher }, MCP_SYNC_KEY: 'k' } as any, bodies };
  }

  it('issues ONE UNION ALL query naming each table and returns the per-table MAX map', async () => {
    const { env, bodies } = envCapturing([
      { t: 'pb_services', m: '2026-08-01T10:00:00Z' },
      { t: 'pb_equipment', m: null },
    ]);
    const out = await fetchTableMax(env, ['pb_services', 'pb_equipment']);
    expect(bodies).toHaveLength(1);
    expect(bodies[0].sql).toMatch(/SELECT 'pb_services' AS t, MAX\(synced_at\) AS m FROM pb_services/);
    expect(bodies[0].sql).toMatch(/UNION ALL/);
    expect(bodies[0].sql).toMatch(/SELECT 'pb_equipment' AS t, MAX\(synced_at\) AS m FROM pb_equipment/);
    expect(out).toEqual({ pb_services: '2026-08-01T10:00:00Z', pb_equipment: null });
  });

  // Pinned behavior (e): a failed probe must degrade, never throw — losing
  // the probe should cost precision, not availability.
  it('returns {} on query failure and never throws', async () => {
    const { env } = envCapturing(null, 500);
    await expect(fetchTableMax(env, ['pb_services'])).resolves.toEqual({});
  });

  it('returns {} (degrade) when any table name fails the /^[a-z_]+$/ assertion', async () => {
    const { env, bodies } = envCapturing([]);
    await expect(fetchTableMax(env, ['pb_services', 'pb_services; DROP TABLE x'])).resolves.toEqual({});
    // The tainted query must never have been sent.
    expect(bodies).toHaveLength(0);
  });

  it('returns {} for an empty table list without querying', async () => {
    const { env, bodies } = envCapturing([]);
    await expect(fetchTableMax(env, [])).resolves.toEqual({});
    expect(bodies).toHaveLength(0);
  });

  it('a table missing from the result rows maps to null (reads as unknown downstream)', async () => {
    const { env } = envCapturing([{ t: 'a', m: '2026-08-01T00:00:00Z' }]);
    const out = await fetchTableMax(env, ['a', 'b']);
    expect(out).toEqual({ a: '2026-08-01T00:00:00Z', b: null });
  });
});
