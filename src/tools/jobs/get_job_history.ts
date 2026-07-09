// ============================================================
// get_job_history — audit-log / event timeline for a single ST job.
//
// Used to break apart the "No Capacity" bucket from ST report 76986367
// (Adaptive Capacity Scheduling Utilization Report): the report's
// `tool_used` field is binary (`Adaptive Capacity` | `No Capacity`),
// but the per-ticket history endpoint exposes individual events
// like booking-source / capacity-planning / dispatch-board picks —
// enough to split "No Capacity" into Capacity-Planning-template vs
// no-tool-at-all.
// ============================================================

import { z } from 'zod';
import { readST } from '../../st';
import type { ToolDef } from '../index';
import { defaultShaper } from '../../response-shape';

interface Args {
  jobId: number;
  page?: number;
  pageSize?: number;
}

export const get_job_history: ToolDef<Args> = {
  name: 'get_job_history',
  description:
    'Get the audit-log / event timeline for a single ST job: booking events, capacity-tool usage, ' +
    'status changes, reassignments, etc. Returns the raw event list. Use for per-job audits when ' +
    'aggregate reports do not break out the signal you need. Source: live ST.',
  zodSchema: {
    jobId: z.number().int().positive().describe('ST job ID'),
    page: z.number().int().positive().optional().describe('Page number, default 1'),
    pageSize: z
      .number()
      .int()
      .positive()
      .max(500)
      .optional()
      .describe('Page size, default 100, max 500'),
  },
  stEndpoint: {
    method: 'GET',
    path: '/jpm/v2/tenant/{tid}/jobs/{id}/history',
    source: 'live',
  },
  async handler(env, args, ctx) {
    const tenant = env.ST_TENANT_ID;
    const query: Record<string, unknown> = {};
    if (args.page !== undefined) query.page = args.page;
    if (args.pageSize !== undefined) query.pageSize = args.pageSize;

    const data = await readST<{
      data?: unknown[];
      hasMore?: boolean;
      totalCount?: number | null;
    }>(env, ctx, `/jpm/v2/tenant/${tenant}/jobs/${args.jobId}/history`, query);

    return {
      jobId: args.jobId,
      events: data.data ?? [],
      count: (data.data ?? []).length,
      has_more: data.hasMore ?? false,
      total_count: data.totalCount ?? null,
      _source: 'live',
    };
  },
  transformResult: defaultShaper,
};
