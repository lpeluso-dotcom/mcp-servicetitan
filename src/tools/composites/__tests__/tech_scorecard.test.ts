import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tech_scorecard } from '../tech_scorecard';
import * as d1 from '../../../d1';

const ctx = { actor: 'test', correlation: 'c1' } as any;

beforeEach(() => {
  // vi.spyOn on the same method across `it` blocks returns the same spy with
  // accumulated call history (no mockReset config in vitest.config.ts) — restore
  // so each test's spy.mock.calls[0] reflects only its own handler call.
  vi.restoreAllMocks();
});

describe('tech_scorecard', () => {
  it('rolls up per-tech jobs, drive/work minutes and labor burden for the week (all techs)', async () => {
    vi.spyOn(d1, 'readD1').mockResolvedValue({
      rows: [
        { technician_id: 1, name: 'Alice', business_unit: 'HVAC', jobs: 8, drive_minutes: 240, working_minutes: 1800 },
        { technician_id: 2, name: 'Bob', business_unit: 'Plumb', jobs: 5, drive_minutes: 300, working_minutes: 900 },
      ],
    } as any);
    const out: any = await tech_scorecard.handler({} as any, { weekStart: '2026-07-06', weekEnd: '2026-07-12' }, ctx);
    expect(out.techs).toHaveLength(2);
    // Alice: 240 drive of 2040 total = 11.8% ; burden (2040/60)*45 = 1530
    expect(out.techs[0]).toMatchObject({ technician_id: 1, jobs: 8, drive_pct: 11.8, labor_burden_$: 1530 });
    expect(out._source).toBe('d1');
  });

  it('filters to one technician when technicianId is given', async () => {
    const spy = vi.spyOn(d1, 'readD1').mockResolvedValue({ rows: [] } as any);
    await tech_scorecard.handler({} as any, { technicianId: 7, weekStart: '2026-07-06', weekEnd: '2026-07-12' }, ctx);
    const sql = String(spy.mock.calls[0][1]);
    expect(sql).toMatch(/technician_id\s*=\s*\?/i);
    expect(spy.mock.calls[0][2]).toContain(7);
  });
});
