import { z } from 'zod';
import { McpError } from '../../errors';
import { authHeaders } from '../../auth';
import type { ToolDef } from '../index';

interface Args { jobId: number }

export const get_job_appointments: ToolDef<Args> = {
  name: 'get_job_appointments',
  description: 'Get appointments for a job. Source: live ST.',
  zodSchema: {
    jobId: z.number().int().positive().describe('ST job ID'),
  },
  async handler(env, args, { actor, correlation }) {
    const qs = new URLSearchParams({ jobId: String(args.jobId) });
    const resp = await env.TAYLOR_AI.fetch(
      `https://taylor-ai/api/st/read?endpoint=${encodeURIComponent(`/jpm/v2/tenant/431848990/appointments?${qs}`)}`,
      { headers: authHeaders(env, correlation, actor) }
    );
    if (!resp.ok) throw new McpError('upstream_error', `get_job_appointments failed: ${resp.status}`, { correlation });
    const data = await resp.json<{ data?: unknown[] }>();
    return { appointments: data.data ?? [], _source: 'live' };
  },
};
