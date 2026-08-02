// ============================================================
// MB-1 / QUA-1141 — mirror freshness disclosure.
//
// The audit's #1 finding: read-router.ts implements staleness checking,
// live fallback and _stale_days disclosure, and has ZERO non-test importers.
// Every mirror-reading tool calls readD1/queryD1 raw, so a frozen or empty
// mirror is served as current truth. Live consequences today:
//   - `opportunities` mirror empty  -> open_opportunities_pulitzer_feed
//     reports `count: 0` and Pulitzer's daily report says "clean board"
//   - `job_timesheets` frozen 07-01 -> tech scorecards silently zero-filled
//
// Note the constraint the payroll tool already documents in-repo: D1 does
// NOT expose sync_metadata to the proxy, so freshness must come from each
// row's own synced_at column. That makes "no synced_at in the SELECT" a
// first-class case, not an edge case — it is exactly why the Pulitzer feed
// cannot self-report staleness today.
// ============================================================

import { describe, it, expect } from 'vitest';
import { stampMirrorFreshness, STALE_THRESHOLD_HOURS } from '../mirror-freshness';

const NOW = Date.parse('2026-08-01T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

describe('stampMirrorFreshness — fresh data', () => {
  it('reports fresh and computes age from the NEWEST row', () => {
    const s = stampMirrorFreshness(
      [{ synced_at: hoursAgo(10) }, { synced_at: hoursAgo(2) }, { synced_at: hoursAgo(30) }],
      { table: 'opportunities', now: NOW }
    );
    expect(s._freshness).toBe('fresh');
    expect(s._stale_hours).toBe(2);
    expect(s._warning).toBeUndefined();
  });

  it('treats exactly-at-threshold as fresh, past it as stale', () => {
    const at = stampMirrorFreshness([{ synced_at: hoursAgo(STALE_THRESHOLD_HOURS) }], {
      table: 'opportunities', now: NOW,
    });
    expect(at._freshness).toBe('fresh');

    const past = stampMirrorFreshness([{ synced_at: hoursAgo(STALE_THRESHOLD_HOURS + 0.5) }], {
      table: 'opportunities', now: NOW,
    });
    expect(past._freshness).toBe('stale');
  });
});

describe('stampMirrorFreshness — stale data', () => {
  it('flags stale and names the table and the age in the warning', () => {
    const s = stampMirrorFreshness([{ synced_at: hoursAgo(24 * 31) }], {
      table: 'job_timesheets', now: NOW,
    });
    expect(s._freshness).toBe('stale');
    expect(s._stale_hours).toBe(744);
    expect(s._warning).toMatch(/job_timesheets/);
    expect(s._warning).toMatch(/744/);
  });
});

describe('stampMirrorFreshness — the empty-mirror trap (the Pulitzer bug)', () => {
  // THE headline case. An empty mirror is indistinguishable from "genuinely
  // no records" unless the tool says so out loud. This is what turned an
  // empty `opportunities` table into "clean board, count: 0".
  it('does NOT claim freshness for an empty result', () => {
    const s = stampMirrorFreshness([], { table: 'opportunities', now: NOW });
    expect(s._freshness).toBe('unknown');
    expect(s._stale_hours).toBeNull();
  });

  it('warns that zero rows is NOT proof that zero records exist', () => {
    const s = stampMirrorFreshness([], { table: 'opportunities', now: NOW });
    expect(s._warning).toBeTruthy();
    expect(s._warning).toMatch(/not proof/i);
    expect(s._warning).toMatch(/opportunities/);
  });

  it('sets _empty so a caller can branch on it without parsing prose', () => {
    expect(stampMirrorFreshness([], { table: 'opportunities', now: NOW })._empty).toBe(true);
    expect(
      stampMirrorFreshness([{ synced_at: hoursAgo(1) }], { table: 'opportunities', now: NOW })._empty
    ).toBe(false);
  });
});

describe('stampMirrorFreshness — missing synced_at is UNKNOWN, never fresh', () => {
  // The Pulitzer feed's actual defect: its SELECT omits synced_at entirely,
  // so it cannot self-report staleness. Silence must read as "unknown".
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

describe('stampMirrorFreshness — input tolerance', () => {
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
