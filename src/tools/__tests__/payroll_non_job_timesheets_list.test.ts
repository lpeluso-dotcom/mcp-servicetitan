// ============================================================
// payroll_non_job_timesheets_list.test.ts
//
// Covers the Phase-3 defect fix (live-verified 2026-07-09 against ST
// tenant 431848990):
//
//   - The raw ST row has NO date/hours/activityCodeId/notes fields — it's
//     { id, employeeId, employeeType, timesheetCodeId, startedOn, endedOn,
//       createdOn, modifiedOn, active }. The old slim() mapper read fields
//     that don't exist, producing date:null/hours:0/activity_code_id:null
//     on every row.
//   - employeeId (singular) 409s ("Employee type was not specified").
//   - Live re-probe of the prescribed fix (send employeeIds plural) on
//     2026-07-09 CONTRADICTED the "verified" claim: employeeIds (and
//     technicianId/technicianIds/ids, singular and plural) are silently
//     ignored — ST returns the byte-identical unfiltered page regardless
//     of value (tested employeeIds=15362, 15617, 999999999, comma-joined,
//     bracket form — all identical to the unfiltered baseline). Same for
//     timesheetCodeId/timesheetCodeIds. Per the "STOP and report rather
//     than guessing" rule, this tool now REJECTS employeeId/timesheetCodeId
//     with a clear validation_error instead of either 409ing or silently
//     returning an unfiltered page that looks filtered.
//   - startsOnOrAfter/endsOnOrBefore are ignored by this endpoint;
//     modifiedOnOrAfter/modifiedOnOrBefore are honored. fromDate/toDate now
//     map to those.
// ============================================================

import { describe, it, expect, vi } from 'vitest';
import { payroll_non_job_timesheets_list } from '../payroll/payroll_non_job_timesheets_list';
import { assertFilterPreservation } from './filter_preservation_helper';

function fakeEnv() {
  const fetcher = vi.fn(async () =>
    new Response(
      JSON.stringify({
        data: [
          {
            id: 400,
            employeeId: 42,
            employeeType: 'Technician',
            timesheetCodeId: 8,
            startedOn: '2024-04-10T09:00:00Z',
            endedOn: '2024-04-10T11:30:00Z',
            createdOn: '2024-04-10T11:31:00Z',
            modifiedOn: '2024-04-10T11:31:00Z',
            active: true,
          },
          {
            id: 401,
            // employeeId, employeeType, timesheetCodeId, startedOn, endedOn
            // intentionally omitted
            active: true,
          },
        ],
        hasMore: false,
      }),
      { status: 200 },
    ),
  );
  return {
    ST_TENANT_ID: '000000000',
    ST_PROXY: { fetch: fetcher },
    MCP_SYNC_KEY: 'k',
  } as any;
}

describe('payroll_non_job_timesheets_list — mapper (real ST field shape)', () => {
  it('maps startedOn/endedOn/employeeType/timesheetCodeId and computes hours', async () => {
    const env = fakeEnv();
    const out = (await payroll_non_job_timesheets_list.handler(
      env,
      {},
      { actor: 'test', correlation: 'c1' },
    )) as any;
    expect(out.count).toBe(2);
    expect(out.timesheets[0]).toEqual({
      id: 400,
      employee_id: 42,
      employee_type: 'Technician',
      timesheet_code_id: 8,
      started_on: '2024-04-10T09:00:00Z',
      ended_on: '2024-04-10T11:30:00Z',
      hours: 2.5,
    });
    expect(out.timesheets[0].notes).toBeUndefined();
    expect(out.timesheets[0].date).toBeUndefined();
    expect(out.timesheets[0].activity_code_id).toBeUndefined();
  });

  it('defaults missing fields to null / 0 hours', async () => {
    const env = fakeEnv();
    const out = (await payroll_non_job_timesheets_list.handler(
      env,
      {},
      { actor: 'test', correlation: 'c1' },
    )) as any;
    expect(out.timesheets[1]).toEqual({
      id: 401,
      employee_id: null,
      employee_type: null,
      timesheet_code_id: null,
      started_on: null,
      ended_on: null,
      hours: 0,
    });
  });

  it('computes 2.5 hours from a raw row with a 2h30m startedOn/endedOn span', async () => {
    const env = {
      ST_TENANT_ID: '000000000',
      ST_PROXY: {
        fetch: vi.fn(async () =>
          new Response(
            JSON.stringify({
              data: [
                {
                  id: 999,
                  employeeId: 7,
                  employeeType: 'Technician',
                  timesheetCodeId: 103,
                  startedOn: '2024-01-01T09:00:00Z',
                  endedOn: '2024-01-01T11:30:00Z',
                },
              ],
              hasMore: false,
            }),
            { status: 200 },
          ),
        ),
      },
      MCP_SYNC_KEY: 'k',
    } as any;
    const out = (await payroll_non_job_timesheets_list.handler(
      env,
      {},
      { actor: 'test', correlation: 'c1' },
    )) as any;
    expect(out.timesheets[0].hours).toBe(2.5);
    expect(out.timesheets[0].timesheet_code_id).toBe(103);
    expect(out.timesheets[0].employee_type).toBe('Technician');
  });

  it('returns hours 0 when startedOn/endedOn is missing or out of order', async () => {
    const env = {
      ST_TENANT_ID: '000000000',
      ST_PROXY: {
        fetch: vi.fn(async () =>
          new Response(
            JSON.stringify({
              data: [
                { id: 1, startedOn: '2024-01-01T09:00:00Z' }, // no endedOn
                { id: 2, endedOn: '2024-01-01T09:00:00Z' }, // no startedOn
                { id: 3, startedOn: '2024-01-01T11:00:00Z', endedOn: '2024-01-01T09:00:00Z' }, // reversed
              ],
              hasMore: false,
            }),
            { status: 200 },
          ),
        ),
      },
      MCP_SYNC_KEY: 'k',
    } as any;
    const out = (await payroll_non_job_timesheets_list.handler(
      env,
      {},
      { actor: 'test', correlation: 'c1' },
    )) as any;
    expect(out.timesheets.map((t: any) => t.hours)).toEqual([0, 0, 0]);
  });
});

describe('payroll_non_job_timesheets_list — filter preservation', () => {
  it('maps fromDate/toDate to modifiedOnOrAfter/modifiedOnOrBefore (ST ignores startsOnOrAfter/endsOnOrBefore on this endpoint)', async () => {
    await assertFilterPreservation(payroll_non_job_timesheets_list, {
      fromDate: { value: '2024-04-01', expect: 'forwarded_query', key: 'modifiedOnOrAfter' },
      toDate: { value: '2024-04-30', expect: 'forwarded_query', key: 'modifiedOnOrBefore' },
    });
  });

  it('rejects employeeId — ST has no working employee filter on this endpoint (409 singular, silently-ignored plural, live-verified 2026-07-09)', async () => {
    await assertFilterPreservation(payroll_non_job_timesheets_list, {
      employeeId: { value: 42, expect: 'rejected_or_skipped' },
    });
  });

  it('rejects timesheetCodeId — ST silently ignores timesheetCodeId/timesheetCodeIds on this endpoint (live-verified 2026-07-09)', async () => {
    await assertFilterPreservation(payroll_non_job_timesheets_list, {
      timesheetCodeId: { value: 103, expect: 'rejected_or_skipped' },
    });
  });
});

describe('payroll_non_job_timesheets_list — legacy behavior', () => {
  it('throws McpError on upstream failure', async () => {
    const env = {
      ST_TENANT_ID: '000000000',
      ST_PROXY: { fetch: vi.fn(async () => new Response('', { status: 502 })) },
      MCP_SYNC_KEY: 'k',
    } as any;
    await expect(
      payroll_non_job_timesheets_list.handler(env, {}, { actor: 'test', correlation: 'c1' }),
    ).rejects.toThrow(/readST 502 on \/payroll\/v2\/tenant\/.+\/non-job-timesheets/);
  });

  it('returns count=0 and timesheets=[] when ST returns empty data', async () => {
    const env = {
      ST_TENANT_ID: '000000000',
      ST_PROXY: {
        fetch: vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })),
      },
      MCP_SYNC_KEY: 'k',
    } as any;
    const out = (await payroll_non_job_timesheets_list.handler(
      env,
      {},
      { actor: 'test', correlation: 'c1' },
    )) as any;
    expect(out.count).toBe(0);
    expect(out.timesheets).toEqual([]);
  });
});
