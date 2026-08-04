import { describe, it, expect, vi, beforeEach } from 'vitest';
import { titan_advisor_score } from '../titan_advisor_score';

const env = { SUPABASE_URL: 'https://sb.example', SUPABASE_PB_KEY: 'k' } as any;
const ctx = { actor: 'test', correlation: 'c1' } as any;

beforeEach(() => { vi.restoreAllMocks(); });

function stubFetch(byPath: Record<string, unknown>) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
    const url = String(typeof input === 'string' ? input : input.url);
    const key = Object.keys(byPath).find((k) => url.includes(k));
    if (!key) throw new Error(`unexpected fetch: ${url}`);
    return new Response(JSON.stringify(byPath[key]), { status: 200 });
  });
}

describe('titan_advisor_score', () => {
  it('returns the daily overall score and the section breakdown', async () => {
    stubFetch({
      snap_titan_advisor_daily: [
        { snapshot_date: '2026-08-03', earned: 269, available: 476, pct: 56.5,
          feature_count: 131, checkpoint_count: 315 },
      ],
      agg_titan_advisor_section_daily: [
        { snapshot_date: '2026-08-03', section_name: 'Pricebook', earned: 27,
          available: 31, remaining: 4, pct: 87.1, feature_count: 9 },
      ],
    });
    const out: any = await titan_advisor_score.handler(env, { from: '2026-08-03', to: '2026-08-03' }, ctx);
    expect(out.daily[0].pct).toBe(56.5);
    expect(out.daily[0].earned).toBe(269);
    expect(out.sections[0].section_name).toBe('Pricebook');
  });

  it('requests the gold schema profile and filters on the date window', async () => {
    const f = stubFetch({ snap_titan_advisor_daily: [], agg_titan_advisor_section_daily: [] });
    await titan_advisor_score.handler(env, { from: '2026-07-01', to: '2026-08-03' }, ctx);
    const [url, init] = f.mock.calls[0];
    expect(String(url)).toContain('snapshot_date=gte.2026-07-01');
    expect(String(url)).toContain('snapshot_date=lte.2026-08-03');
    expect((init as any).headers['Accept-Profile']).toBe('gold');
  });

  it('omits checkpoint detail unless detail:true', async () => {
    const f = stubFetch({ snap_titan_advisor_daily: [], agg_titan_advisor_section_daily: [] });
    await titan_advisor_score.handler(env, { from: '2026-08-03', to: '2026-08-03' }, ctx);
    expect(f.mock.calls.every(([u]) => !String(u).includes('fct_titan_advisor_feature_daily'))).toBe(true);
  });

  it('includes per-feature detail when detail:true', async () => {
    stubFetch({
      snap_titan_advisor_daily: [],
      agg_titan_advisor_section_daily: [],
      fct_titan_advisor_feature_daily: [
        { snapshot_date: '2026-08-03', section_name: 'Pricebook', feature_name: 'Use images',
          earned: 0, available: 3, remaining: 3, status: 'Poor' },
      ],
    });
    const out: any = await titan_advisor_score.handler(env, {
      from: '2026-08-03', to: '2026-08-03', detail: true,
    }, ctx);
    expect(out.features[0].feature_name).toBe('Use images');
  });

  it('filters by section when given one', async () => {
    const f = stubFetch({ snap_titan_advisor_daily: [], agg_titan_advisor_section_daily: [] });
    await titan_advisor_score.handler(env, {
      from: '2026-08-03', to: '2026-08-03', section: 'Pricebook',
    }, ctx);
    expect(f.mock.calls.some(([u]) => String(u).includes('section_name=eq.Pricebook'))).toBe(true);
  });

  it('description states percentage-not-earned, falling-is-real, and adoption-only scope', () => {
    const d = titan_advisor_score.description;
    expect(d).toMatch(/percentage/i);
    expect(d).toMatch(/not comparable across dates|earned/i);
    expect(d).toMatch(/falling|decay/i);
    expect(d).toMatch(/not.*(revenue|margin|job count|technician performance)|feature adoption only/i);
  });
});
