import { z } from 'zod';
import { readST } from '../../st';
import type { ToolDef } from '../index';
import { defaultShaper } from '../../response-shape';

const schema = z.object({
  locationId: z.number().int().positive().optional(),
  membershipId: z.number().int().positive().optional().describe('Client-side filter on the returned page; continue while hasMore, including empty filtered pages.'),
  jobId: z.number().int().positive().optional(),
  status: z.enum(['NotAttempted', 'Unreachable', 'Contacted', 'Won', 'Dismissed']).optional(),
  modifiedOnOrAfter: z.string().datetime().optional(),
  modifiedBefore: z.string().datetime().optional(),
  page: z.number().int().positive().default(1),
  pageSize: z.number().int().positive().max(100).default(50),
});
type Args = z.input<typeof schema>;

export const list_recurring_service_events: ToolDef<Args> = {
  name: 'list_recurring_service_events',
  description: 'List recurring service events from live ST. Default page size 50, max 100; one page per call. Supports location/job, follow-up status and modified-time filters. membershipId is filtered locally on EACH page because the public endpoint has no membershipId query filter. An empty filtered page is not end-of-results: continue while hasMore. upstreamTotalCount counts unfiltered upstream events.',
  zodSchema: schema.shape,
  stEndpoint: { method: 'GET', path: '/memberships/v2/tenant/{tid}/recurring-service-events', source: 'live' },
  async handler(env, input, context) {
    const { membershipId, ...query } = schema.parse(input);
    const result = await readST<{ data?: Record<string, unknown>[]; page?: number; hasMore?: boolean; totalCount?: number }>(
      env, context, '/memberships/v2/tenant/000000000/recurring-service-events', query,
    );
    const rows = result.data ?? [];
    return {
      events: membershipId === undefined ? rows : rows.filter(row => row.membershipId === membershipId),
      page: result.page ?? query.page,
      hasMore: result.hasMore ?? false,
      upstreamTotalCount: result.totalCount,
      ...(membershipId === undefined ? {} : { membershipFilterScope: 'current_page' }),
      _source: 'live',
    };
  },
  transformResult: defaultShaper,
};
