import { z } from 'zod';
import { McpError } from '../../errors';
import { authHeaders } from '../../auth';
import type { ToolDef } from '../index';

interface Args { jobId?: number; assignedToId?: number; page?: number; pageSize?: number }

// Path must be /taskmanagement/ (no hyphen) — ST 404s on /task-management/.
export const list_open_tasks: ToolDef<Args> = {
  name: 'list_open_tasks',
  description: 'List open (incomplete) tasks. Path: /taskmanagement/ (no hyphen — ST 404s on /task-management/). Source: live ST.',
  zodSchema: {
    jobId: z.number().int().positive().optional().describe('Filter by job ID'),
    assignedToId: z.number().int().positive().optional().describe('Filter by assigned employee ID'),
    page: z.number().int().positive().default(1).describe('Page number'),
    pageSize: z.number().int().positive().max(200).default(50).describe('Page size, max 200'),
  },
  async handler(env, args, { actor, correlation }) {
    const qs = new URLSearchParams();
    qs.set('completionStatus', 'Incomplete');
    if (args.jobId) qs.set('jobId', String(args.jobId));
    if (args.assignedToId) qs.set('assignedToId', String(args.assignedToId));
    qs.set('page', String(args.page ?? 1));
    qs.set('pageSize', String(args.pageSize ?? 50));

    const resp = await env.ST_PROXY.fetch(
      `https://servicetitan-proxy/api/st/read?endpoint=${encodeURIComponent(`/taskmanagement/v2/tenant/000000000/tasks?${qs}`)}`,
      { headers: authHeaders(env, correlation, actor) }
    );
    if (!resp.ok) throw new McpError('upstream_error', `list_open_tasks failed: ${resp.status}`, { correlation });
    const data = await resp.json<{ data?: unknown[] }>();
    return { tasks: data.data ?? [], _source: 'live' };
  },
};
