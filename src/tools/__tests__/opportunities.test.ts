import { describe, it, expect, vi } from 'vitest';
import { opportunities_list } from '../opportunities/opportunities_list';
import { opportunity_get } from '../opportunities/opportunity_get';

const OPP_ROW = {
  opportunity_id: 12345,
  job_id: 78630267,
  location_id: 5001,
  project_id: 78675426,
  customer_id: 9001,
  customer_name: 'Acme Corp',
  customer_phone: '555-0100',
  status: 'Not Attempted',
  follow_up_date: '2026-05-22',
  last_follow_up_date: null,
  follow_ups_count: 0,
  estimate_amount: 12500.0,
  sold_estimate_amount: 0,
  open_estimates_count: 2,
  sold_estimates_count: 0,
  recommended_estimates_count: 1,
  job_type_name: 'Generator Install',
  business_unit: 'Electrical Install Residential',
  technicians_json: '["Brooks H","Carlos P"]',
  created_by_users_json: '["lpeluso"]',
  location_name: 'Main',
  location_address: '123 Pine',
  created_date: '2026-05-10T12:00:00Z',
  modified_date: '2026-05-15T08:00:00Z',
  job_completed_on: null,
  active: 1,
  synced_at: '2026-05-19T12:00:00Z',
};

function envWith(handler: (body: any) => any) {
  const fetcher = vi.fn(async (_url: any, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(init.body as string) : {};
    return new Response(JSON.stringify(handler(body)), { status: 200 });
  });
  return {
    ST_TENANT_ID: '431848990',
    ST_PROXY: { fetch: fetcher },
    MCP_SYNC_KEY: 'k',
  } as any;
}

describe('opportunities_list', () => {
  it('lists open opportunities with technicians parsed from JSON', async () => {
    const env = envWith(() => ({ success: true, results: [OPP_ROW] }));
    const out: any = await opportunities_list.handler(
      env,
      { status: 'Not Attempted' },
      { actor: 'test', correlation: 'c1' },
    );
    expect(out._source).toBe('d1');
    expect(out.count).toBe(1);
    expect(out.opportunities[0].technicians).toEqual(['Brooks H', 'Carlos P']);
    expect(out.opportunities[0].active).toBe(true);
  });

  it('builds WHERE clauses for each filter', async () => {
    let capturedSql = '';
    let capturedParams: unknown[] = [];
    const env = envWith((body) => {
      capturedSql = body.sql;
      capturedParams = body.params;
      return { success: true, results: [] };
    });
    await opportunities_list.handler(
      env,
      {
        status: 'Contacted',
        customerId: 9001,
        jobId: 100,
        projectId: 200,
        businessUnit: 'HVAC Service Residential',
        followUpOnOrAfter: '2026-01-01',
        active: true,
        hasOpenEstimates: true,
      },
      { actor: 'test', correlation: 'c1' },
    );
    expect(capturedSql).toContain('status = ?');
    expect(capturedSql).toContain('customer_id = ?');
    expect(capturedSql).toContain('job_id = ?');
    expect(capturedSql).toContain('project_id = ?');
    expect(capturedSql).toContain('business_unit = ?');
    expect(capturedSql).toContain('follow_up_date >= ?');
    expect(capturedSql).toContain('active = ?');
    expect(capturedSql).toContain('open_estimates_count > 0');
    expect(capturedParams).toEqual([
      'Contacted', 9001, 100, 200, 'HVAC Service Residential', '2026-01-01', 1,
      51, 0, // pageSize + 1 = 50 + 1, offset
    ]);
  });

  it('has_more flips true when results exceed pageSize', async () => {
    const env = envWith(() => ({
      success: true,
      results: Array(11).fill(OPP_ROW),
    }));
    const out: any = await opportunities_list.handler(
      env,
      { pageSize: 10 },
      { actor: 'test', correlation: 'c1' },
    );
    expect(out.has_more).toBe(true);
    expect(out.count).toBe(10);
  });
});

describe('opportunity_get', () => {
  it('returns opportunity + linked estimates', async () => {
    const env = envWith((body) => {
      if (String(body.sql).includes('FROM opportunities')) {
        return { success: true, results: [OPP_ROW] };
      }
      if (String(body.sql).includes('FROM estimates')) {
        return {
          success: true,
          results: [
            { estimate_id: 999, job_id: 78630267, project_id: 78675426, name: 'Quote A', status: 'Open', total: 12500, sold_by: null, active: 1, modified_at: '2026-05-15T08:00:00Z' },
          ],
        };
      }
      return { success: false };
    });
    const out: any = await opportunity_get.handler(
      env,
      { opportunityId: 12345 },
      { actor: 'test', correlation: 'c1' },
    );
    expect(out.status).toBe('success');
    expect(out.opportunity.opportunity_id).toBe(12345);
    expect(out.opportunity.technicians).toEqual(['Brooks H', 'Carlos P']);
    expect(out.estimates.length).toBe(1);
    expect(out.estimates[0].estimate_id).toBe(999);
  });

  it('returns not_found when no opportunity row matches', async () => {
    const env = envWith(() => ({ success: true, results: [] }));
    const out: any = await opportunity_get.handler(
      env,
      { opportunityId: 99999 },
      { actor: 'test', correlation: 'c1' },
    );
    expect(out.status).toBe('not_found');
    expect(out.opportunity).toBeNull();
  });
});
