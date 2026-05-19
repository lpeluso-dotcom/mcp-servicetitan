import { z } from 'zod';
import { readST } from '../../st';
import type { ToolDef } from '../index';

interface Args { technicianId?: number; startsOnOrAfter?: string; startsBefore?: string; page?: number; pageSize?: number }

export const list_non_job_events: ToolDef<Args> = {
  name: 'list_non_job_events',
  description: 'List non-job dispatch events (time-off, training, meetings) for technicians. Source: live ST.',
  stEndpoint: { method: 'GET', path: '/dispatch/v2/tenant/{tid}/non-job-appointments', source: 'live' },
  zodSchema: {
    technicianId: z.number().int().positive().optional().describe('Filter by technician ID'),
    startsOnOrAfter: z.string().optional().describe('Filter events starting on or after this date (ISO 8601)'),
    startsBefore: z.string().optional().describe('Filter events starting before this date (ISO 8601)'),
    page: z.number().int().positive().default(1).describe('Page number'),
    pageSize: z.number().int().positive().max(200).default(50).describe('Page size, max 200'),
  },
  async handler(env, args, { actor, correlation }) {
    const query: Record<string, unknown> = {
      page: args.page ?? 1,
      pageSize: args.pageSize ?? 50,
    };
    if (args.technicianId) query.technicianIds = args.technicianId;
    if (args.startsOnOrAfter) query.startsOnOrAfter = args.startsOnOrAfter;
    if (args.startsBefore) query.startsBefore = args.startsBefore;

    const data = await readST<{ data?: unknown[] }>(
      env,
      { actor, correlation },
      '/dispatch/v2/tenant/000000000/non-job-appointments',
      query,
    );
    return { events: data.data ?? [], _source: 'live' };
  },
};
