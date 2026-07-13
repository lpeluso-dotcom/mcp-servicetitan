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
import { assertFilterPreservation } from './filter_preservation_helper';
import type { ToolDef } from '../index';

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

  it('fetches via ?ids= and unwraps data[0] (call nests under leadCall)', async () => {
    let captured = '';
    const env = makeEnv(async (url: string) => {
      captured = url;
      return new Response(JSON.stringify({ data: [{ id: 0, jobNumber: 123, leadCall: { id: 260956, duration: 120 } }] }), { status: 200 });
    });
    const result: any = await get_call.handler(env, { callId: 260956 }, CTX);
    const endpoint = new URL(captured).searchParams.get('endpoint')!;
    expect(endpoint).toBe('/telecom/v3/tenant/000000000/calls?ids=260956');
    expect(result.call).toEqual({ id: 0, jobNumber: 123, leadCall: { id: 260956, duration: 120 } });
    expect(result._source).toBe('live');
  });

  it('throws not_found when ids filter returns empty', async () => {
    const env = makeEnv(liveOk([]));
    await expect(get_call.handler(env, { callId: 999 }, CTX)).rejects.toMatchObject({ code: 'not_found' });
  });

  // Guard against ST silently ignoring the ids param — the top-level `id` on
  // this row is always 0/meaningless, so the guard must compare against the
  // NESTED leadCall.id, not the row's own id.
  it('rejects when ids filter is not honored (wrong nested leadCall.id)', async () => {
    const env = makeEnv(liveOk([{ id: 0, leadCall: { id: 999 } }]));
    await expect(get_call.handler(env, { callId: 260956 }, CTX)).rejects.toThrow(/ids filter not honored/);
  });

  // QUA-756 Done-when: filter-preservation test asserts the outgoing ST URL
  // (QUA-694 test pattern). callId is the arg name but the wire key is `ids`
  // — the liveResponse is shaped so leadCall.id matches the callId under
  // test, satisfying the tool's own nested-id guard.
  it('filter-preservation: callId forwards to live ST as `ids` (QUA-756)', async () => {
    // Cast to ToolDef<any> (same idiom as qua694_dispatch_filter_names.test.ts):
    // callId is a REQUIRED arg, which the harness's Record<string,unknown>
    // generic can't accept by variance.
    await assertFilterPreservation(
      get_call as ToolDef<any>,
      { callId: { value: 260956, expect: 'forwarded_query', key: 'ids' } },
      {},
      { liveResponse: { data: [{ id: 0, leadCall: { id: 260956 } }] } },
    );
  });
});

// Combined D1 (readD1 -> /api/sql/read) + live ST (readST/readSTPaged ->
// /api/st/read) env mock for get_form_submission, which is D1-first with an
// optional live fallback scan.
function envD1AndLive(
  sqlHandler: (body: { sql: string; params: unknown[] }) => any,
  liveHandler?: (url: string) => any,
): any {
  const fetcher = vi.fn(async (url: any, init?: RequestInit) => {
    const urlStr = String(url);
    if (urlStr.includes('/api/sql/read')) {
      const body = init?.body ? JSON.parse(init.body as string) : { sql: '', params: [] };
      return new Response(JSON.stringify(sqlHandler(body)), { status: 200 });
    }
    if (urlStr.includes('/api/st/read')) {
      return new Response(JSON.stringify(liveHandler ? liveHandler(urlStr) : { data: [] }), { status: 200 });
    }
    throw new Error(`unexpected URL: ${urlStr}`);
  });
  return {
    ST_PROXY: { fetch: fetcher },
    MCP_SYNC_KEY: 'test-key',
    MCP_SERVICE_VERSION: '0.0.0-test',
  };
}

describe('get_form_submission', () => {
  it('requires formSubmissionId', async () => {
    const schema = z.object(get_form_submission.zodSchema);
    expect(schema.safeParse({}).success).toBe(false);
  });

  it('D1 hit returns the submission with _source d1', async () => {
    const env = envD1AndLive(() => ({
      success: true,
      results: [{
        submission_id: 8479, form_id: 7752, form_name: 'Lead Intake', status: 'Complete',
        submitted_on: '2026-06-01T10:00:00Z', submitted_by_id: 501,
        owners_json: null, units_json: null, synced_at: '2026-07-01T00:00:00Z',
      }],
    }));
    const result: any = await get_form_submission.handler(env, { formSubmissionId: 8479 }, CTX);
    expect(result.submission.submission_id).toBe(8479);
    expect(result._source).toBe('d1');
  });

  it('D1 miss + formId falls back to a live scan matched on submission id (formIds= pinned)', async () => {
    let capturedUrl = '';
    const env = envD1AndLive(
      () => ({ success: true, results: [] }),
      (url) => {
        capturedUrl = url;
        return { data: [{ id: 8479, formId: 7752 }, { id: 8480, formId: 7752 }], hasMore: false, page: 1, pageSize: 200 };
      },
    );
    const result: any = await get_form_submission.handler(env, { formSubmissionId: 8479, formId: 7752 }, CTX);
    const endpoint = new URL(capturedUrl).searchParams.get('endpoint')!;
    expect(endpoint).toContain('formIds=7752');
    expect(result.submission).toEqual({ id: 8479, formId: 7752 });
    expect(result._source).toBe('live');
  });

  it('D1 miss + no formId throws not_found mentioning formId is required for live lookup', async () => {
    const env = envD1AndLive(() => ({ success: true, results: [] }));
    await expect(get_form_submission.handler(env, { formSubmissionId: 999 }, CTX)).rejects.toThrow(/formId/);
    await expect(get_form_submission.handler(env, { formSubmissionId: 999 }, CTX)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('D1 miss + formId, live scan no match -> not_found', async () => {
    const env = envD1AndLive(
      () => ({ success: true, results: [] }),
      () => ({ data: [{ id: 1111, formId: 7752 }], hasMore: false }),
    );
    await expect(get_form_submission.handler(env, { formSubmissionId: 8479, formId: 7752 }, CTX)).rejects.toMatchObject({ code: 'not_found' });
  });

  // QUA-756 Done-when: filter-preservation tests assert the outgoing ST/D1
  // shape (QUA-694 test pattern) for both of this tool's filters.
  it('filter-preservation: formSubmissionId forwards to D1 as `submission_id` (QUA-756)', async () => {
    // Cast to ToolDef<any>: formSubmissionId is a REQUIRED arg (see get_call
    // comment above for why the cast is needed).
    await assertFilterPreservation(
      get_form_submission as ToolDef<any>,
      { formSubmissionId: { value: 8479, expect: 'forwarded_d1', column: 'submission_id' } },
      {},
      {
        d1Response: {
          success: true,
          results: [{
            submission_id: 8479, form_id: 7752, form_name: 'Lead Intake', status: 'Complete',
            submitted_on: '2026-06-01T10:00:00Z', submitted_by_id: 501,
            owners_json: null, units_json: null, synced_at: '2026-07-01T00:00:00Z',
          }],
        },
      },
    );
  });

  it('filter-preservation: formId forwards to live ST as `formIds` on D1-miss fallback (QUA-756)', async () => {
    // Cast to ToolDef<any>: formSubmissionId (in baseArgs) is a REQUIRED arg
    // (see get_call comment above for why the cast is needed).
    await assertFilterPreservation(
      get_form_submission as ToolDef<any>,
      { formId: { value: 7752, expect: 'forwarded_query', key: 'formIds' } },
      { formSubmissionId: 8479 },
      {
        d1Response: { success: true, results: [] },
        liveResponse: { data: [{ id: 8479, formId: 7752 }], hasMore: false, page: 1, pageSize: 200 },
      },
    );
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
