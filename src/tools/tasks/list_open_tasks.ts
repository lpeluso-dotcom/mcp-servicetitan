import { z } from 'zod';
import { readST } from '../../st';
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
  stEndpoint: { method: 'GET', path: '/taskmanagement/v2/tenant/{tid}/tasks', source: 'live' },
  async handler(env, args, { actor, correlation }) {
    const query: Record<string, unknown> = {
      completionStatus: 'Incomplete',
      page: args.page ?? 1,
      pageSize: args.pageSize ?? 50,
    };
    if (args.jobId) query.jobId = args.jobId;
    if (args.assignedToId) query.assignedToId = args.assignedToId;

    const data = await readST<{ data?: unknown[] }>(
      env,
      { actor, correlation },
      '/taskmanagement/v2/tenant/000000000/tasks',
      query,
    );
    return { tasks: data.data ?? [], _source: 'live' };
  },
};
