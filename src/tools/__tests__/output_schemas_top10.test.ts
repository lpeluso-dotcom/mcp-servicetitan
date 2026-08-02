// ============================================================
// output_schemas_top10.test.ts — Phase 2 Task 2.2
//
// Validates the `outputSchema` added to the top-10 tools against REAL
// representative envelopes (derived from each tool's own `return`
// statement + existing fixtures in this dir's siblings — see the
// per-tool comments below for provenance).
//
// SAFETY CONTEXT: the installed MCP SDK (1.29) validates
// `structuredContent` against `outputSchema` at RUNTIME on every tool
// call (`validateToolOutput` in @modelcontextprotocol/sdk). A schema
// that's too strict makes the tool call FAIL in production if a real
// response has an extra/missing/differently-typed field. So every
// positive assertion here must stay green against realistic ST
// payload variation — that's the actual regression this file guards.
//
// Each `it` is a positive lenient check (schema must accept a real
// envelope). The final `describe` block is the negative sanity check
// proving the schemas aren't vacuous (i.e. they still reject a
// clearly wrong-shaped envelope — missing required envelope keys).
// ============================================================

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { get_job } from '../jobs/get_job';
import { find_customer } from '../crm/find_customer';
import { get_invoice } from '../invoicing/get_invoice';
import { list_jobs_today } from '../jobs/list_jobs_today';
import { customer_snapshot } from '../composites/customer_snapshot';
import { payroll_job_timesheets_list } from '../payroll/payroll_job_timesheets_list';
import { search_pricebook_all } from '../pricebook/search_pricebook_all';
import { get_estimate } from '../estimates/get_estimate';
import { job_cost_actuals } from '../composites/job_cost_actuals';
import { list_unpaid_invoices } from '../invoicing/list_unpaid_invoices';
import type { ToolDef } from '../index';

function expectValid(tool: ToolDef<any>, sample: unknown) {
  expect(tool.outputSchema, `${tool.name}.outputSchema must be defined`).toBeDefined();
  const schema = z.object(tool.outputSchema!);
  const result = schema.safeParse(sample);
  if (!result.success) {
    // Surface the real zod error in the test failure output for fast debugging.
    // eslint-disable-next-line no-console
    console.error(`${tool.name} outputSchema rejected a real envelope:`, result.error);
  }
  expect(result.success).toBe(true);
}

describe('outputSchema — lenient fixture validation (top-10 tools)', () => {
  // Envelope per get_job's `return { job, _source: 'live' }`. ST-77 doc
  // comment on the tool pins isAutoDispatched/projectId as fields callers
  // depend on — kept in the fixture, but the schema must not require them
  // by name (nested ST payload stays permissive).
  it('get_job: single job envelope', () => {
    expectValid(get_job, {
      job: { id: 123, jobStatus: 'InProgress', isAutoDispatched: true, projectId: null, businessUnitId: 7 },
      _source: 'live',
    });
  });

  // Envelope per find_customer's `return { count, customers, _source }`
  // where `customers` is the slim() projection (id/name/type/address/
  // balance/do_not_service) — see src/tools/crm/find_customer.ts.
  it('find_customer: slim customer list envelope', () => {
    expectValid(find_customer, {
      count: 1,
      customers: [
        { id: 1, name: 'Alice Example', type: 'Residential', address: '123 Main St, Florence, SC, 29501', balance: 0, do_not_service: false },
      ],
      _source: 'live',
    });
  });

  // Envelope per get_invoice's `return { invoice, _source: 'live' }'.
  it('get_invoice: single invoice envelope', () => {
    expectValid(get_invoice, {
      invoice: { id: 279340, total: '150.00', jobId: 100, businessUnitId: 3 },
      _source: 'live',
    });
  });

  // Envelope per list_jobs_today's `return { jobs, date, _source }`, plus
  // the optional `_warnings` merged in when a name resolver was ambiguous.
  it('list_jobs_today: jobs-for-today envelope (no warnings)', () => {
    expectValid(list_jobs_today, {
      jobs: [{ id: 100, jobStatus: 'Scheduled', businessUnitId: 1 }, { id: 200, jobStatus: 'InProgress', businessUnitId: 2 }],
      date: '2026-07-09',
      _source: 'live',
    });
  });

  it('list_jobs_today: envelope with _warnings present (ambiguous name resolution)', () => {
    expectValid(list_jobs_today, {
      jobs: [],
      date: '2026-07-09',
      _source: 'live',
      _warnings: ['businessUnit_name_ambiguous: chose 12 for "Plumbing"'],
    });
  });

  // Envelope per customer_snapshot's handler return (composites/customer_snapshot.ts):
  // customerId, _partial, _failures, customer, locations, jobs, memberships,
  // estimates, invoices, _composite, _source, correlation. Fanout sub-results
  // can each independently be an object, array, or null on partial failure
  // (see c10_composites.test.ts: `expect(result.memberships).toBeNull()`).
  it('customer_snapshot: full fanout success envelope', () => {
    expectValid(customer_snapshot, {
      customerId: 100,
      customer: { id: 100, name: 'Bob Example' },
      locations: [{ id: 1, address: '1 Main St' }],
      jobs: [{ id: 500, jobStatus: 'Completed' }],
      memberships: [{ id: 9, status: 'Active' }],
      estimates: [{ id: 20, status: 'Sold' }],
      invoices: [{ id: 30, total: 200 }],
      _partial: false,
      _failures: [],
      _composite: 'customer_snapshot',
      _source: 'mixed',
      correlation: 'test-corr',
    });
  });

  it('customer_snapshot: partial-failure envelope (a sub-fetch failed to null)', () => {
    expectValid(customer_snapshot, {
      customerId: 100,
      customer: { id: 100, name: 'Bob Example' },
      locations: [],
      jobs: [],
      memberships: null,
      estimates: [],
      invoices: [],
      _partial: true,
      _failures: [{ call: 'memberships', error_class: 'HTTPError' }],
      _composite: 'customer_snapshot',
      _source: 'mixed',
      correlation: 'test-corr',
    });
  });

  it('customer_snapshot: mv_d1 cache-hit envelope (_source overridden, no correlation change)', () => {
    expectValid(customer_snapshot, {
      customerId: 100,
      customer: { id: 100 },
      locations: [],
      jobs: [],
      memberships: [],
      estimates: [],
      invoices: [],
      _partial: false,
      _failures: [],
      _composite: 'customer_snapshot',
      _source: 'mv_d1',
      correlation: 'test-corr-2',
    });
  });

  // Envelope per payroll_job_timesheets_list D1-mode return — real shape
  // pinned by src/tools/__tests__/payroll_job_timesheets_list.test.ts
  // (PROBE_D1_ROW): count, timesheets (slim shape), has_more, _source,
  // _stale_hours (nullable), plus optional _fallback_skipped/_fallback_reason.
  it('payroll_job_timesheets_list: D1-mode envelope', () => {
    expectValid(payroll_job_timesheets_list, {
      count: 1,
      timesheets: [{
        timesheet_id: 77457122, job_id: 77423990, appointment_id: 77423991, technician_id: 75766687,
        dispatched_on: '2026-02-20T16:38:00Z', arrived_on: '2026-02-20T17:02:00Z', canceled_on: null,
        done_on: '2026-02-20T19:34:00Z', drive_minutes: 24, working_minutes: 152, active: true,
        created_on: '2026-02-20T16:38:00Z', modified_on: '2026-02-20T19:34:00Z',
      }],
      has_more: false,
      _source: 'd1',
      _stale_hours: 1.0,
    });
  });

  it('payroll_job_timesheets_list: live-mode fallback envelope (_fallback_reason present)', () => {
    expectValid(payroll_job_timesheets_list, {
      count: 1,
      timesheets: [{ timesheet_id: 1, job_id: 77423990, appointment_id: null, technician_id: 9, dispatched_on: null, arrived_on: null, canceled_on: null, done_on: null, drive_minutes: null, working_minutes: null, active: true, created_on: null, modified_on: null }],
      has_more: false,
      _source: 'live',
      _fallback_reason: 'd1_empty',
    });
  });

  // Envelope per search_pricebook_all — two real shapes: 'success' (code or
  // query hit) and 'not_found'. See v12_new_tools.test.ts for real item rows.
  it('search_pricebook_all: success envelope (code lookup)', () => {
    expectValid(search_pricebook_all, {
      status: 'success',
      count: 1,
      matched_code: 'FLU-150',
      items: [{ code: 'FLU-150', name: 'Flush', description: '', category: 'Drain', price: 150, member_price: null, hours: 0.75, type: 'service', calculated_price: 200, pricing: 'dynamic' }],
      _source: 'd1',
    });
  });

  it('search_pricebook_all: not_found envelope', () => {
    expectValid(search_pricebook_all, {
      status: 'not_found',
      message: 'Nothing found for "zzz". Try a different term.',
      count: 0,
      items: [],
      _source: 'd1',
    });
  });

  // Envelope per get_estimate's `return { estimate, _source: 'live' }`. The
  // handler types `estimate` as `unknown` (readST<unknown>) — the live ST
  // payload shape is not locally guaranteed, so the schema must stay fully
  // permissive on that field.
  it('get_estimate: single estimate envelope', () => {
    expectValid(get_estimate, {
      estimate: { id: 10, status: 'Sold', jobId: 100, total: 500 },
      _source: 'live',
    });
  });

  // Envelope per job_cost_actuals composite (composites/job_cost_actuals.ts)
  // — real numbers pinned by v15_composites.test.ts's Brooks/77423990 probe.
  it('job_cost_actuals: full composite envelope (Brooks/77423990 probe shape)', () => {
    expectValid(job_cost_actuals, {
      jobId: 77423990,
      job: { job_id: 77423990, customer_id: 9001, business_unit: 'Plumbing Service Residential', job_type: 'Service Call', job_status: 'Completed', completed_date: '2026-02-20', revenue: 850.0, project_id: null, modified_at: '2026-02-20T19:34:00Z' },
      summary: {
        total_drive_minutes: 24, total_working_minutes: 152, total_minutes: 176,
        burden_rate_per_hour: 45, 'labor_burden_$': 132, revenue: 850,
        'gross_profit_$': 718, gross_margin_pct: 84.5,
      },
      per_technician: [{ technician_id: 75766687, technician_name: 'Brooks Hunsucker', drive_minutes: 24, working_minutes: 152, timesheet_count: 1 }],
      timesheets: [{ timesheet_id: 1, job_id: 77423990, appointment_id: 200, technician_id: 75766687, dispatched_on: '2026-02-20T16:38:00Z', arrived_on: '2026-02-20T17:02:00Z', canceled_on: null, done_on: '2026-02-20T19:34:00Z', drive_minutes: 24, working_minutes: 152, active: true }],
      appointments: [],
      assignments: [],
      estimates: [],
      invoice: null,
      _partial: false,
      _failures: [],
      _composite: 'job_cost_actuals',
      _source: 'mixed',
      correlation: 'c1',
    });
  });

  // Envelope per list_unpaid_invoices's return. The scan-disclosure fields
  // became part of the contract in QUA-1108 — the tool drains ST pages and must
  // tell the caller whether it exhausted the source, because an empty list from
  // a budget-capped scan means "stopped looking", not "nothing outstanding".
  it('list_unpaid_invoices: unpaid invoices envelope (complete scan)', () => {
    expectValid(list_unpaid_invoices, {
      invoices: [{ id: 1, balance: 50.0, jobId: 100 }],
      _source: 'live',
      _scan_complete: true,
      _pages_scanned: 1,
      _unpaid_found: 1,
    });
  });

  it('list_unpaid_invoices: unpaid invoices envelope (budget-capped scan)', () => {
    expectValid(list_unpaid_invoices, {
      invoices: [],
      _source: 'live',
      _scan_complete: false,
      _pages_scanned: 25,
      _unpaid_found: 0,
      _warning: 'page budget reached: scanned 25 ST pages …',
    });
  });
});

describe('outputSchema — negative sanity (schemas are not vacuous)', () => {
  it('get_job: rejects an envelope missing the required `job` key', () => {
    const schema = z.object(get_job.outputSchema!);
    expect(schema.safeParse({ _source: 'live' }).success).toBe(false);
  });

  it('find_customer: rejects an envelope with the wrong type for `count`', () => {
    const schema = z.object(find_customer.outputSchema!);
    expect(schema.safeParse({ count: 'one', customers: [], _source: 'live' }).success).toBe(false);
  });

  it('get_invoice: rejects an envelope missing `invoice` entirely', () => {
    const schema = z.object(get_invoice.outputSchema!);
    expect(schema.safeParse({ _source: 'live' }).success).toBe(false);
  });

  it('list_unpaid_invoices: rejects `invoices` typed as a non-array', () => {
    const schema = z.object(list_unpaid_invoices.outputSchema!);
    expect(schema.safeParse({ invoices: 'not-an-array', _source: 'live' }).success).toBe(false);
  });
});
