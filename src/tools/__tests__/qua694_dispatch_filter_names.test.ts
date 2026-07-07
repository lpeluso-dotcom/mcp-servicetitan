// ============================================================
// qua694_dispatch_filter_names.test.ts — filter-preservation coverage for
// get_technician_shifts + list_non_job_events (QUA-694).
//
// Both handlers were silently dropping their filters by sending param names
// ServiceTitan does not recognize (200 + full unfiltered collection — the same
// "broken filter" class the harness was built to catch on payroll). Verified
// live against ST 2026-07 (Chase 44455158 / Brooks 75766687):
//
//   endpoint                tech filter     lower bound       upper bound
//   ----------------------  --------------  ----------------  ----------------
//   technician-shifts       technicianId    startsOnOrAfter   endsOnOrBefore
//   non-job-appointments    technicianId    startsOnOrAfter   startsOnOrBefore
//
//   IGNORED by ST (silent): technicianIds (plural) on both; startsBefore on
//   both; startsOnOrBefore on shifts; endsOnOrBefore on non-job-appointments.
//
// The public MCP arg surface stays `technicianId` / `startsOnOrAfter` /
// `startsBefore`; each maps to the ST-specific name via the harness `key`
// override below (same friendly-arg → ST-param pattern as get_capacity /
// payroll_non_job_timesheets_list).
// ============================================================

import { describe, it } from 'vitest';
import type { ToolDef } from '../index';
import { get_technician_shifts } from '../dispatch/get_technician_shifts';
import { list_non_job_events } from '../dispatch/list_non_job_events';
import { assertFilterPreservation } from './filter_preservation_helper';

describe('get_technician_shifts — filter preservation (QUA-694)', () => {
  it('forwards every declared filter under the ST param name ST honors', async () => {
    // Cast to ToolDef<any> (the same idiom as the TOOLS registry): this tool has a
    // REQUIRED technicianId arg, which the harness's Record<string,unknown> generic
    // can't accept by variance. The harness runs one filter at a time regardless.
    await assertFilterPreservation(get_technician_shifts as ToolDef<any>, {
      technicianId:    { value: 44455158, expect: 'forwarded_query' },
      startsOnOrAfter: { value: '2026-07-05T00:00:00Z', expect: 'forwarded_query' },
      // public arg `startsBefore` must reach ST as `endsOnOrBefore` on this endpoint.
      startsBefore:    { value: '2026-07-12T00:00:00Z', expect: 'forwarded_query', key: 'endsOnOrBefore' },
    });
  });
});

describe('list_non_job_events — filter preservation (QUA-694)', () => {
  it('forwards every declared filter under the ST param name ST honors', async () => {
    await assertFilterPreservation(list_non_job_events, {
      technicianId:    { value: 44455158, expect: 'forwarded_query' },
      startsOnOrAfter: { value: '2026-07-05T00:00:00Z', expect: 'forwarded_query' },
      // public arg `startsBefore` must reach ST as `startsOnOrBefore` on this endpoint.
      startsBefore:    { value: '2026-07-12T00:00:00Z', expect: 'forwarded_query', key: 'startsOnOrBefore' },
    });
  });
});
