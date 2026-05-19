import { z } from 'zod';
import { readST } from '../../st-read';
import type { ToolDef } from '../index';

interface Args { jobId: number }

export const get_job_appointments: ToolDef<Args> = {
  name: 'get_job_appointments',
  description: 'Get appointments for a job. Source: live ST. ST-77.1 returns appointmentSummaries on appointment rows.',
  zodSchema: {
    jobId: z.number().int().positive().describe('ST job ID'),
  },
  stEndpoint: {
    method: 'GET',
    path: '/jpm/v2/tenant/{tid}/appointments',
    source: 'live',
  },
  async handler(env, args, { actor, correlation }) {
    const qs = new URLSearchParams({ jobId: String(args.jobId) });
    const data = await readST<{ data?: unknown[] }>(env, `/jpm/v2/tenant/000000000/appointments?${qs}`, {
      actor,
      correlation,
    });
    return { appointments: data.data ?? [], _source: 'live' };
  },
};
