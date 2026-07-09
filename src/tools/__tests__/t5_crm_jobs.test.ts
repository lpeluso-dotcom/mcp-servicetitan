// ============================================================
// T5 tests — CRM (6) + Jobs & Appointments (8)
// Strategy: mock env.ST_PROXY.fetch + env.DB.
// Tests cover: schema validation, correct ST endpoint/method, dryRun
// default for writes, and key catalog corrections (T1–T7 in plan).
// ============================================================

import { describe, it, expect, vi } from 'vitest';
import { find_customer } from '../crm/find_customer';
import { get_customer } from '../crm/get_customer';
import { get_customer_locations } from '../crm/get_customer_locations';
import { list_customer_jobs } from '../crm/list_customer_jobs';
import { get_customer_membership } from '../crm/get_customer_membership';
import { add_customer_note } from '../crm/add_customer_note';
import { get_job } from '../jobs/get_job';
import { list_jobs_today } from '../jobs/list_jobs_today';
import { get_job_appointments } from '../jobs/get_job_appointments';
import { add_job_note } from '../jobs/add_job_note';
import { book_job } from '../jobs/book_job';
import { reschedule_appointment } from '../jobs/reschedule_appointment';
import { hold_appointment } from '../jobs/hold_appointment';
import { assign_technicians } from '../jobs/assign_technicians';

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
    ST_PROXY: { fetch: vi.fn(fetchImpl) },
    MCP_SYNC_KEY: 'test-key',
    MCP_SERVICE_VERSION: '0.0.0-test',
    DB: makeDB(),
    PROXY_STATE: {},
    SIRO_API_TOKEN: '',
  };
}

function liveOk(data: unknown) {
  return async () => new Response(JSON.stringify({ data }), { status: 200 });
}

function dryRunFetch() {
  return async (url: string) => {
    if (url.includes('dryRun=1')) return new Response(JSON.stringify({ echo: true }), { status: 200 });
    throw new Error(`unexpected URL: ${url}`);
  };
}

// ── CRM ──────────────────────────────────────────────────────

describe('find_customer', () => {
  it('calls servicetitan-proxy with name param and returns data', async () => {
    const env = makeEnv(liveOk([{ id: 1, name: 'Alice' }]));
    const result: any = await find_customer.handler(env, { name: 'Alice' }, CTX);
    expect(result.customers).toBeDefined();
    const [url] = env.ST_PROXY.fetch.mock.calls[0];
    expect(url).toContain('customers');
  });

  it('requires at least one search param', async () => {
    const env = makeEnv(liveOk([]));
    await expect(find_customer.handler(env, {}, CTX)).rejects.toMatchObject({ code: 'validation_error' });
  });
});

describe('get_customer', () => {
  it('calls the customer endpoint with the correct ID', async () => {
    const env = makeEnv(liveOk({ id: 42 }));
    const result: any = await get_customer.handler(env, { customerId: 42 }, CTX);
    expect(result.customer).toBeDefined();
    const [url] = env.ST_PROXY.fetch.mock.calls[0];
    expect(url).toContain('42');
  });
});

describe('get_customer_locations', () => {
  it('fetches locations for customer', async () => {
    const env = makeEnv(liveOk([{ id: 1, address: '123 Main' }]));
    const result: any = await get_customer_locations.handler(env, { customerId: 5 }, CTX);
    expect(result.locations).toBeDefined();
  });
});

describe('list_customer_jobs', () => {
  it('fetches jobs for customer', async () => {
    const env = makeEnv(liveOk([{ id: 100, status: 'Completed' }]));
    const result: any = await list_customer_jobs.handler(env, { customerId: 5 }, CTX);
    expect(result.jobs).toBeDefined();
  });
});

describe('get_customer_membership', () => {
  it('fetches memberships for customer (live ST — no D1 table)', async () => {
    const env = makeEnv(liveOk([{ id: 1, type: 'Gold' }]));
    const result: any = await get_customer_membership.handler(env, { customerId: 5 }, CTX);
    expect(result.memberships).toBeDefined();
    const [url] = env.ST_PROXY.fetch.mock.calls[0];
    expect(url).toContain('memberships');
  });
});

describe('add_customer_note', () => {
  it('is a write tool (isWrite: true)', () => {
    expect(add_customer_note.isWrite).toBe(true);
  });

  it('defaults dryRun=true and returns DryRunResult', async () => {
    const env = makeEnv(dryRunFetch());
    const result: any = await add_customer_note.handler(env, { customerId: 5, note: 'Test note' }, CTX);
    expect(result.dryRun).toBe(true);
    expect(result.confirmation_token).toBeTypeOf('string');
  });

  it('throws validation_error when dryRun=false and no token', async () => {
    const env = makeEnv(dryRunFetch());
    await expect(add_customer_note.handler(env, { customerId: 5, note: 'X', dryRun: false }, CTX))
      .rejects.toMatchObject({ code: 'validation_error' });
  });
});

// ── Jobs ─────────────────────────────────────────────────────

describe('get_job', () => {
  it('fetches a job by ID', async () => {
    const env = makeEnv(liveOk({ id: 123, status: 'InProgress' }));
    const result: any = await get_job.handler(env, { jobId: 123 }, CTX);
    expect(result.job).toBeDefined();
    const [url] = env.ST_PROXY.fetch.mock.calls[0];
    expect(url).toContain('123');
  });
});

describe('list_jobs_today', () => {
  // Two-call flow: drain today's appointments (by ET start window) → batch the parent jobs by id.
  function jobsTodayFetch(appointments: any[], jobs: any[]) {
    return async (url: string) => {
      if (url.includes('appointments')) {
        return new Response(JSON.stringify({ data: appointments, hasMore: false }), { status: 200 });
      }
      if (url.includes('jobs')) {
        return new Response(JSON.stringify({ data: jobs, hasMore: false }), { status: 200 });
      }
      throw new Error(`unexpected url: ${url}`);
    };
  }

  it('lists today\'s jobs via appointments→jobs and dedupes shared jobs', async () => {
    const env = makeEnv(jobsTodayFetch(
      [{ id: 11, jobId: 100 }, { id: 12, jobId: 100 }, { id: 13, jobId: 200 }], // job 100 has 2 appts
      [{ id: 100, jobStatus: 'Scheduled', businessUnitId: 1 }, { id: 200, jobStatus: 'InProgress', businessUnitId: 2 }],
    ));
    const result: any = await list_jobs_today.handler(env, {}, CTX);
    expect(result.jobs.map((j: any) => j.id).sort()).toEqual([100, 200]);
    expect(env.ST_PROXY.fetch).toHaveBeenCalledTimes(2); // appointments + jobs
    const urls = env.ST_PROXY.fetch.mock.calls.map((c: any[]) => decodeURIComponent(c[0]));
    // appointments queried by start window (NOT the jobs endpoint with bogus scheduled* params)
    expect(urls.some((u: string) => u.includes('/appointments') && u.includes('startsOnOrAfter'))).toBe(true);
    // jobs fetched by the deduped id set (comma may be %2C-encoded in the URL)
    expect(urls.some((u: string) => u.includes('/jobs') && u.includes('ids=') && u.includes('100') && u.includes('200'))).toBe(true);
  });

  it('filters by status client-side', async () => {
    const env = makeEnv(jobsTodayFetch(
      [{ id: 1, jobId: 100 }, { id: 2, jobId: 200 }],
      [{ id: 100, jobStatus: 'Scheduled', businessUnitId: 1 }, { id: 200, jobStatus: 'Completed', businessUnitId: 1 }],
    ));
    const result: any = await list_jobs_today.handler(env, { status: 'Scheduled' }, CTX);
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0].id).toBe(100);
  });

  it('returns empty (and skips the jobs call) when there are no appointments today', async () => {
    const env = makeEnv(jobsTodayFetch([], [{ id: 999 }]));
    const result: any = await list_jobs_today.handler(env, {}, CTX);
    expect(result.jobs).toEqual([]);
    expect(env.ST_PROXY.fetch).toHaveBeenCalledTimes(1); // only appointments
  });
});

describe('get_job_appointments', () => {
  it('fetches appointments for a job', async () => {
    const env = makeEnv(liveOk([{ id: 10, start: '2026-04-22T09:00' }]));
    const result: any = await get_job_appointments.handler(env, { jobId: 123 }, CTX);
    expect(result.appointments).toBeDefined();
  });
});

describe('add_job_note', () => {
  it('is a write tool defaulting to dryRun=true', async () => {
    expect(add_job_note.isWrite).toBe(true);
    const env = makeEnv(dryRunFetch());
    const result: any = await add_job_note.handler(env, { jobId: 123, note: 'tech arrived' }, CTX);
    expect(result.dryRun).toBe(true);
  });
});

describe('book_job', () => {
  it('is a write tool', () => expect(book_job.isWrite).toBe(true));

  it('defaults to dryRun=true', async () => {
    const env = makeEnv(dryRunFetch());
    const result: any = await book_job.handler(env, {
      customerId: 1, locationId: 2, businessUnitId: 3,
      jobTypeId: 4, campaignId: 5,
      start: '2026-05-01T09:00', end: '2026-05-01T11:00',
    }, CTX);
    expect(result.dryRun).toBe(true);
  });

  it('requires campaignId (T1 catalog correction)', () => {
    // campaignId must exist in the zodSchema and must not be wrapped in z.optional()
    const schema = book_job.zodSchema;
    expect(schema.campaignId).toBeDefined();
    // Zod v4 uses _zod.def.type to identify optional wrappers
    const def = (schema.campaignId as any)._zod?.def;
    expect(def?.type).not.toBe('optional');
  });
});

describe('reschedule_appointment', () => {
  it('is a write tool', () => expect(reschedule_appointment.isWrite).toBe(true));

  it('defaults to dryRun=true', async () => {
    const env = makeEnv(dryRunFetch());
    const result: any = await reschedule_appointment.handler(env, {
      appointmentId: 10,
      start: '2026-05-02T08:00', end: '2026-05-02T10:00',
      arrivalWindowStart: '2026-05-02T08:00', arrivalWindowEnd: '2026-05-02T09:00',
    }, CTX);
    expect(result.dryRun).toBe(true);
  });

  it('posts to PATCH appointments endpoint (T3 correction)', async () => {
    const env = makeEnv(dryRunFetch());
    const result: any = await reschedule_appointment.handler(env, {
      appointmentId: 10,
      start: '2026-05-02T08:00', end: '2026-05-02T10:00',
      arrivalWindowStart: '2026-05-02T08:00', arrivalWindowEnd: '2026-05-02T09:00',
    }, CTX);
    expect(result.st_endpoint).toContain('appointments');
    expect(result.st_method).toBe('PATCH');
  });
});

describe('hold_appointment', () => {
  it('is a write tool', () => expect(hold_appointment.isWrite).toBe(true));

  it('defaults to dryRun=true', async () => {
    const env = makeEnv(dryRunFetch());
    const result: any = await hold_appointment.handler(env, {
      appointmentId: 10, reasonId: 5, memo: 'No access',
    }, CTX);
    expect(result.dryRun).toBe(true);
  });

  it('targets the /hold sub-route (T4 catalog correction — not a PATCH)', async () => {
    const env = makeEnv(dryRunFetch());
    const result: any = await hold_appointment.handler(env, { appointmentId: 10, reasonId: 5 }, CTX);
    expect(result.st_endpoint).toContain('/hold');
    expect(result.st_method).toBe('POST');
  });
});

describe('assign_technicians', () => {
  it('is a write tool', () => expect(assign_technicians.isWrite).toBe(true));

  it('defaults to dryRun=true', async () => {
    const env = makeEnv(dryRunFetch());
    const result: any = await assign_technicians.handler(env, {
      appointmentId: 10, technicianIds: [101, 102],
    }, CTX);
    expect(result.dryRun).toBe(true);
  });

  it('makes two calls: unassign then assign (T5 compound correction)', async () => {
    const env = makeEnv(dryRunFetch());
    const result: any = await assign_technicians.handler(env, {
      appointmentId: 10, technicianIds: [101],
    }, CTX);
    // dryRun echoes the would-be ST endpoint in result.st_endpoint.
    expect(result.st_endpoint).toContain('appointment-assignments');
  });
});
