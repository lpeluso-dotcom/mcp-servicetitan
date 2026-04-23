// ============================================================
// T7 tests — Estimates (3) + Dispatch (4) + Marketing (3)
// Key catalog corrections: get_capacity is POST (not GET),
// update_estimate_status requires soldBy when status=Sold,
// create_call_with_campaign uses telecom stitch pattern.
// ============================================================

import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { list_estimates_job } from '../estimates/list_estimates_job';
import { get_estimate } from '../estimates/get_estimate';
import { update_estimate_status } from '../estimates/update_estimate_status';
import { get_capacity } from '../dispatch/get_capacity';
import { list_technicians_available } from '../dispatch/list_technicians_available';
import { get_technician_shifts } from '../dispatch/get_technician_shifts';
import { list_non_job_events } from '../dispatch/list_non_job_events';
import { list_campaigns } from '../marketing/list_campaigns';
import { get_campaign_performance } from '../marketing/get_campaign_performance';
import { create_call_with_campaign } from '../marketing/create_call_with_campaign';

const CORRELATION = 'test-corr';
const CTX = { actor: 'vitest', correlation: CORRELATION };

function makeDB(firstResult: unknown = null) {
  const stmt = {
    bind: vi.fn().mockReturnThis(),
    run: vi.fn().mockResolvedValue({ success: true }),
    first: vi.fn().mockResolvedValue(firstResult),
  };
  return { prepare: vi.fn().mockReturnValue(stmt) };
}

function makeEnv(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>): any {
  return {
    TAYLOR_AI: { fetch: vi.fn(fetchImpl) },
    MCP_SYNC_KEY: 'test-key',
    MCP_SERVICE_VERSION: '0.0.0-test',
    DB: makeDB(),
    TAI_STATE: {},
    SIRO_API_TOKEN: '',
  };
}

function liveOk(data: unknown) {
  return async () => new Response(JSON.stringify({ data }), { status: 200 });
}

function liveOkDirect(data: unknown) {
  return async () => new Response(JSON.stringify(data), { status: 200 });
}

function dryRunFetch() {
  return async (url: string) => {
    if (url.includes('dryRun=1')) return new Response(JSON.stringify({ echo: true }), { status: 200 });
    throw new Error(`unexpected URL: ${url}`);
  };
}

// ── Estimates ────────────────────────────────────────────────

describe('list_estimates_job', () => {
  it('requires jobId', async () => {
    const schema = z.object(list_estimates_job.zodSchema);
    expect(schema.safeParse({}).success).toBe(false);
  });

  it('fetches estimates for a job', async () => {
    const env = makeEnv(liveOk([{ id: 10, status: 'Pending' }]));
    const result: any = await list_estimates_job.handler(env, { jobId: 500 }, CTX);
    expect(result.estimates).toBeDefined();
    expect(Array.isArray(result.estimates)).toBe(true);
  });

  it('calls estimates endpoint with jobId filter', async () => {
    const env = makeEnv(liveOk([]));
    await list_estimates_job.handler(env, { jobId: 500 }, CTX);
    const [url] = env.TAYLOR_AI.fetch.mock.calls[0];
    expect(url).toContain('500');
    expect(url).toContain('estimate');
  });
});

describe('get_estimate', () => {
  it('requires estimateId', async () => {
    const schema = z.object(get_estimate.zodSchema);
    expect(schema.safeParse({}).success).toBe(false);
  });

  it('fetches a single estimate by ID', async () => {
    const env = makeEnv(liveOkDirect({ id: 10, status: 'Pending' }));
    const result: any = await get_estimate.handler(env, { estimateId: 10 }, CTX);
    expect(result.estimate).toBeDefined();
  });

  it('calls estimates endpoint with ID', async () => {
    const env = makeEnv(liveOkDirect({ id: 10 }));
    await get_estimate.handler(env, { estimateId: 10 }, CTX);
    const [url] = env.TAYLOR_AI.fetch.mock.calls[0];
    expect(url).toContain('10');
    expect(url).toContain('estimate');
  });
});

describe('update_estimate_status', () => {
  it('is a write tool', () => expect(update_estimate_status.isWrite).toBe(true));

  it('defaults to dryRun=true', async () => {
    const env = makeEnv(dryRunFetch());
    const result: any = await update_estimate_status.handler(env, {
      estimateId: 10, status: 'Presented',
    }, CTX);
    expect(result.dryRun).toBe(true);
  });

  it('requires soldBy when status=Sold (T7 precondition)', async () => {
    const env = makeEnv(dryRunFetch());
    // Handler applies the refine — status=Sold without soldBy must throw
    await expect(update_estimate_status.handler(env, { estimateId: 10, status: 'Sold' }, CTX))
      .rejects.toMatchObject({ code: 'validation_error' });
  });

  it('accepts non-Sold statuses without soldBy', async () => {
    const schema = z.object(update_estimate_status.zodSchema);
    expect(schema.safeParse({ estimateId: 10, status: 'Presented' }).success).toBe(true);
    expect(schema.safeParse({ estimateId: 10, status: 'Dismissed' }).success).toBe(true);
  });
});

// ── Dispatch ─────────────────────────────────────────────────

describe('get_capacity', () => {
  // T3 catalog correction: this is a POST, not a GET.
  // Body: {businessUnitIds, skillBasedAvailability, startDate, endDate}
  it('requires businessUnitIds and date range', async () => {
    const schema = z.object(get_capacity.zodSchema);
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ businessUnitIds: [1], startDate: '2026-05-01' }).success).toBe(false);
  });

  it('calls capacity endpoint as POST (T3 correction)', async () => {
    const env = makeEnv(liveOkDirect({ slots: [] }));
    const result: any = await get_capacity.handler(env, {
      businessUnitIds: [3],
      startDate: '2026-05-01',
      endDate: '2026-05-07',
    }, CTX);
    expect(result.capacity).toBeDefined();
    const [, init] = env.TAYLOR_AI.fetch.mock.calls[0];
    expect(init.method).toBe('POST');
  });

  it('passes skillBasedAvailability flag', async () => {
    const env = makeEnv(liveOkDirect({ slots: [] }));
    await get_capacity.handler(env, {
      businessUnitIds: [3],
      startDate: '2026-05-01',
      endDate: '2026-05-07',
      skillBasedAvailability: true,
    }, CTX);
    const [, init] = env.TAYLOR_AI.fetch.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.skillBasedAvailability).toBe(true);
  });
});

describe('list_technicians_available', () => {
  it('accepts empty args', async () => {
    const env = makeEnv(liveOk([]));
    const result: any = await list_technicians_available.handler(env, {}, CTX);
    expect(result.technicians).toBeDefined();
  });

  it('passes date filter', async () => {
    const env = makeEnv(liveOk([]));
    await list_technicians_available.handler(env, { date: '2026-05-01' }, CTX);
    const [url] = env.TAYLOR_AI.fetch.mock.calls[0];
    expect(url).toContain('2026-05-01');
  });
});

describe('get_technician_shifts', () => {
  it('requires technicianId', async () => {
    const schema = z.object(get_technician_shifts.zodSchema);
    expect(schema.safeParse({}).success).toBe(false);
  });

  it('fetches shifts for a technician', async () => {
    const env = makeEnv(liveOk([{ id: 1, start: '2026-05-01T08:00' }]));
    const result: any = await get_technician_shifts.handler(env, { technicianId: 42 }, CTX);
    expect(result.shifts).toBeDefined();
  });
});

describe('list_non_job_events', () => {
  it('accepts empty args', async () => {
    const env = makeEnv(liveOk([]));
    const result: any = await list_non_job_events.handler(env, {}, CTX);
    expect(result.events).toBeDefined();
  });
});

// ── Marketing ────────────────────────────────────────────────

describe('list_campaigns', () => {
  it('accepts empty args', async () => {
    const env = makeEnv(liveOk([{ id: 1, name: 'Summer HVAC' }]));
    const result: any = await list_campaigns.handler(env, {}, CTX);
    expect(result.campaigns).toBeDefined();
    expect(Array.isArray(result.campaigns)).toBe(true);
  });

  it('passes active filter', async () => {
    const env = makeEnv(liveOk([]));
    await list_campaigns.handler(env, { active: true }, CTX);
    const [url] = env.TAYLOR_AI.fetch.mock.calls[0];
    expect(url).toContain('campaign');
  });
});

describe('get_campaign_performance', () => {
  it('requires campaignId', async () => {
    const schema = z.object(get_campaign_performance.zodSchema);
    expect(schema.safeParse({}).success).toBe(false);
  });

  it('fetches performance data for a campaign', async () => {
    const env = makeEnv(liveOk({ id: 5, leads: 20, bookings: 8 }));
    const result: any = await get_campaign_performance.handler(env, { campaignId: 5 }, CTX);
    expect(result.performance).toBeDefined();
  });
});

describe('create_call_with_campaign', () => {
  // T10 catalog correction: renamed from create_lead_attribution_call.
  // ST has no "lead attribution" object — uses POST /telecom/v3/tenant/.../calls
  // with {campaignId, customerId, leadCallId} stitched in.
  it('is a write tool', () => expect(create_call_with_campaign.isWrite).toBe(true));

  it('requires customerId and campaignId', async () => {
    const schema = z.object(create_call_with_campaign.zodSchema);
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ customerId: 1 }).success).toBe(false);
    expect(schema.safeParse({ campaignId: 5 }).success).toBe(false);
  });

  it('defaults to dryRun=true', async () => {
    const env = makeEnv(dryRunFetch());
    const result: any = await create_call_with_campaign.handler(env, {
      customerId: 1, campaignId: 5,
    }, CTX);
    expect(result.dryRun).toBe(true);
  });

  it('posts to telecom calls endpoint (not lead attribution)', async () => {
    const env = makeEnv(dryRunFetch());
    await create_call_with_campaign.handler(env, { customerId: 1, campaignId: 5 }, CTX);
    const [, init] = env.TAYLOR_AI.fetch.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.endpoint).toContain('telecom');
  });
});
