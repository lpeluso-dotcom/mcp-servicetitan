// T3 catalog correction: PATCH /jpm/v2/tenant/.../appointments/{id}
// with {start, end, arrivalWindowStart, arrivalWindowEnd}.
// Tech assignments stay pinned to old slot — document as compound write if tech-follow needed.
// H1: migrated to defineWriteTool factory 2026-04-26.
import { z } from 'zod';
import { defineWriteTool } from '../../write-tool-factory';

interface Args {
  appointmentId: number;
  start: string;
  end: string;
  arrivalWindowStart: string;
  arrivalWindowEnd: string;
  dryRun?: boolean;
  confirmation_token?: string;
}

export const reschedule_appointment = defineWriteTool<Args>({
  name: 'reschedule_appointment',
  description: 'Reschedule an appointment (PATCH start/end/arrivalWindow). Tech assignments stay pinned to the old slot — use assign_technicians separately if you need them to follow. dryRun=true (default) → token → dryRun=false to write.',
  zodSchema: {
    appointmentId: z.number().int().positive().describe('ST appointment ID'),
    start: z.string().describe('New appointment start ISO 8601 datetime'),
    end: z.string().describe('New appointment end ISO 8601 datetime'),
    arrivalWindowStart: z.string().describe('Arrival window start ISO 8601 datetime'),
    arrivalWindowEnd: z.string().describe('Arrival window end ISO 8601 datetime'),
  },
  endpoint: ({ appointmentId }) => `/jpm/v2/tenant/000000000/appointments/${appointmentId}`,
  method: 'PATCH',
  payload: ({ start, end, arrivalWindowStart, arrivalWindowEnd }) => ({
    start,
    end,
    arrivalWindowStart,
    arrivalWindowEnd,
  }),
  stEndpointTemplate: '/jpm/v2/tenant/{tid}/appointments/{appointmentId}',
});
