import { z } from 'zod';
import { McpError } from '../../errors';
import { authHeaders } from '../../auth';
import type { ToolDef } from '../index';

interface Args { jobId: number }

export const get_job: ToolDef<Args> = {
  name: 'get_job',
  description: 'Get a single ST job by ID. Source: live ST.',
  zodSchema: {
    jobId: z.number().int().positive().describe('ST job ID'),
  },
  async handler(env, args, { actor, correlation }) {
    const resp = await env.ST_PROXY.fetch(
      `https://servicetitan-proxy/api/st/read?endpoint=${encodeURIComponent(`/jpm/v2/tenant/000000000/jobs/${args.jobId}`)}`,
      { headers: authHeaders(env, correlation, actor) }
    );
    if (!resp.ok) throw new McpError('upstream_error', `get_job failed: ${resp.status}`, { correlation });
    const job = await resp.json();
    return { job, _source: 'live' };
  },
};
