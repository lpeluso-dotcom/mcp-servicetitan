// ============================================================
// get_job — single ST job by ID.
//
// v1.5.1 (ST-77): documents and explicitly preserves `isAutoDispatched`
// in the returned job object. ST-77 surfaces this boolean on the job
// GET response; downstream callers (dispatch composites, drive-time
// audits, FTK reconciliation) need to branch on it. defaultShaper
// strips only the envelope noise set in DEFAULT_EXCLUDED_FIELDS — it
// does NOT strip booleans by name, so the field flows through. This
// file documents the contract so future shaper changes don't lose it.
// ============================================================

import { z } from 'zod';
import { readST } from '../../st';
import type { ToolDef } from '../index';

interface Args { jobId: number }

export const get_job: ToolDef<Args> = {
  name: 'get_job',
  description:
    'Get a single ST job by ID. ST-77: response includes `isAutoDispatched` (boolean), ' +
    '`projectId` (number|null), and the standard JPM job fields. Source: live ST.',
  zodSchema: {
    jobId: z.number().int().positive().describe('ST job ID'),
  },
  stEndpoint: {
    method: 'GET',
    path: '/jpm/v2/tenant/{tid}/jobs/{id}',
    source: 'live',
  },
  async handler(env, args, ctx) {
    const tenant = env.ST_TENANT_ID;
    const job = await readST(env, ctx, `/jpm/v2/tenant/${tenant}/jobs/${args.jobId}`);
    return { job, _source: 'live' };
  },
};
