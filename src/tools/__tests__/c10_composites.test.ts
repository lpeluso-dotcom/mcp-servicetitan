// ============================================================
// C10-C12 tests — L5 Composite tools (10 total)
// Strategy: mock taylor-ai fetch for each sub-call.
// Key invariants:
// - customer_snapshot fires 7 sub-calls, uses single-flight DO
// - pricebook_health_check_services is D1-only (services fresh)
// - marketing_roas is a stub (returns pending dependency status)
// - membership_jackpot_leaderboard anonymizes until 2026-07-04
// ============================================================

import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { customer_snapshot } from '../composites/customer_snapshot';
import { pricebook_health_check_services } from '../composites/pricebook_health_check_services';
import { job_closeout_report } from '../composites/job_closeout_report';
import { margin_audit } from '../composites/margin_audit';
import { membership_outreach_list } from '../composites/membership_outreach_list';
import { dispatch_override_audit } from '../composites/dispatch_override_audit';
import { call_quality_review } from '../composites/call_quality_review';
import { commercial_plumbing_opportunities } from '../composites/commercial_plumbing_opportunities';
import { membership_jackpot_leaderboard } from '../composites/membership_jackpot_leaderboard';
import { marketing_roas } from '../composites/marketing_roas';

const CORRELATION = 'test-corr';
const CTX = { actor: 'vitest', correlation: CORRELATION };

function makeStmt(result: unknown = null) {
  return {
    bind: vi.fn().mockReturnThis(),
    run: vi.fn().mockResolvedValue({ success: true }),
    first: vi.fn().mockResolvedValue(result),
    all: vi.fn().mockResolvedValue({ results: Array.isArray(result) ? result : [] }),
  };
}

function makeDB(result: unknown = null) {
  return { prepare: vi.fn().mockReturnValue(makeStmt(result)) };
}

function makeEnv(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>): any {
  const singleflightDO = {
    idFromName: vi.fn().mockReturnValue('do-id'),
    get: vi.fn().mockReturnValue({
      fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ acquired: true }), { status: 200 })),
    }),
  };
  return {
    TAYLOR_AI: { fetch: vi.fn(fetchImpl) },
    MCP_SYNC_KEY: 'test-key',
    MCP_SERVICE_VERSION: '0.0.0-test',
    DB: makeDB(),
    TAI_STATE: {},
    SIRO_API_TOKEN: '',
    CUSTOMER_SNAPSHOT_FLIGHT: singleflightDO,
  };
}

function liveOk(data: unknown) {
  return async () => new Response(JSON.stringify({ data }), { status: 200 });
}

function liveOkDirect(data: unknown) {
  return async () => new Response(JSON.stringify(data), { status: 200 });
}

// ── C10 ──────────────────────────────────────────────────────

describe('customer_snapshot', () => {
  it('requires customerId', async () => {
    const schema = z.object(customer_snapshot.zodSchema);
    expect(schema.safeParse({}).success).toBe(false);
  });

  it('returns a composite with customer, locations, jobs, memberships, estimates, invoices keys', async () => {
    const env = makeEnv(liveOk([]));
    const result: any = await customer_snapshot.handler(env, { customerId: 100 }, CTX);
    expect(result.customerId).toBe(100);
    expect(result).toHaveProperty('customer');
    expect(result).toHaveProperty('locations');
    expect(result).toHaveProperty('jobs');
    expect(result).toHaveProperty('memberships');
    expect(result).toHaveProperty('estimates');
    expect(result).toHaveProperty('invoices');
  });

  it('uses CUSTOMER_SNAPSHOT_FLIGHT DO for single-flight', async () => {
    const env = makeEnv(liveOk([]));
    await customer_snapshot.handler(env, { customerId: 100 }, CTX);
    expect(env.CUSTOMER_SNAPSHOT_FLIGHT.idFromName).toHaveBeenCalledWith('100');
  });

  it('reports _partial=false when all 6 sub-calls succeed', async () => {
    const env = makeEnv(liveOk([]));
    const result: any = await customer_snapshot.handler(env, { customerId: 100 }, CTX);
    expect(result._partial).toBe(false);
    expect(result._failures).toEqual([]);
  });

  it('reports _partial=true with named failures when a sub-call returns 5xx', async () => {
    let n = 0;
    const env = makeEnv(async () => {
      n++;
      // memberships is the 4th sub-call — fail it
      if (n === 4) return new Response('fail', { status: 503, statusText: 'Bad Gateway' });
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    });
    const result: any = await customer_snapshot.handler(env, { customerId: 100 }, CTX);
    expect(result._partial).toBe(true);
    expect(result._failures).toHaveLength(1);
    expect(result._failures[0]).toMatchObject({ call: 'memberships', error_class: 'HTTPError' });
    expect(result.memberships).toBeNull();
    // Other fields populated normally
    expect(result.customer).toEqual([]);
  });
});

describe('pricebook_health_check_services', () => {
  it('accepts empty args', async () => {
    const schema = z.object(pricebook_health_check_services.zodSchema);
    expect(schema.safeParse({}).success).toBe(true);
  });

  it('returns service health summary', async () => {
    const env = makeEnv(liveOk([]));
    const result: any = await pricebook_health_check_services.handler(env, {}, CTX);
    expect(result).toHaveProperty('summary');
  });
});

describe('job_closeout_report', () => {
  it('requires jobId', async () => {
    const schema = z.object(job_closeout_report.zodSchema);
    expect(schema.safeParse({}).success).toBe(false);
  });

  it('returns composite with job, appointments, invoice keys', async () => {
    const env = makeEnv(liveOkDirect({ id: 500 }));
    const result: any = await job_closeout_report.handler(env, { jobId: 500 }, CTX);
    expect(result.jobId).toBe(500);
    expect(result).toHaveProperty('job');
    expect(result).toHaveProperty('appointments');
    expect(result).toHaveProperty('invoice');
  });

  it('reports _partial=true when an inner fetch rejects', async () => {
    let n = 0;
    const env = makeEnv(async () => {
      n++;
      // Reject the 2nd call (appointments)
      if (n === 2) throw new TypeError('socket reset');
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    });
    const result: any = await job_closeout_report.handler(env, { jobId: 500 }, CTX);
    expect(result._partial).toBe(true);
    expect(result._failures).toEqual([
      { call: 'appointments', error_class: 'TypeError', message: 'socket reset' },
    ]);
    expect(result.appointments).toBeNull();
  });
});

// ── C11 ──────────────────────────────────────────────────────

describe('margin_audit', () => {
  it('requires businessUnitId, from, and to', async () => {
    const schema = z.object(margin_audit.zodSchema);
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ businessUnitId: 1, from: '2026-01-01' }).success).toBe(false);
  });

  it('returns audit with revenue, cost, margin keys', async () => {
    const env = makeEnv(liveOk([]));
    const result: any = await margin_audit.handler(env, {
      businessUnitId: 3, from: '2026-01-01', to: '2026-03-31',
    }, CTX);
    expect(result).toHaveProperty('revenue');
    expect(result).toHaveProperty('cost');
    expect(result).toHaveProperty('margin');
  });
});

describe('membership_outreach_list', () => {
  it('requires segment', async () => {
    const schema = z.object(membership_outreach_list.zodSchema);
    expect(schema.safeParse({}).success).toBe(false);
  });

  it('returns contacts list', async () => {
    const env = makeEnv(liveOk([]));
    const result: any = await membership_outreach_list.handler(env, { segment: 'expiring_30' }, CTX);
    expect(result).toHaveProperty('contacts');
  });
});

describe('dispatch_override_audit', () => {
  it('requires from and to dates', async () => {
    const schema = z.object(dispatch_override_audit.zodSchema);
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ from: '2026-01-01' }).success).toBe(false);
  });

  it('returns overrides array', async () => {
    const env = makeEnv(liveOk([]));
    const result: any = await dispatch_override_audit.handler(env, {
      from: '2026-04-01', to: '2026-04-22',
    }, CTX);
    expect(result).toHaveProperty('overrides');
  });
});

// ── C12 ──────────────────────────────────────────────────────

describe('call_quality_review', () => {
  it('requires from and to dates', async () => {
    const schema = z.object(call_quality_review.zodSchema);
    expect(schema.safeParse({}).success).toBe(false);
  });

  it('returns reviews array', async () => {
    const env = makeEnv(liveOk([]));
    const result: any = await call_quality_review.handler(env, {
      from: '2026-04-01', to: '2026-04-22',
    }, CTX);
    expect(result).toHaveProperty('reviews');
  });
});

describe('commercial_plumbing_opportunities', () => {
  it('accepts empty args', async () => {
    const schema = z.object(commercial_plumbing_opportunities.zodSchema);
    expect(schema.safeParse({}).success).toBe(true);
  });

  it('returns opportunities array', async () => {
    const env = makeEnv(liveOk([]));
    const result: any = await commercial_plumbing_opportunities.handler(env, {}, CTX);
    expect(result).toHaveProperty('opportunities');
  });
});

describe('membership_jackpot_leaderboard', () => {
  it('accepts empty args', async () => {
    const schema = z.object(membership_jackpot_leaderboard.zodSchema);
    expect(schema.safeParse({}).success).toBe(true);
  });

  it('anonymizes employee names until 2026-07-04', async () => {
    const env = makeEnv(liveOk([{ id: 1, employee: 'Alice', count: 5 }]));
    const result: any = await membership_jackpot_leaderboard.handler(env, {}, CTX);
    expect(result).toHaveProperty('leaderboard');
    // Names must be anonymized per Jackpot Drive rules until 2026-07-04
    const entry = result.leaderboard[0];
    if (entry) {
      expect(entry.employee).toBeUndefined();
      expect(entry.rank).toBeDefined();
    }
  });
});

describe('marketing_roas', () => {
  it('accepts empty args (stub — pending external MCPs)', async () => {
    const schema = z.object(marketing_roas.zodSchema);
    expect(schema.safeParse({}).success).toBe(true);
  });

  it('returns pending dependency stub', async () => {
    const env = makeEnv(liveOk([]));
    const result: any = await marketing_roas.handler(env, {}, CTX);
    expect(result.status).toBe('pending_dependency');
    expect(result.blocking_on).toBeDefined();
  });
});
