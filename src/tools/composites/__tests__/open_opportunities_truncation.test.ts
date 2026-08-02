// ============================================================
// open_opportunities_pulitzer_feed — totals computed over a silent cap
// (QUA-1109).
//
// The handler applied `LIMIT ?` (default 100) and then built `summary` by
// reducing over the ROWS IT GOT BACK. So with more than 100 open opportunities
// the caller received:
//
//   * summary.count = 100, indistinguishable from "there are exactly 100";
//   * total_estimate_amount / total_sold_amount summed over the first 100 rows
//     only, presented as cohort totals with no hint they were partial.
//
// A dollar figure that is quietly the sum of an arbitrary 100-row slice is
// worse than no figure — it is wrong in a way that looks right, and this feed
// exists to be read as a cohort summary.
//
// The fix computes the aggregate over the FULL filtered cohort in SQL and
// discloses truncation, so `summary.count` can exceed the number of rows
// returned. That inequality is the gate the audit asked for.
// ============================================================
import { describe, it, expect, vi, beforeEach } from 'vitest';

const readD1 = vi.fn();
vi.mock('../../../d1', () => ({ readD1: (...a: unknown[]) => readD1(...a) }));

import { open_opportunities_pulitzer_feed } from '../open_opportunities_pulitzer_feed';

const CTX = { actor: 'vitest', correlation: 'test-corr' };
const env: any = {};

function row(id: number, estimate: number, sold: number) {
  return {
    opportunity_id: id,
    job_id: id,
    customer_name: `Cust ${id}`,
    estimate_amount: estimate,
    sold_estimate_amount: sold,
    technicians_json: '[]',
    follow_up_date: '2026-07-01',
  };
}

/**
 * The handler issues an aggregate query and a rows query. Route by SQL shape
 * rather than call order so the test does not encode which runs first.
 */
function wire(totalRows: number, returned: number, sumEstimate: number, sumSold: number) {
  readD1.mockImplementation(async (_env: unknown, sql: string) => {
    if (/count\(/i.test(sql)) {
      return { rows: [{ cohort_count: totalRows, cohort_estimate_amount: sumEstimate, cohort_sold_amount: sumSold }] };
    }
    return { rows: Array.from({ length: returned }, (_, i) => row(i + 1, 10, 5)) };
  });
}

beforeEach(() => readD1.mockReset());

describe('open_opportunities_pulitzer_feed truncation (QUA-1109)', () => {
  it('discloses truncation when the cohort exceeds the row cap', async () => {
    wire(347, 100, 51_000, 12_500);

    const out: any = await open_opportunities_pulitzer_feed.handler(env, {}, CTX);

    expect(out.opportunities).toHaveLength(100);
    expect(out._truncated).toBe(true);
    // The gate: a count that exceeds the rows actually returned.
    expect(out.summary.count).toBe(347);
    expect(out.summary.count).toBeGreaterThan(out.opportunities.length);
    expect(out.summary.returned).toBe(100);
  });

  it('totals reflect the whole cohort, not the returned slice', async () => {
    wire(347, 100, 51_000, 12_500);

    const out: any = await open_opportunities_pulitzer_feed.handler(env, {}, CTX);

    // Reducing the 100 returned rows would give 1_000 / 500. The cohort totals
    // must come from SQL over all 347.
    expect(out.summary.total_estimate_amount).toBe(51_000);
    expect(out.summary.total_sold_amount).toBe(12_500);
  });

  it('does not claim truncation when the cohort fits', async () => {
    wire(12, 12, 640, 100);

    const out: any = await open_opportunities_pulitzer_feed.handler(env, {}, CTX);

    expect(out.opportunities).toHaveLength(12);
    expect(out._truncated).toBe(false);
    expect(out.summary.count).toBe(12);
    expect(out.summary.returned).toBe(12);
  });

  it('handles an empty cohort without inventing a total', async () => {
    wire(0, 0, 0, 0);

    const out: any = await open_opportunities_pulitzer_feed.handler(env, {}, CTX);

    expect(out.opportunities).toEqual([]);
    expect(out.summary.count).toBe(0);
    expect(out._truncated).toBe(false);
  });

  it('applies the same filters to the aggregate as to the rows', async () => {
    // A cohort count computed without the caller's filters would be a
    // different, larger cohort — the totals would not describe what was
    // returned. Assert both queries carry the same bound parameters.
    const seen: Array<{ sql: string; params: unknown[] }> = [];
    readD1.mockImplementation(async (_e: unknown, sql: string, params: unknown[]) => {
      seen.push({ sql, params });
      if (/count\(/i.test(sql)) {
        return { rows: [{ cohort_count: 5, cohort_estimate_amount: 1, cohort_sold_amount: 1 }] };
      }
      return { rows: [] };
    });

    await open_opportunities_pulitzer_feed.handler(
      env, { businessUnit: 'HVAC Service Residential', jobTypeName: 'Service Call' }, CTX,
    );

    expect(seen).toHaveLength(2);
    const agg = seen.find((q) => /count\(/i.test(q.sql))!;
    const rows = seen.find((q) => !/count\(/i.test(q.sql))!;
    expect(agg.params).toContain('HVAC Service Residential');
    expect(agg.params).toContain('Service Call');
    // The rows query additionally binds the limit; the filter prefix must match.
    expect(rows.params.slice(0, agg.params.length)).toEqual(agg.params);
  });
});
