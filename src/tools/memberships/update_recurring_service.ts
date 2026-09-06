import { z } from 'zod';
import { defineWriteTool } from '../../write-tool-factory';

const days = z.enum(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']);
const patchSchema = z.object({
  from: z.string().datetime().optional().describe('Beginning date of the recurring service, NOT a next-event date.'),
  recurrenceType: z.enum(['Weekly', 'Monthly', 'Seasonal', 'Daily', 'NthWeekdayOfMonth']).optional(),
  recurrenceInterval: z.number().int().nonnegative().optional(),
  recurrenceMonths: z.array(z.enum(['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'])).optional(),
  recurrenceDaysOfWeek: z.array(days).optional(),
  recurrenceWeek: z.enum(['None', 'First', 'Second', 'Third', 'Fourth', 'Last']).optional(),
  recurrenceDayOfNthWeek: days.nullable().optional(),
}).strict().refine(patch => Object.values(patch).some(value => value !== undefined), 'At least one recurrence field is required');
const schema = z.object({ recurringServiceId: z.number().int().positive(), patch: patchSchema });
type Args = z.infer<typeof schema> & { dryRun?: boolean; confirmation_token?: string };

export const update_recurring_service = defineWriteTool<Args>({
  name: 'update_recurring_service',
  description: 'Source: live ST. PATCH a location recurring service recurrence configuration using documented ST fields. from is the service beginning date; this API has no nextDate/nextScheduledDate field and this tool cannot directly reschedule a single event. Read current recurrence configuration before preparing a partial patch. Does not cancel jobs or change membership status. dryRun=true by default; confirmed execution requires its preview token.',
  zodSchema: schema.shape,
  validate: args => { schema.parse(args); },
  endpoint: ({ recurringServiceId }) => `/memberships/v2/tenant/000000000/recurring-services/${recurringServiceId}`,
  method: 'PATCH',
  payload: ({ patch }) => patchSchema.parse(patch),
  businessArgs: ({ recurringServiceId, patch }) => ({ recurringServiceId, patch: patchSchema.parse(patch) }),
  stEndpointTemplate: '/memberships/v2/tenant/{tid}/recurring-services/{recurringServiceId}',
});
