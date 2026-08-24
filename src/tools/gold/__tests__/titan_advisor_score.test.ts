import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
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

  // ── Query-string safety: from/to are interpolated into the PostgREST URL. ──────────────
  it.each([
    ['2026-08-01&limit=99999', 'smuggled extra PostgREST param'],
    ['2026-08-01&select=*', 'smuggled select override'],
    ['notadate', 'not a date at all'],
    ['2026-8-4', 'loose format ST would not round-trip'],
  ])('rejects %s at the schema (%s)', (bad) => {
    // Validate the whole args object — that is what the MCP layer does before the handler runs.
    const schema = z.object(titan_advisor_score.zodSchema as Record<string, z.ZodTypeAny>);
    expect(schema.safeParse({ from: bad, to: '2026-08-03' }).success).toBe(false);
    expect(schema.safeParse({ from: '2026-08-03', to: bad }).success).toBe(false);
  });

  it('accepts a well-formed ISO date', () => {
    const schema = z.object(titan_advisor_score.zodSchema as Record<string, z.ZodTypeAny>);
    expect(schema.safeParse({ from: '2026-08-03', to: '2026-08-03' }).success).toBe(true);
  });

  // ── Row caps: this Supabase project has no server-side db_max_rows backstop. ───────────
  it('applies an explicit row cap to every query', async () => {
    const f = stubFetch({
      snap_titan_advisor_daily: [], agg_titan_advisor_section_daily: [],
      fct_titan_advisor_feature_daily: [],
    });
    await titan_advisor_score.handler(env, {
      from: '2025-01-01', to: '2026-08-03', detail: true,
    }, ctx);
    for (const [u] of f.mock.calls) expect(String(u)).toMatch(/[&?]limit=\d+/);
  });

  it('drops the OLDEST days when a cap bites, never the newest', async () => {
    const f = stubFetch({ snap_titan_advisor_daily: [], agg_titan_advisor_section_daily: [] });
    await titan_advisor_score.handler(env, { from: '2020-01-01', to: '2026-08-03' }, ctx);
    // desc + limit keeps the most recent N. Ordering asc would truncate the recent end,
    // making a too-wide window look like a pipeline that stopped running.
    // Scoped to the advisor reads: the `_gold_as_of` watermark probe also
    // fetches, and it reads vec.refresh_state, which has no snapshot_date.
    const advisorCalls = (f.mock.calls as any[])
      .map(([u]) => String(u))
      .filter((u) => u.includes('titan_advisor'));
    expect(advisorCalls.length).toBeGreaterThan(0);
    for (const u of advisorCalls) expect(u).toContain('order=snapshot_date.desc');
  });

  it('still returns rows oldest-first after the desc fetch is reversed', async () => {
    stubFetch({
      // PostgREST returns newest-first under order=desc; the handler must reverse it.
      snap_titan_advisor_daily: [
        { snapshot_date: '2026-08-03', earned: 269, available: 476, pct: 56.5, feature_count: 131, checkpoint_count: 315 },
        { snapshot_date: '2026-08-02', earned: 268, available: 476, pct: 56.3, feature_count: 131, checkpoint_count: 315 },
      ],
      agg_titan_advisor_section_daily: [],
    });
    const out: any = await titan_advisor_score.handler(env, { from: '2026-08-02', to: '2026-08-03' }, ctx);
    expect(out.daily.map((r: any) => r.snapshot_date)).toEqual(['2026-08-02', '2026-08-03']);
  });

  it('flags truncation when a cap is hit, so a partial series is not read as complete', async () => {
    // 400 daily rows = LIMIT_DAILY, i.e. the cap bit.
    const capped = Array.from({ length: 400 }, (_, i) => ({
      snapshot_date: '2026-08-03', earned: 269, available: 476, pct: 56.5,
      feature_count: 131, checkpoint_count: 315, _i: i,
    }));
    stubFetch({ snap_titan_advisor_daily: capped, agg_titan_advisor_section_daily: [] });
    const out: any = await titan_advisor_score.handler(env, {
      from: '2020-01-01', to: '2026-08-03',
    }, ctx);
    expect(out.truncated).toBe(true);
    expect(out._truncation_note).toMatch(/INCOMPLETE/);
  });

  it('does not flag truncation on a normal window', async () => {
    stubFetch({
      snap_titan_advisor_daily: [{ snapshot_date: '2026-08-03', earned: 269, available: 476, pct: 56.5, feature_count: 131, checkpoint_count: 315 }],
      agg_titan_advisor_section_daily: [],
    });
    const out: any = await titan_advisor_score.handler(env, { from: '2026-08-03', to: '2026-08-03' }, ctx);
    expect(out.truncated).toBeUndefined();
  });

  it('description states percentage-not-earned, falling-is-real, and adoption-only scope', () => {
    const d = titan_advisor_score.description;
    expect(d).toMatch(/percentage/i);
    expect(d).toMatch(/not comparable across dates|earned/i);
    expect(d).toMatch(/falling|decay/i);
    expect(d).toMatch(/not.*(revenue|margin|job count|technician performance)|feature adoption only/i);
  });
});
