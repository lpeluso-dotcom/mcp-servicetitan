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
//     timesheetCodeId/timesheetCodeIds. Per code-review, this mirrors the
//     established list_unpaid_invoices.ts pattern for a genuinely-broken ST
//     filter: fetch the (unfiltered) page and filter employeeId/
//     timesheetCodeId CLIENT-SIDE, with a documented completeness caveat
//     (page/pageSize still apply server-side to the unfiltered set, so a
//     page can come back with fewer matches — or zero — than pageSize even
//     when more exist on other pages). Neither arg is ever forwarded to ST.
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
});

// Mixed-employee/mixed-timesheet-code page used by the client-side filter
// tests below. ST has no working server-side filter for either dimension
// (verified live 2026-07-09 — see header note), so the tool fetches this
// page unfiltered and filters employeeId/timesheetCodeId itself, mirroring
// list_unpaid_invoices.ts's balance!=0 client-side filter pattern.
function mixedPageEnv() {
  const fetcher = vi.fn(async () =>
    new Response(
      JSON.stringify({
        data: [
          { id: 1, employeeId: 42, timesheetCodeId: 8, startedOn: '2024-04-10T09:00:00Z', endedOn: '2024-04-10T10:00:00Z' },
          { id: 2, employeeId: 42, timesheetCodeId: 9, startedOn: '2024-04-10T09:00:00Z', endedOn: '2024-04-10T10:00:00Z' },
          { id: 3, employeeId: 43, timesheetCodeId: 8, startedOn: '2024-04-10T09:00:00Z', endedOn: '2024-04-10T10:00:00Z' },
          { id: 4, employeeId: 43, timesheetCodeId: 9, startedOn: '2024-04-10T09:00:00Z', endedOn: '2024-04-10T10:00:00Z' },
        ],
        hasMore: true,
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

describe('payroll_non_job_timesheets_list — client-side employeeId/timesheetCodeId filtering', () => {
  it('filters to only rows matching employeeId', async () => {
    const env = mixedPageEnv();
    const out = (await payroll_non_job_timesheets_list.handler(
      env,
      { employeeId: 42 },
      { actor: 'test', correlation: 'c1' },
    )) as any;
    expect(out.timesheets.map((t: any) => t.id)).toEqual([1, 2]);
    expect(out.count).toBe(2);
  });

  it('filters to only rows matching timesheetCodeId', async () => {
    const env = mixedPageEnv();
    const out = (await payroll_non_job_timesheets_list.handler(
      env,
      { timesheetCodeId: 8 },
      { actor: 'test', correlation: 'c1' },
    )) as any;
    expect(out.timesheets.map((t: any) => t.id)).toEqual([1, 3]);
    expect(out.count).toBe(2);
  });

  it('ANDs employeeId + timesheetCodeId when both are given', async () => {
    const env = mixedPageEnv();
    const out = (await payroll_non_job_timesheets_list.handler(
      env,
      { employeeId: 42, timesheetCodeId: 8 },
      { actor: 'test', correlation: 'c1' },
    )) as any;
    expect(out.timesheets.map((t: any) => t.id)).toEqual([1]);
    expect(out.count).toBe(1);
  });

  it('never forwards employeeId/timesheetCodeId to ST — filtering is client-side only', async () => {
    const env = mixedPageEnv();
    await payroll_non_job_timesheets_list.handler(
      env,
      { employeeId: 42, timesheetCodeId: 8 },
      { actor: 'test', correlation: 'c1' },
    );
    const calledUrl = (env.ST_PROXY.fetch as any).mock.calls[0][0];
    expect(calledUrl).not.toContain('employeeId');
    expect(calledUrl).not.toContain('timesheetCodeId');
  });

  it('keeps has_more as ST raw page-level hasMore (unfiltered) — known completeness tradeoff, same as list_unpaid_invoices', async () => {
    const env = mixedPageEnv();
    const out = (await payroll_non_job_timesheets_list.handler(
      env,
      { employeeId: 999999 }, // matches nothing on this page
      { actor: 'test', correlation: 'c1' },
    )) as any;
    expect(out.timesheets).toEqual([]);
    expect(out.count).toBe(0);
    expect(out.has_more).toBe(true); // raw ST hasMore, not filtered-completeness aware
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
