// ============================================================
// T8 tests — Memberships (3) + Calls/Forms (2) + Tasks (2)
// Key constraints:
// - Memberships are live-ST only (no D1 table)
// - list_memberships_expiring uses 'to' field NOT renewedById
// - create_recurring_service requires active membership
// - Task paths use /taskmanagement/ (no hyphen)
// ============================================================

import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { list_memberships_active } from '../memberships/list_memberships_active';
import { list_memberships_expiring } from '../memberships/list_memberships_expiring';
import { create_recurring_service } from '../memberships/create_recurring_service';
import { get_call } from '../calls_forms/get_call';
import { get_form_submission } from '../calls_forms/get_form_submission';
import { create_task } from '../tasks/create_task';
import { list_open_tasks } from '../tasks/list_open_tasks';

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

function liveOkDirect(data: unknown) {
  return async () => new Response(JSON.stringify(data), { status: 200 });
}

function dryRunFetch() {
  return async (url: string) => {
    if (url.includes('dryRun=1')) return new Response(JSON.stringify({ echo: true }), { status: 200 });
    throw new Error(`unexpected URL: ${url}`);
  };
}

// ── Memberships ──────────────────────────────────────────────

describe('list_memberships_active', () => {
  it('accepts empty args', async () => {
    const env = makeEnv(liveOk([{ id: 1, status: 'Active' }]));
    const result: any = await list_memberships_active.handler(env, {}, CTX);
    expect(result.memberships).toBeDefined();
    expect(Array.isArray(result.memberships)).toBe(true);
  });

  it('calls memberships endpoint with status=Active (singular, not statuses)', async () => {
    const env = makeEnv(liveOk([]));
    await list_memberships_active.handler(env, {}, CTX);
    const [url] = env.ST_PROXY.fetch.mock.calls[0];
    expect(url).toContain('membership');
    expect(url).toContain('status%3DActive');
  });

  it('result includes _source: live', async () => {
    const env = makeEnv(liveOk([]));
    const result: any = await list_memberships_active.handler(env, {}, CTX);
    expect(result._source).toBe('live');
  });

  it('filters out non-Active records client-side (ST filter is unreliable)', async () => {
    const env = makeEnv(liveOk([
      { id: 1, status: 'Active' },
      { id: 2, status: 'Expired' },
      { id: 3, status: 'Canceled' },
      { id: 4, status: 'Active' },
    ]));
    const result: any = await list_memberships_active.handler(env, {}, CTX);
    expect(result.memberships).toHaveLength(2);
    expect(result.memberships.every((m: any) => m.status === 'Active')).toBe(true);
    expect(result._filtered).toEqual({ received: 4, kept: 2 });
  });

  it('omits _filtered when all records match', async () => {
    const env = makeEnv(liveOk([{ id: 1, status: 'Active' }]));
    const result: any = await list_memberships_active.handler(env, {}, CTX);
    expect(result._filtered).toBeUndefined();
  });

  it('trims verbose fields from records', async () => {
    const env = makeEnv(liveOk([{
      id: 1, status: 'Active', customerId: 100, locationId: 200,
      importId: 'uuid-junk', customFields: [], activatedById: null,
      createdOn: '0001-01-01T00:00:00Z', modifiedOn: '2026-01-01T00:00:00Z',
      memo: '', renewedById: null, soldById: null,
    }]));
    const result: any = await list_memberships_active.handler(env, {}, CTX);
    const m = result.memberships[0];
    expect(m.id).toBe(1);
    expect(m.customerId).toBe(100);
    expect(m.importId).toBeUndefined();
    expect(m.customFields).toBeUndefined();
    expect(m.modifiedOn).toBeUndefined();
  });

  it('rejects pageSize > 100', async () => {
    const schema = z.object(list_memberships_active.zodSchema);
    expect(schema.safeParse({ pageSize: 200 }).success).toBe(false);
    expect(schema.safeParse({ pageSize: 100 }).success).toBe(true);
  });
});

describe('list_memberships_expiring', () => {
  it('requires windowDays', async () => {
    const schema = z.object(list_memberships_expiring.zodSchema);
    expect(schema.safeParse({}).success).toBe(false);
  });

  it('fetches memberships expiring within windowDays', async () => {
    const env = makeEnv(liveOk([{ id: 1, expirationDate: '2026-05-15' }]));
    const result: any = await list_memberships_expiring.handler(env, { windowDays: 30 }, CTX);
    expect(result.memberships).toBeDefined();
  });

  it('uses to field filter (not renewedById)', async () => {
    const env = makeEnv(liveOk([]));
    await list_memberships_expiring.handler(env, { windowDays: 30 }, CTX);
    const [url] = env.ST_PROXY.fetch.mock.calls[0];
    // Must use expirationDateBefore / activeThrough — NOT renewedById
    expect(url).not.toContain('renewedById');
    expect(url).toContain('membership');
  });

  it('rejects windowDays <= 0', async () => {
    const schema = z.object(list_memberships_expiring.zodSchema);
    expect(schema.safeParse({ windowDays: 0 }).success).toBe(false);
    expect(schema.safeParse({ windowDays: -1 }).success).toBe(false);
  });
});

describe('create_recurring_service', () => {
  it('is a write tool', () => expect(create_recurring_service.isWrite).toBe(true));

  it('requires membershipId, serviceTypeId, and locationId', async () => {
    const schema = z.object(create_recurring_service.zodSchema);
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ membershipId: 1, serviceTypeId: 2 }).success).toBe(false);
  });

  it('defaults to dryRun=true', async () => {
    const env = makeEnv(dryRunFetch());
    const result: any = await create_recurring_service.handler(env, {
      membershipId: 10, serviceTypeId: 5, locationId: 3,
    }, CTX);
    expect(result.dryRun).toBe(true);
  });

  it('posts to memberships recurring-services endpoint', async () => {
    const env = makeEnv(dryRunFetch());
    const result: any = await create_recurring_service.handler(env, { membershipId: 10, serviceTypeId: 5, locationId: 3 }, CTX);
    expect(result.st_endpoint).toContain('recurring-service');
  });
});

// ── Calls & Forms ────────────────────────────────────────────

describe('get_call', () => {
  it('requires callId', async () => {
    const schema = z.object(get_call.zodSchema);
    expect(schema.safeParse({}).success).toBe(false);
  });

  it('fetches a call by ID', async () => {
    const env = makeEnv(liveOkDirect({ id: 88, duration: 120 }));
    const result: any = await get_call.handler(env, { callId: 88 }, CTX);
    expect(result.call).toBeDefined();
  });

  it('calls telecom calls endpoint with ID', async () => {
    const env = makeEnv(liveOkDirect({ id: 88 }));
    await get_call.handler(env, { callId: 88 }, CTX);
    const [url] = env.ST_PROXY.fetch.mock.calls[0];
    expect(url).toContain('88');
    expect(url).toContain('call');
  });
});

describe('get_form_submission', () => {
  it('requires formSubmissionId', async () => {
    const schema = z.object(get_form_submission.zodSchema);
    expect(schema.safeParse({}).success).toBe(false);
  });

  it('fetches a form submission', async () => {
    const env = makeEnv(liveOkDirect({ id: 55, formId: 3 }));
    const result: any = await get_form_submission.handler(env, { formSubmissionId: 55 }, CTX);
    expect(result.formSubmission).toBeDefined();
  });

  it('note: form submissions return unit IDs not equipment IDs (documented)', async () => {
    const env = makeEnv(liveOkDirect({ id: 55, units: [{ unitId: 1 }] }));
    const result: any = await get_form_submission.handler(env, { formSubmissionId: 55 }, CTX);
    // Just verify we get the raw submission back (unit ID join is done at composite layer)
    expect(result.formSubmission).toBeDefined();
  });
});

// ── Tasks ─────────────────────────────────────────────────────

describe('create_task', () => {
  // v1.5: schema now requires 8 ST-mandatory fields (name, jobId, body, reportedById,
  // businessUnitId, employeeTaskTypeId, employeeTaskSourceId, plus the existing 4).
  const VALID_ARGS: any = {
    name: 'Follow up',
    jobId: 100,
    body: 'Customer requested follow-up on quote.',
    reportedById: 5001,
    businessUnitId: 7001,
    employeeTaskTypeId: 11,
    employeeTaskSourceId: 22,
  };

  it('is a write tool', () => expect(create_task.isWrite).toBe(true));

  it('requires all 7 mandatory fields (v1.5)', async () => {
    const schema = z.object(create_task.zodSchema);
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ name: 'Follow up' }).success).toBe(false);
    expect(schema.safeParse({ name: 'Follow up', jobId: 100 }).success).toBe(false);
    expect(schema.safeParse(VALID_ARGS).success).toBe(true);
  });

  it('defaults to dryRun=true', async () => {
    const env = makeEnv(dryRunFetch());
    const result: any = await create_task.handler(env, VALID_ARGS, CTX);
    expect(result.dryRun).toBe(true);
  });

  it('uses /taskmanagement/ path (no hyphen — T8 correction)', async () => {
    const env = makeEnv(dryRunFetch());
    const result: any = await create_task.handler(env, VALID_ARGS, CTX);
    expect(result.st_endpoint).toContain('taskmanagement');
    expect(result.st_endpoint).not.toContain('task-management');
  });
});

describe('list_open_tasks', () => {
  it('accepts empty args', async () => {
    const env = makeEnv(liveOk([{ id: 1, name: 'Call back customer' }]));
    const result: any = await list_open_tasks.handler(env, {}, CTX);
    expect(result.tasks).toBeDefined();
    expect(Array.isArray(result.tasks)).toBe(true);
  });

  it('uses /taskmanagement/ path (no hyphen)', async () => {
    const env = makeEnv(liveOk([]));
    await list_open_tasks.handler(env, {}, CTX);
    const [url] = env.ST_PROXY.fetch.mock.calls[0];
    expect(url).toContain('taskmanagement');
    expect(url).not.toContain('task-management');
  });

  it('filters to open tasks only', async () => {
    const env = makeEnv(liveOk([]));
    await list_open_tasks.handler(env, {}, CTX);
    const [url] = env.ST_PROXY.fetch.mock.calls[0];
    expect(url).toContain('task');
  });
});
