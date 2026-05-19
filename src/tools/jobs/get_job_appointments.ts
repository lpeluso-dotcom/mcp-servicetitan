import { z } from 'zod';
import { readST } from '../../st';
import type { ToolDef } from '../index';

interface Args { jobId: number }

export const get_job_appointments: ToolDef<Args> = {
  name: 'get_job_appointments',
  description: 'Get appointments for a job. Source: live ST.',
  zodSchema: {
    jobId: z.number().int().positive().describe('ST job ID'),
  },
  stEndpoint: { method: 'GET', path: '/jpm/v2/tenant/{tid}/appointments', source: 'live' },
  async handler(env, args, { actor, correlation }) {
    const data = await readST<{ data?: unknown[] }>(
      env,
      { actor, correlation },
      '/jpm/v2/tenant/000000000/appointments',
      { jobId: args.jobId },
    );
    return { appointments: data.data ?? [], _source: 'live' };
  },
};
