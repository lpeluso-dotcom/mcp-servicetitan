import { z } from 'zod';
import { readST } from '../../st';
import type { ToolDef } from '../index';
import { defaultShaper } from '../../response-shape';

interface Args { technicianId?: number; startsOnOrAfter?: string; startsBefore?: string; page?: number; pageSize?: number }

export const list_non_job_events: ToolDef<Args> = {
  name: 'list_non_job_events',
  description: 'List non-job dispatch events (time-off, training, meetings) for technicians. Source: live ST. Default page size 50, max 200.',
  stEndpoint: { method: 'GET', path: '/dispatch/v2/tenant/{tid}/non-job-appointments', source: 'live' },
  zodSchema: {
    technicianId: z.number().int().positive().optional().describe('Filter by technician ID'),
    startsOnOrAfter: z.string().optional().describe('Filter events starting on or after this date (ISO 8601)'),
    startsBefore: z.string().optional().describe('Filter events starting before this date (ISO 8601)'),
    page: z.number().int().positive().default(1).describe('Page number'),
    pageSize: z.number().int().positive().max(200).default(50).describe('Page size, max 200'),
  },
  async handler(env, args, { actor, correlation }) {
    // ST /non-job-appointments honors `technicianId` (singular) + `startsOnOrAfter`
    // + `startsOnOrBefore`. It SILENTLY IGNORES `technicianIds` (plural),
    // `startsBefore`, and `endsOnOrBefore` — returning the full unfiltered
    // collection (QUA-694, verified live 2026-07). NOTE: the upper-bound name
    // differs from /technician-shifts (`endsOnOrBefore`) — ST is inconsistent
    // across these two dispatch endpoints.
    const query: Record<string, unknown> = {
      page: args.page ?? 1,
      pageSize: args.pageSize ?? 50,
    };
    if (args.technicianId) query.technicianId = args.technicianId;
    if (args.startsOnOrAfter) query.startsOnOrAfter = args.startsOnOrAfter;
    if (args.startsBefore) query.startsOnOrBefore = args.startsBefore;

    const data = await readST<{ data?: unknown[] }>(
      env,
      { actor, correlation },
      '/dispatch/v2/tenant/000000000/non-job-appointments',
      query,
    );
    return { events: data.data ?? [], _source: 'live' };
  },
  transformResult: defaultShaper,
};
