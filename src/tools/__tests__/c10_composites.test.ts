// ============================================================
// C10-C12 tests — L5 Composite tools (10 total)
// Strategy: mock servicetitan-proxy fetch for each sub-call.
// Key invariants:
// - customer_snapshot fires 7 sub-calls, uses single-flight DO
// - pricebook_health_check_services is D1-only (services fresh)
// - membership_jackpot_leaderboard anonymizes until 2026-07-04
// - marketing_roas was deleted v1.1 (D4) — three external MCPs (scorpion,
//   lsa, lace) don't exist yet; cleaner-stub > stub-that-lies-to-Claude
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
  const rateLimiterDO = {
    idFromName: vi.fn().mockReturnValue('rl-id'),
    get: vi.fn().mockReturnValue({
      fetch: vi.fn().mockImplementation(
        async () => new Response(JSON.stringify({ allowed: true }), { status: 200 })
      ),
    }),
  };
  return {
    ST_PROXY: { fetch: vi.fn(fetchImpl) },
    MCP_SYNC_KEY: 'test-key',
    MCP_SERVICE_VERSION: '0.0.0-test',
    DB: makeDB(),
    PROXY_STATE: {},
    SIRO_API_TOKEN: '',
    CUSTOMER_SNAPSHOT_FLIGHT: singleflightDO,
    ST_RATE_LIMITER: rateLimiterDO,
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
  it('requires from and to (BU optional at schema level; refined in handler)', async () => {
    const schema = z.object(margin_audit.zodSchema);
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ businessUnitId: 1, from: '2026-01-01' }).success).toBe(false);
    expect(schema.safeParse({ businessUnitId: 1, from: '2026-01-01', to: '2026-03-31' }).success).toBe(true);
  });

  it('returns audit with revenue, cost, margin keys for single-page result', async () => {
    const env = makeEnv(liveOk([]));
    const result: any = await margin_audit.handler(env, {
      businessUnitId: 3, from: '2026-01-01', to: '2026-03-31',
    }, CTX);
    expect(result).toHaveProperty('revenue');
    expect(result).toHaveProperty('cost');
    expect(result).toHaveProperty('margin');
    expect(result._truncated).toBe(false);
    expect(result.pageCount).toBe(1);
  });

  it('rejects when neither businessUnitId nor businessUnitName is provided', async () => {
    const env = makeEnv(liveOk([]));
    await expect(
      margin_audit.handler(env, { from: '2026-01-01', to: '2026-03-31' } as any, CTX)
    ).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('rejects when both businessUnitId and businessUnitName are provided', async () => {
    const env = makeEnv(liveOk([]));
    await expect(
      margin_audit.handler(
        env,
        { businessUnitId: 1, businessUnitName: 'Service', from: '2026-01-01', to: '2026-03-31' },
        CTX
      )
    ).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('paginates across multiple pages and sums revenue + cost across all pages', async () => {
    let p = 0;
    const env = makeEnv(async (url: string) => {
      // Skip rate-limit DO calls — the handler routes those through env.ST_RATE_LIMITER.
      if (!url.includes('/api/st/read')) return new Response('{}', { status: 200 });
      p++;
      if (p === 1) {
        return new Response(
          JSON.stringify({ data: Array(200).fill({ invoiceTotal: 100, totalCost: 60 }), hasMore: true }),
          { status: 200 }
        );
      }
      if (p === 2) {
        return new Response(
          JSON.stringify({ data: Array(200).fill({ invoiceTotal: 100, totalCost: 60 }), hasMore: true }),
          { status: 200 }
        );
      }
      return new Response(
        JSON.stringify({ data: Array(50).fill({ invoiceTotal: 100, totalCost: 60 }), hasMore: false }),
        { status: 200 }
      );
    });
    const result: any = await margin_audit.handler(
      env,
      { businessUnitId: 3, from: '2026-01-01', to: '2026-03-31' },
      CTX
    );
    expect(result.jobCount).toBe(450);
    expect(result.pageCount).toBe(3);
    expect(result.revenue).toBe(45000); // 450 × 100
    expect(result.cost).toBe(27000);    // 450 × 60
    expect(result._truncated).toBe(false);
  });

  it('surfaces _truncated and _warnings when maxPages is hit', async () => {
    const env = makeEnv(async (url: string) => {
      if (!url.includes('/api/st/read')) return new Response('{}', { status: 200 });
      // Always return a full page with hasMore=true — should hit maxPages.
      return new Response(
        JSON.stringify({ data: Array(200).fill({ invoiceTotal: 1, totalCost: 1 }), hasMore: true }),
        { status: 200 }
      );
    });
    const result: any = await margin_audit.handler(
      env,
      { businessUnitId: 3, from: '2026-01-01', to: '2026-03-31' },
      CTX
    );
    expect(result._truncated).toBe(true);
    expect(result._warnings).toContain('truncated_at_max_pages');
    expect(result.pageCount).toBe(20); // default maxPages
    expect(result.jobCount).toBe(4000);
  });

  // Live-verified 2026-07-09: /jpm/v2/tenant/{tid}/jobs honors the SINGULAR
  // businessUnitId query param but silently ignores the plural
  // businessUnitIds (returns jobs across every BU, unfiltered). The tool
  // was sending the plural, so margin_audit computed margin over the whole
  // company instead of the requested BU.
  it('queries jobs with the singular businessUnitId param (plural businessUnitIds is silently ignored by ST)', async () => {
    const urls: string[] = [];
    const env = makeEnv(async (url: string) => {
      if (url.includes('/api/st/read')) urls.push(url);
      if (!url.includes('/api/st/read')) return new Response('{}', { status: 200 });
      return new Response(JSON.stringify({ data: [], hasMore: false }), { status: 200 });
    });
    await margin_audit.handler(
      env,
      { businessUnitId: 100003, from: '2026-01-01', to: '2026-03-31' },
      CTX
    );
    const jobsCalls = urls.filter((u) => u.includes('%2Fjobs%3F') || u.includes('/jobs?'));
    expect(jobsCalls.length).toBeGreaterThan(0);
    for (const u of jobsCalls) {
      expect(u).toContain('businessUnitId%3D100003');
      expect(u).not.toContain('businessUnitIds%3D');
    }
  });

  // Regression for the production 2026-07-09 incident: margin_audit hardcodes
  // TENANT_ID = '000000000' and hands it to pagedStRead, which previously
  // built the outgoing URL from the raw endpointPath — never resolving the
  // placeholder the way readST/readSTPost do. ST responded 403 "Resource
  // owner validation failed" to the literal /tenant/000000000/ path on every
  // call. This asserts the end-to-end outgoing jobs URL carries the real
  // tenant once pagedStRead resolves it internally.
  it('resolves the tenant placeholder in the outgoing jobs URL for a real-tenant env (2026-07-09 production 403)', async () => {
    const urls: string[] = [];
    const env = makeEnv(async (url: string) => {
      if (url.includes('/api/st/read')) urls.push(url);
      if (!url.includes('/api/st/read')) return new Response('{}', { status: 200 });
      return new Response(JSON.stringify({ data: [], hasMore: false }), { status: 200 });
    });
    env.ST_TENANT_ID = '431848990';
    await margin_audit.handler(
      env,
      { businessUnitId: 3, from: '2026-01-01', to: '2026-03-31' },
      CTX
    );
    const jobsCalls = urls.filter((u) => u.includes('%2Fjobs%3F') || u.includes('/jobs?'));
    expect(jobsCalls.length).toBeGreaterThan(0);
    for (const u of jobsCalls) {
      const endpointParam = new URL(u).searchParams.get('endpoint');
      expect(endpointParam).toContain('/jpm/v2/tenant/431848990/jobs');
      expect(endpointParam).not.toContain('/jpm/v2/tenant/000000000/jobs');
    }
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

// ── response shaping (defaultShaper) ────────────────────────────
// The 7 composites below previously returned raw, unshaped results.
// transformResult: defaultShaper must strip ST noise fields
// (paginationToken, requestId, eTag, _links, _meta) from nested items
// while preserving semantic fields and the composite envelope metadata.

const NOISE = {
  _links: { self: 'https://api.servicetitan.io/x' },
  eTag: 'W/"abc123"',
  paginationToken: 'tok-1',
  requestId: 'req-1',
  _meta: { fetchedAt: '2026-07-09T00:00:00Z' },
};

function expectNoiseStripped(item: any) {
  expect(item._links).toBeUndefined();
  expect(item.eTag).toBeUndefined();
  expect(item.paginationToken).toBeUndefined();
  expect(item.requestId).toBeUndefined();
  expect(item._meta).toBeUndefined();
}

describe('call_quality_review — transformResult', () => {
  it('strips ST noise from nested review items, preserves envelope + semantic fields', () => {
    const raw = {
      period: { from: '2026-04-01', to: '2026-04-22' },
      reviews: [
        {
          callId: 42,
          duration: 180,
          customerId: 100,
          campaignId: 7,
          createdOn: '2026-04-05T00:00:00Z',
          laceScore: null,
          ...NOISE,
        },
      ],
      callCount: 1,
      _composite: 'call_quality_review',
      _source: 'live',
      _note: 'Lace score integration deferred to v1.1 (requires mcp-lace)',
    };
    const shaped: any = call_quality_review.transformResult!(raw);
    expectNoiseStripped(shaped.reviews[0]);
    expect(shaped.reviews[0].callId).toBe(42);
    expect(shaped.reviews[0].duration).toBe(180);
    expect(shaped._composite).toBe('call_quality_review');
    expect(shaped._source).toBe('live');
    expect(shaped.callCount).toBe(1);
    expect(shaped.period).toEqual({ from: '2026-04-01', to: '2026-04-22' });
  });
});

describe('commercial_plumbing_opportunities — transformResult', () => {
  it('strips ST noise from nested opportunity items, preserves envelope + semantic fields', () => {
    const raw = {
      opportunities: [
        {
          customerId: 55,
          lastJobId: 900,
          lastJobDate: '2026-01-01T00:00:00Z',
          daysSinceLastJob: 120,
          ...NOISE,
        },
      ],
      count: 1,
      lookbackDays: 90,
      _composite: 'commercial_plumbing_opportunities',
      _source: 'live',
    };
    const shaped: any = commercial_plumbing_opportunities.transformResult!(raw);
    expectNoiseStripped(shaped.opportunities[0]);
    expect(shaped.opportunities[0].customerId).toBe(55);
    expect(shaped.opportunities[0].lastJobId).toBe(900);
    expect(shaped._composite).toBe('commercial_plumbing_opportunities');
    expect(shaped._source).toBe('live');
    expect(shaped.count).toBe(1);
    expect(shaped.lookbackDays).toBe(90);
  });
});

describe('dispatch_override_audit — transformResult', () => {
  it('strips ST noise from doubly-nested technician items, preserves envelope + semantic fields', () => {
    const raw = {
      period: { from: '2026-04-01', to: '2026-04-22' },
      overrides: [
        {
          appointmentId: 1001,
          jobId: 2002,
          start: '2026-04-10T09:00:00Z',
          technicians: [
            {
              appointment_id: 1001,
              technician_id: 55,
              technician_name: 'Bob',
              status: 'Active',
              ...NOISE,
            },
          ],
          isAutoDispatched: true,
        },
      ],
      overrideCount: 1,
      _composite: 'dispatch_override_audit',
      _source: 'live',
    };
    const shaped: any = dispatch_override_audit.transformResult!(raw);
    expectNoiseStripped(shaped.overrides[0].technicians[0]);
    expect(shaped.overrides[0].appointmentId).toBe(1001);
    expect(shaped.overrides[0].technicians[0].technician_id).toBe(55);
    expect(shaped.overrides[0].isAutoDispatched).toBe(true);
    expect(shaped._composite).toBe('dispatch_override_audit');
    expect(shaped._source).toBe('live');
    expect(shaped.overrideCount).toBe(1);
  });
});

describe('margin_audit — transformResult', () => {
  it('strips ST noise from nested _failures items, preserves envelope + semantic fields', () => {
    const raw = {
      businessUnitId: 3,
      period: { from: '2026-01-01', to: '2026-03-31' },
      jobCount: 450,
      pageCount: 3,
      revenue: 45000,
      cost: 27000,
      margin: 40,
      _composite: 'margin_audit',
      _source: 'live',
      _truncated: false,
      _partial: true,
      _failures: [
        { page: 2, status: 503, message: 'Bad Gateway', ...NOISE },
      ],
    };
    const shaped: any = margin_audit.transformResult!(raw);
    expectNoiseStripped(shaped._failures[0]);
    expect(shaped._failures[0].page).toBe(2);
    expect(shaped._failures[0].status).toBe(503);
    expect(shaped._composite).toBe('margin_audit');
    expect(shaped._source).toBe('live');
    expect(shaped._partial).toBe(true);
    expect(shaped.revenue).toBe(45000);
    expect(shaped.jobCount).toBe(450);
  });
});

describe('membership_jackpot_leaderboard — transformResult', () => {
  it('strips ST noise from nested leaderboard items, preserves envelope + semantic fields', () => {
    const raw = {
      leaderboard: [
        { rank: 1, count: 5, employeeId: 77, ...NOISE },
      ],
      anonymized: false,
      revealDate: '2026-07-04',
      _composite: 'membership_jackpot_leaderboard',
      _source: 'live',
    };
    const shaped: any = membership_jackpot_leaderboard.transformResult!(raw);
    expectNoiseStripped(shaped.leaderboard[0]);
    expect(shaped.leaderboard[0].rank).toBe(1);
    expect(shaped.leaderboard[0].count).toBe(5);
    expect(shaped._composite).toBe('membership_jackpot_leaderboard');
    expect(shaped._source).toBe('live');
    expect(shaped.anonymized).toBe(false);
    expect(shaped.revealDate).toBe('2026-07-04');
  });
});

describe('membership_outreach_list — transformResult', () => {
  it('strips ST noise from nested contact items, preserves envelope + semantic fields', () => {
    const raw = {
      segment: 'expiring_30',
      contacts: [
        {
          membershipId: 5001,
          customerId: 88,
          customerName: 'Acme Co',
          membershipType: 'Gold',
          expirationDate: '2026-08-01T00:00:00Z',
          status: 'Active',
          ...NOISE,
        },
      ],
      count: 1,
      _composite: 'membership_outreach_list',
      _source: 'live',
    };
    const shaped: any = membership_outreach_list.transformResult!(raw);
    expectNoiseStripped(shaped.contacts[0]);
    expect(shaped.contacts[0].membershipId).toBe(5001);
    expect(shaped.contacts[0].customerName).toBe('Acme Co');
    expect(shaped._composite).toBe('membership_outreach_list');
    expect(shaped._source).toBe('live');
    expect(shaped.segment).toBe('expiring_30');
    expect(shaped.count).toBe(1);
  });
});

describe('pricebook_health_check_services — transformResult', () => {
  it('strips ST noise from nested zeroCostServices items, preserves envelope + semantic fields', () => {
    const raw = {
      summary: {
        total: 10,
        zeroCostCount: 1,
        noCategoryCount: 0,
        inactiveCount: 0,
        healthy: false,
      },
      zeroCostServices: [
        { id: 9001, name: 'Mystery Service', ...NOISE },
      ],
      noCategoryServices: [],
      _composite: 'pricebook_health_check_services',
      _source: 'live',
      _note: 'pb_materials and pb_equipment health blocked until §13#1 nightly sync fix',
    };
    const shaped: any = pricebook_health_check_services.transformResult!(raw);
    expectNoiseStripped(shaped.zeroCostServices[0]);
    expect(shaped.zeroCostServices[0].id).toBe(9001);
    expect(shaped.zeroCostServices[0].name).toBe('Mystery Service');
    expect(shaped._composite).toBe('pricebook_health_check_services');
    expect(shaped._source).toBe('live');
    expect(shaped.summary).toEqual(raw.summary);
  });
});

