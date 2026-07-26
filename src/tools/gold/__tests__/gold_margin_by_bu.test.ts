import { describe, it, expect, vi } from 'vitest';
import { gold_margin_by_bu } from '../gold_margin_by_bu';
import * as supa from '../../../supabase';

const ctx = { actor: 'test', correlation: 'c1' } as any;

describe('gold_margin_by_bu', () => {
  it('calls the gold.margin_by_bu RPC with the gold profile and maps cents→dollars', async () => {
    const spy = vi.spyOn(supa, 'sbRpc').mockResolvedValue([
      { business_unit_id: 10, revenue_cents: 100000, cost_cents: 40000, gp_cents: 60000, gp_pct: 60.0, job_count: 5 },
    ] as any);
    const out: any = await gold_margin_by_bu.handler({} as any, { from: '2026-06-01', to: '2026-06-30' }, ctx);
    expect(spy).toHaveBeenCalledWith(expect.anything(), 'margin_by_bu',
      { p_from: '2026-06-01', p_to: '2026-06-30', p_bu_id: null }, 'gold');
    expect(out.rows[0]).toMatchObject({ business_unit_id: 10, revenue_$: 1000, cost_$: 400, gp_$: 600, gp_pct: 60.0, job_count: 5 });
    expect(out._source).toBe('gold');
    expect(out._margin_basis).toMatch(/labor/i);
  });

  it('passes businessUnitId through as p_bu_id', async () => {
    const spy = vi.spyOn(supa, 'sbRpc').mockResolvedValue([] as any);
    await gold_margin_by_bu.handler({} as any, { from: '2026-06-01', to: '2026-06-30', businessUnitId: 42 }, ctx);
    expect(spy).toHaveBeenCalledWith(expect.anything(), 'margin_by_bu',
      { p_from: '2026-06-01', p_to: '2026-06-30', p_bu_id: 42 }, 'gold');
  });
});
