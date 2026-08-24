// ============================================================
// chunk.test.ts — Wave 2 / workstream B.
//
// Two hard external limits keep showing up as production 400s / 500s in the
// composites, and each one had its own ad-hoc (or missing) guard:
//
//   * ServiceTitan `?ids=a,b,c` simple-IDs lookup. Verified live 2026-07-27/28
//     against tenant 431848990: a 200-id chunk 400s
//     (`{"errors":{"Ids":["Simple IDs lookup should n…"]}}`), a 50-id chunk
//     succeeds. list_jobs_today already chunks at 50; dispatch_override_audit
//     joined the ids unchunked and 400'd on any range with >~50 distinct jobs.
//
//   * D1 / SQLite bound-parameter ceiling (~100 variables). Building
//     `IN (?,?,…)` from a 200-row appointment page throws
//     `too many SQL variables` — the exact error dispatch_override_audit was
//     producing.
//
// These are the same shape of bug, so they get one shared, tested chunker
// rather than two more inline `for (i += N)` loops.
// ============================================================
import { describe, it, expect } from 'vitest';
import { chunk, ST_IDS_BATCH_MAX, D1_BIND_PARAM_MAX } from '../chunk';

describe('chunk()', () => {
  it('splits into batches of at most `size`, preserving order and every element', () => {
    const items = Array.from({ length: 250 }, (_, i) => i);
    const out = chunk(items, 90);
    expect(out.map((c) => c.length)).toEqual([90, 90, 70]);
    expect(out.flat()).toEqual(items);
  });

  it('returns a single batch when the input already fits', () => {
    expect(chunk([1, 2, 3], 50)).toEqual([[1, 2, 3]]);
  });

  it('returns no batches for an empty input — never a [[]] that issues an empty query', () => {
    expect(chunk([], 50)).toEqual([]);
  });

  it('refuses a non-positive size rather than looping forever', () => {
    expect(() => chunk([1], 0)).toThrow(/positive/i);
    expect(() => chunk([1], -5)).toThrow(/positive/i);
  });
});

describe('ST simple-IDs batch limit', () => {
  it('is 50 — the live-verified safe batch size', () => {
    expect(ST_IDS_BATCH_MAX).toBe(50);
  });

  it('splits a 200-id request into batches ServiceTitan will accept', () => {
    const ids = Array.from({ length: 200 }, (_, i) => 1000 + i);
    const batches = chunk(ids, ST_IDS_BATCH_MAX);
    expect(batches).toHaveLength(4);
    for (const b of batches) expect(b.length).toBeLessThanOrEqual(50);
    // `ids=` is a comma-join, so the reassembled set must equal the input.
    expect(batches.flatMap((b) => b)).toEqual(ids);
  });
});

describe('D1 bind-parameter limit', () => {
  it('stays under the ~100 SQLite variable ceiling', () => {
    expect(D1_BIND_PARAM_MAX).toBeLessThanOrEqual(100);
    expect(D1_BIND_PARAM_MAX).toBeGreaterThan(0);
  });

  it('splits a 200-row IN (…) into statements that bind <= 100 variables', () => {
    const apptIds = Array.from({ length: 200 }, (_, i) => i + 1);
    const batches = chunk(apptIds, D1_BIND_PARAM_MAX);
    for (const b of batches) {
      const placeholders = b.map(() => '?').join(',');
      expect(placeholders.split(',').length).toBe(b.length);
      expect(b.length).toBeLessThanOrEqual(100);
    }
    expect(batches.flat()).toEqual(apptIds);
  });
});
