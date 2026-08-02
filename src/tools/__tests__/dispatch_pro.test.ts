import { describe, it, expect, vi } from 'vitest';
import { dispatch_pro_utilization_list } from '../dispatch-pro/dispatch_pro_utilization_list';
import { dispatch_pro_ratio_list } from '../dispatch-pro/dispatch_pro_ratio_list';
import { dispatch_pro_alerts_list } from '../dispatch-pro/dispatch_pro_alerts_list';

/**
 * `handler` serves the tool's data query; the fetchTableMax probe (matched
 * on `AS t,`) is answered separately with `tableMaxIso` (defaults fresh 1h)
 * so per-test handlers never see it.
 */
function envWith(
  handler: (body: any) => any,
  tableMaxIso: string | null = new Date(Date.now() - 1 * 3_600_000).toISOString(),
) {
  const fetcher = vi.fn(async (_url: any, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(init.body as string) : {};
    if (/ AS t,/.test(String(body.sql))) {
      const m = String(body.sql).match(/FROM (dispatch_pro_\w+)/);
      return new Response(
        JSON.stringify({ success: true, results: [{ t: m?.[1], m: tableMaxIso }] }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify(handler(body)), { status: 200 });
  });
  return {
    ST_TENANT_ID: '000000000',
    ST_PROXY: { fetch: fetcher },
    MCP_SYNC_KEY: 'k',
  } as any;
}

describe('dispatch_pro_utilization_list', () => {
  it('queries dispatch_pro_utilization with date + business_unit filters', async () => {
    let capturedSql = '';
    let capturedParams: unknown[] = [];
    const env = envWith((body) => {
      capturedSql = body.sql;
      capturedParams = body.params;
      return {
        success: true,
        results: [
          {
            completed_on: '2026-05-18',
            business_unit_filter: 'ALL',
            dispatch_pro_assigned_jobs: 45,
            manually_assigned_jobs: 12,
            dispatch_pro_enabled_jobs: 57,
            utilization_percentage: 78.9,
            day: 18,
            month: 5,
            synced_at: '2026-05-19T05:00:00Z',
          },
        ],
      };
    });
    const out: any = await dispatch_pro_utilization_list.handler(
      env,
      { startDate: '2026-05-01', endDate: '2026-05-18', businessUnitFilter: 'ALL' },
      { actor: 'test', correlation: 'c1' },
    );
    expect(out._source).toBe('d1');
    expect(out.count).toBe(1);
    expect(out.rows[0].utilization_percentage).toBe(78.9);
    expect(capturedSql).toContain('FROM dispatch_pro_utilization');
    expect(capturedSql).toContain('completed_on >= ?');
    expect(capturedSql).toContain('completed_on <= ?');
    expect(capturedSql).toContain('business_unit_filter = ?');
    expect(capturedParams.slice(0, 3)).toEqual(['2026-05-01', '2026-05-18', 'ALL']);
  });
});

describe('dispatch_pro_ratio_list', () => {
  it('queries dispatch_pro_ratio with all 5 filter dims', async () => {
    let capturedSql = '';
    const env = envWith((body) => {
      capturedSql = body.sql;
      return { success: true, results: [] };
    });
    await dispatch_pro_ratio_list.handler(
      env,
      {
        startDate: '2026-05-01',
        endDate: '2026-05-18',
        businessUnitFilter: 'HVAC Service Residential',
        jobTypeFilter: 'Service Call',
        daysOfWeekFilter: 'Weekday',
      },
      { actor: 'test', correlation: 'c1' },
    );
    expect(capturedSql).toContain('FROM dispatch_pro_ratio');
    expect(capturedSql).toContain('business_unit_filter = ?');
    expect(capturedSql).toContain('job_type_filter = ?');
    expect(capturedSql).toContain('days_of_week_filter = ?');
  });
});

// ── Mirror-freshness disclosure (MB-1 / QUA-1141) ────────────────────
// All three tools read the taylor-ai D1 mirror raw; a frozen or empty
// mirror must never be served as current truth without a stamp.

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

describe('dispatch-pro freshness disclosure (MB-1 / QUA-1141)', () => {
  const utilizationRow = (synced_at: string | null) => ({
    completed_on: '2026-05-18',
    business_unit_filter: 'ALL',
    dispatch_pro_assigned_jobs: 45,
    manually_assigned_jobs: 12,
    dispatch_pro_enabled_jobs: 57,
    utilization_percentage: 78.9,
    day: 18,
    month: 5,
    synced_at,
  });

  it('utilization: fresh rows are stamped fresh and the count is authoritative', async () => {
    const env = envWith(() => ({ success: true, results: [utilizationRow(hoursAgo(2))] }));
    const out: any = await dispatch_pro_utilization_list.handler(env, {}, { actor: 'test', correlation: 'c1' });
    expect(out._mirror_table).toBe('dispatch_pro_utilization');
    expect(out._freshness).toBe('fresh');
    expect(out.count_is_authoritative).toBe(true);
    expect(out._warning).toBeUndefined();
  });

  it('utilization: a frozen mirror (table MAX weeks old) is flagged unknown and authority is withheld', async () => {
    const env = envWith(() => ({ success: true, results: [utilizationRow(hoursAgo(24 * 20))] }), hoursAgo(24 * 20));
    const out: any = await dispatch_pro_utilization_list.handler(env, {}, { actor: 'test', correlation: 'c1' });
    expect(out._freshness).toBe('unknown');
    expect(out.count_is_authoritative).toBe(false);
    expect(out._warning).toMatch(/no row change in|indistinguishable/);
    expect(out._stale_hours).toBeGreaterThan(48);
  });

  it('utilization: an UNPROVABLE mirror (MAX null) does NOT present count 0 as authoritative', async () => {
    const env = envWith(() => ({ success: true, results: [] }), null);
    const out: any = await dispatch_pro_utilization_list.handler(env, {}, { actor: 'test', correlation: 'c1' });
    expect(out.count).toBe(0);
    expect(out.count_is_authoritative).toBe(false);
    expect(out._freshness).toBe('unknown');
    expect(out._empty).toBe(true);
    expect(out._warning).toMatch(/not proof/i);
  });

  it('utilization: zero rows on a LIVE mirror is an honest zero (F5)', async () => {
    const env = envWith(() => ({ success: true, results: [] }));
    const out: any = await dispatch_pro_utilization_list.handler(env, {}, { actor: 'test', correlation: 'c1' });
    expect(out.count).toBe(0);
    expect(out.count_is_authoritative).toBe(true);
    expect(out._freshness).toBe('fresh');
    expect(out._empty).toBe(true);
    expect(out._warning).toBeUndefined();
  });

  it('utilization: OLD rows on a LIVE mirror are not called stale — the probe decides (F1)', async () => {
    const env = envWith(() => ({ success: true, results: [utilizationRow(hoursAgo(24 * 20))] }));
    const out: any = await dispatch_pro_utilization_list.handler(env, {}, { actor: 'test', correlation: 'c1' });
    expect(out._freshness).toBe('fresh');
    expect(out.count_is_authoritative).toBe(true);
  });

  it('ratio: stamps the dispatch_pro_ratio mirror and flags an unprovable empty read', async () => {
    const env = envWith(() => ({ success: true, results: [] }), null);
    const out: any = await dispatch_pro_ratio_list.handler(env, {}, { actor: 'test', correlation: 'c1' });
    expect(out._mirror_table).toBe('dispatch_pro_ratio');
    expect(out._freshness).toBe('unknown');
    expect(out._empty).toBe(true);
    expect(out.count_is_authoritative).toBe(false);
  });

  it('alerts: stamps the dispatch_pro_alerts mirror fresh off row-level synced_at', async () => {
    const env = envWith(() => ({
      success: true,
      results: [{
        alert_id: 1, job_id: 1000, job_number: 'JN-1', business_unit: 'HVAC',
        job_type: 'Install', job_start_time: '2026-05-18T08:00:00Z', dp_status: 'Active',
        alert_created_date: '2026-05-18T07:30:00Z', alert_type: 'Late',
        alert_name: 'Tech late to job', synced_at: hoursAgo(1),
      }],
    }));
    const out: any = await dispatch_pro_alerts_list.handler(env, {}, { actor: 'test', correlation: 'c1' });
    expect(out._mirror_table).toBe('dispatch_pro_alerts');
    expect(out._freshness).toBe('fresh');
    expect(out.count_is_authoritative).toBe(true);
  });
});

describe('dispatch_pro_alerts_list', () => {
  it('queries dispatch_pro_alerts and surfaces alert array', async () => {
    const env = envWith(() => ({
      success: true,
      results: [
        {
          alert_id: 1,
          job_id: 1000,
          job_number: 'JN-1',
          business_unit: 'HVAC',
          job_type: 'Install',
          job_start_time: '2026-05-18T08:00:00Z',
          dp_status: 'Active',
          alert_created_date: '2026-05-18T07:30:00Z',
          alert_type: 'Late',
          alert_name: 'Tech late to job',
          synced_at: '2026-05-19T05:00:00Z',
        },
      ],
    }));
    const out: any = await dispatch_pro_alerts_list.handler(
      env,
      { alertCreatedOnOrAfter: '2026-05-18T00:00:00Z' },
      { actor: 'test', correlation: 'c1' },
    );
    expect(out._source).toBe('d1');
    expect(out.alerts.length).toBe(1);
    expect(out.alerts[0].alert_type).toBe('Late');
  });
});
