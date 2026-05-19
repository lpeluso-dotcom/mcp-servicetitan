import { z } from 'zod';
import { readST } from '../../st';
import type { ToolDef } from '../index';

interface Args { technicianId: number; startsOnOrAfter?: string; startsBefore?: string; page?: number; pageSize?: number }

export const get_technician_shifts: ToolDef<Args> = {
  name: 'get_technician_shifts',
  description: 'Get scheduled shifts for a technician. Source: live ST (shifts are computed, not in D1).',
  stEndpoint: { method: 'GET', path: '/dispatch/v2/tenant/{tid}/shifts', source: 'live' },
  zodSchema: {
    technicianId: z.number().int().positive().describe('ST technician ID'),
    startsOnOrAfter: z.string().optional().describe('Filter shifts starting on or after this date (ISO 8601)'),
    startsBefore: z.string().optional().describe('Filter shifts starting before this date (ISO 8601)'),
    page: z.number().int().positive().default(1).describe('Page number'),
    pageSize: z.number().int().positive().max(200).default(50).describe('Page size, max 200'),
  },
  async handler(env, args, { actor, correlation }) {
    const query: Record<string, unknown> = {
      technicianIds: args.technicianId,
      page: args.page ?? 1,
      pageSize: args.pageSize ?? 50,
    };
    if (args.startsOnOrAfter) query.startsOnOrAfter = args.startsOnOrAfter;
    if (args.startsBefore) query.startsBefore = args.startsBefore;

    const data = await readST<{ data?: unknown[] }>(
      env,
      { actor, correlation },
      '/dispatch/v2/tenant/000000000/shifts',
      query,
    );
    return { shifts: data.data ?? [], _source: 'live' };
  },
};
