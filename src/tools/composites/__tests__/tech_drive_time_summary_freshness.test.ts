// ============================================================
// tech_drive_time_summary — freshness disclosure (MB-1 / QUA-1141)
//
// Reads the same frozen `job_timesheets` mirror that made tech_scorecard
// lie: with the sync frozen since 2026-07-01, a recent-window query returns
// zero-filled day rollups that read as "this tech barely worked". The per-day
// WITH + GROUP BY aggregates synced_at away, so the rollup must carry
// MAX(synced_at) (tech_scorecard's treatment) for the stamp to see row age.
// ============================================================
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tech_drive_time_summary } from '../tech_drive_time_summary';
import * as d1 from '../../../d1';

const ctx = { actor: 'test', correlation: 'c1' } as any;
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

const ARGS = { technicianId: 75766687, startDate: '2026-07-01', endDate: '2026-07-27' };

/** Route the two readD1 calls: technicians lookup vs the per-day rollup. */
function primeMirror(dayRows: Array<Record<string, unknown>>) {
  return vi.spyOn(d1, 'readD1').mockImplementation(async (_env: any, sql: any) => {
    if (/\bfrom\s+technicians\b/i.test(String(sql))) {
      return { rows: [{ technician_id: 75766687, name: 'Brooks Hunsucker', business_unit: 'PSR' }] } as any;
    }
    return { rows: dayRows } as any;
  });
}

const day = (d: string, synced_at: string | null) => ({
  day: d, jobs: 2, drive_minutes: 30, working_minutes: 200, first_call_drive_minutes: 15, synced_at,
});

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('tech_drive_time_summary freshness disclosure (MB-1 / QUA-1141)', () => {
  it('the rollup SELECT carries MAX(synced_at) — GROUP BY would otherwise hide row age', async () => {
    const spy = primeMirror([]);
    await tech_drive_time_summary.handler({} as any, ARGS, ctx);
    const rollupSql = spy.mock.calls.map((c) => String(c[1])).find((s) => /group by day/i.test(s));
    expect(rollupSql, 'never issued the per-day rollup query').toBeDefined();
    expect(rollupSql!).toMatch(/MAX\(synced_at\)/i);
  });

  it('does NOT present a zero-filled window as authoritative when the mirror returns no rows', async () => {
    primeMirror([]);
    const out: any = await tech_drive_time_summary.handler({} as any, ARGS, ctx);
    expect(out.totals.total_drive_minutes).toBe(0);
    expect(out.metrics_are_authoritative).toBe(false);
    expect(out._freshness).toBe('unknown');
    expect(out._empty).toBe(true);
    expect(out._warning).toMatch(/not proof/i);
  });

  it('marks a fresh mirror authoritative', async () => {
    primeMirror([day('2026-07-20', hoursAgo(2))]);
    const out: any = await tech_drive_time_summary.handler({} as any, ARGS, ctx);
    expect(out._freshness).toBe('fresh');
    expect(out.metrics_are_authoritative).toBe(true);
    expect(out._mirror_table).toBe('job_timesheets');
    expect(out._warning).toBeUndefined();
  });

  it('flags the frozen-mirror failure mode (rows present, weeks old) as stale', async () => {
    primeMirror([day('2026-07-01', hoursAgo(24 * 30))]);
    const out: any = await tech_drive_time_summary.handler({} as any, ARGS, ctx);
    expect(out._freshness).toBe('stale');
    expect(out.metrics_are_authoritative).toBe(false);
    expect(out._warning).toMatch(/STALE DATA/);
    expect(out._stale_hours).toBeGreaterThan(48);
  });

  it('keeps synced_at out of the emitted by_day rows (stamp-only plumbing)', async () => {
    primeMirror([day('2026-07-20', hoursAgo(2))]);
    const out: any = await tech_drive_time_summary.handler({} as any, ARGS, ctx);
    expect(out.by_day[0].day).toBe('2026-07-20');
    expect(out.by_day[0].synced_at).toBeUndefined();
  });
});
