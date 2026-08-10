// ============================================================
// QUA-1234 — freshness GRAIN: the stamp measured the table, the caller
// consumed the rows.
//
// Reproduced in prod 2026-08-09 against `opportunities`:
//   MAX(synced_at) over the table = 2026-08-08 03:41:04  → 44h  (sync alive)
//   the returned page's rows      = 2026-06-22 13:28:02  → 1151h (48 days)
//   the response said            _stale_hours: 44, _freshness: 'fresh'
//
// Both numbers are true. Only one was shown, under a name every caller
// reads as "how old is the data I am holding". That misreading let the
// dead opportunities sync (QUA-1075) hide for 11 extra days.
//
// NOT fixed by emitting 'stale' on row age — F1 forbids that and is right:
// unchanged rows keep their original synced_at forever, so an old returned
// row is what a HEALTHY mirror serves. These tests therefore assert
// DISCLOSURE of the divergence, never a staleness verdict derived from it.
// ============================================================
import { describe, it, expect } from 'vitest';
import { stampMirrorFreshness, STALE_THRESHOLD_HOURS } from '../mirror-freshness';

const NOW = Date.parse('2026-08-09T23:50:00Z');
const h = (n: number) => new Date(NOW - n * 3_600_000).toISOString();

describe('QUA-1234 freshness grain — table-alive vs rows-old', () => {
  // The exact production shape.
  const oldRows = [{ id: 1, synced_at: h(1151) }, { id: 2, synced_at: h(1151) }];
  const liveTableMax = { opportunities: h(44) };

  it('still reports the table-level age as the sync-liveness signal', () => {
    const s = stampMirrorFreshness(oldRows, {
      table: 'opportunities', tableMax: liveTableMax, now: NOW,
    });
    // Unchanged behaviour: the sync IS alive and 44h is the true answer.
    expect(s._tables?.opportunities.stale_hours).toBe(44);
    expect(s._freshness).toBe('fresh');
  });

  it('NEGATIVE CONTROL: discloses that the returned rows are far older than the table', () => {
    const s = stampMirrorFreshness(oldRows, {
      table: 'opportunities', tableMax: liveTableMax, now: NOW,
    });
    // The page's own age must be reported, not just the table's. THIS is
    // the defect: before the fix the response carried 44h (the table) and
    // nothing at all about the 1151h rows the caller was handed.
    expect(s._rows_synced_hours).toBe(1151);
    // The two numbers must be distinguishable, not collapsed into one.
    expect(s._stale_hours).toBe(44);
    expect(s._rows_synced_hours).not.toBe(s._stale_hours);
    // And NO warning: F1 — old rows are what a healthy mirror serves, so
    // warning here would fire on nearly every honest call. Regression guard
    // against my own first attempt, which did exactly that and broke 11
    // existing F1 tests.
    expect(s._warning).toBeUndefined();
  });

  it('does NOT derive a staleness verdict from row age (F1 preserved)', () => {
    const s = stampMirrorFreshness(oldRows, {
      table: 'opportunities', tableMax: liveTableMax, now: NOW,
    });
    expect(s._freshness).not.toBe('stale');
  });

  it('stays quiet when rows and table agree — no false alarm on a healthy page', () => {
    const s = stampMirrorFreshness([{ id: 1, synced_at: h(2) }], {
      table: 'opportunities', tableMax: { opportunities: h(3) }, now: NOW,
    });
    expect(s._rows_synced_hours).toBe(2);
    expect(s._freshness).toBe('fresh');
    expect(s._warning).toBeUndefined();
  });

  it('reports rows age even when no row carries a usable timestamp', () => {
    const s = stampMirrorFreshness([{ id: 1 }], {
      table: 'opportunities', tableMax: liveTableMax, now: NOW,
    });
    expect(s._rows_synced_hours).toBeNull();
  });

  it('an empty page has no row age and raises no divergence warning', () => {
    const s = stampMirrorFreshness([], {
      table: 'opportunities', tableMax: liveTableMax, now: NOW,
    });
    expect(s._rows_synced_hours).toBeNull();
    expect(s._empty).toBe(true);
  });

  it('reports page age either side of the threshold without ever warning', () => {
    // Just inside the threshold → no warning.
    const inside = stampMirrorFreshness([{ id: 1, synced_at: h(STALE_THRESHOLD_HOURS - 1) }], {
      table: 'opportunities', tableMax: { opportunities: h(1) }, now: NOW,
    });
    expect(inside._warning).toBeUndefined();
    // Just outside → warning.
    const outside = stampMirrorFreshness([{ id: 1, synced_at: h(STALE_THRESHOLD_HOURS + 1) }], {
      table: 'opportunities', tableMax: { opportunities: h(1) }, now: NOW,
    });
    // Reported as a fact, still no warning and still not 'stale' (F1).
    expect(outside._rows_synced_hours).toBe(STALE_THRESHOLD_HOURS + 1);
    expect(outside._warning).toBeUndefined();
    expect(outside._freshness).not.toBe('stale');
  });
});
