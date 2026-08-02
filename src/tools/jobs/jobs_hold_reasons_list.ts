// ============================================================
// jobs_hold_reasons_list — ST-77 addition.
//
// Enumerates the tenant's configured Job Hold reasons. Used by callers
// that need to populate a dropdown, validate a reason ID before
// hold_appointment, or reconcile against a saved-report taxonomy.
//
// Mirrors the existing `cancel_reasons` shape (taylor-ai syncs that
// every 7d into D1). hold-reasons isn't currently mirrored, so this
// is a live-only read with the standard ST list envelope.
//
// Endpoint shape (verified post-deploy):
//   GET /jpm/v2/tenant/{tid}/job-hold-reasons
//   →  { data: [{ id, name, active }], hasMore, page, pageSize, totalCount }
// ============================================================

import { z } from 'zod';
import { readST } from '../../st';
import type { STListResponse } from '../../st';
import type { ToolDef } from '../index';
import { defaultShaper } from '../../response-shape';

interface Args {
  active?: boolean;
  page?: number;
  pageSize?: number;
}

interface HoldReason {
  id: number;
  name: string;
  active: boolean;
}

export const jobs_hold_reasons_list: ToolDef<Args> = {
  name: 'jobs_hold_reasons_list',
  description:
    'List ServiceTitan Job Hold reasons (ST-77). Returns the enum of reasons available when ' +
    'holding a job/appointment, so a caller can resolve a reason name → ID before invoking ' +
    'hold_appointment. Source: live ST. Default page size 50, max 200.',
  zodSchema: {
    active: z
      .boolean()
      .optional()
      .describe('Filter by active flag. true → active only; false → inactive only; omit → all.'),
    page: z.number().int().positive().optional().describe('Page number, default 1'),
    pageSize: z.number().int().positive().max(200).optional().describe('Page size, default 50, max 200'),
  },
  stEndpoint: {
    method: 'GET',
    path: '/jpm/v2/tenant/{tid}/job-hold-reasons',
    source: 'live',
  },
  async handler(env, args, { actor, correlation }) {
    const page = args.page ?? 1;
    const pageSize = Math.min(args.pageSize ?? 50, 200);
    const query: Record<string, unknown> = { page, pageSize };
    if (args.active !== undefined) query.active = args.active ? 'True' : 'False';

    const tenant = env.ST_TENANT_ID;
    const body = await readST<STListResponse<HoldReason>>(
      env,
      { actor, correlation },
      `/jpm/v2/tenant/${tenant}/job-hold-reasons`,
      query,
    );
    return {
      count: (body.data ?? []).length,
      hold_reasons: body.data ?? [],
      has_more: !!body.hasMore,
      total_count: body.totalCount ?? null,
      _source: 'live',
    };
  },
  transformResult: defaultShaper,
};
