import { z } from 'zod';
import { defineWriteTool } from '../../write-tool-factory';

const schema = z.object({
  eventId: z.number().int().positive(),
  jobId: z.number().int().positive().describe('Job linked/unlinked by this operation; invoice items are copied/deleted.'),
  direction: z.enum(['complete', 'incomplete']),
});
type Args = z.infer<typeof schema> & { dryRun?: boolean; confirmation_token?: string };

export const mark_recurring_service_event = defineWriteTool<Args>({
  name: 'mark_recurring_service_event',
  description: 'Source: live ST. Change a recurring service event/job association. NOT a dismiss-only toggle: complete links jobId and copies the recurring service invoice-template items onto its job invoice; incomplete unlinks jobId and deletes those copied items. The public API does not document deferred-revenue recognition behavior or expose the UI recognition checkbox; do not assume either behavior. Does not cancel jobs. dryRun=true by default; confirmed execution requires the preview token. Review invoice impact before confirming.',
  zodSchema: schema.shape,
  validate: args => { schema.parse(args); },
  endpoint: ({ eventId, direction }) => `/memberships/v2/tenant/000000000/recurring-service-events/${eventId}/mark-${direction}`,
  method: 'POST',
  payload: ({ jobId }) => ({ jobId }),
  businessArgs: ({ eventId, jobId, direction }) => ({ eventId, jobId, direction }),
  stEndpointTemplate: '/memberships/v2/tenant/{tid}/recurring-service-events/{eventId}/mark-{direction}',
});

// Both directions mutate an existing job invoice despite using POST.
mark_recurring_service_event.annotations = { destructiveHint: true, idempotentHint: false };
