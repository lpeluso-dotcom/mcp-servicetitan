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

// ── DEFECT-06 closure: zero-revenue semantics ───────────────
// "Install revenue missing from gold" was filed as a pipeline defect and is
// NOT one. gold.fct_job mirrors ST faithfully — the linked ST invoices really
// do read total 0.00. Roughly half of completed jobs in a month legitimately
// carry $0, for three separate and correct reasons: unsold sales/lead jobs,
// test jobs, and revenue invoiced through manual bypass batches that never
// touch the ST job-invoice grain. Documented here so the next reviewer does
// not re-file it. (Live-verified 2026-07-28: the only $0-revenue BUs in a
// June-2026 window were three Sales BUs plus one Install BU.)
describe('gold_margin_by_bu zero-revenue semantics (DEFECT-06 closure)', () => {
  it('description explains that $0 revenue is frequently correct, not missing data', () => {
    const d = gold_margin_by_bu.description;
    expect(d).toMatch(/\$0|zero/i);
    expect(d).toMatch(/lead|unsold|sales/i);
    expect(d).toMatch(/bypass/i);
  });

  it('ships a _revenue_basis caveat alongside the rows, like _margin_basis', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([
      { business_unit_id: 75928567, revenue_cents: 0, cost_cents: 0, gp_cents: 0, gp_pct: null, job_count: 15 },
    ]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock as any);

    const out: any = await gold_margin_by_bu.handler(
      { SUPABASE_URL: 'https://p.supabase.co', SUPABASE_PB_KEY: 'k' } as any,
      { from: '2026-06-01', to: '2026-06-30' },
      { actor: 'test', correlation: 'c1' } as any,
    );

    expect(out._revenue_basis).toBeDefined();
    expect(out._revenue_basis).toMatch(/bypass/i);
    expect(out._revenue_basis).toMatch(/lead|unsold|sales/i);
  });
});
