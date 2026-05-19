import { z } from 'zod';
import { readST } from '../../st-read';
import type { ToolDef } from '../index';

interface Args { jobId: number }

export const get_job: ToolDef<Args> = {
  name: 'get_job',
  description: 'Get a single ST job by ID. Source: live ST. ST-77.1 returns isAutoDispatched and summaryOfWork on job rows.',
  zodSchema: {
    jobId: z.number().int().positive().describe('ST job ID'),
  },
  stEndpoint: {
    method: 'GET',
    path: '/jpm/v2/tenant/{tid}/jobs/{id}',
    source: 'live',
  },
  async handler(env, args, { actor, correlation }) {
    const job = await readST(env, `/jpm/v2/tenant/000000000/jobs/${args.jobId}`, { actor, correlation });
    return { job, _source: 'live' };
  },
};
