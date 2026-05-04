// T4 catalog correction: dedicated sub-route POST .../appointments/{id}/hold with {reasonId, memo}.
// NOT a PATCH — ST has a specific /hold endpoint.
// H1: migrated to defineWriteTool factory 2026-04-26.
import { z } from 'zod';
import { defineWriteTool } from '../../write-tool-factory';

interface Args {
  appointmentId: number;
  reasonId: number;
  memo?: string;
  dryRun?: boolean;
  confirmation_token?: string;
}

export const hold_appointment = defineWriteTool<Args>({
  name: 'hold_appointment',
  description: 'Place an appointment on hold via the ST /hold sub-route (POST, not PATCH). dryRun=true (default) → token → dryRun=false to write.',
  zodSchema: {
    appointmentId: z.number().int().positive().describe('ST appointment ID'),
    reasonId: z.number().int().positive().describe('Hold reason ID'),
    memo: z.string().optional().describe('Optional memo text for the hold'),
  },
  endpoint: ({ appointmentId }) => `/jpm/v2/tenant/000000000/appointments/${appointmentId}/hold`,
  method: 'POST',
  payload: ({ reasonId, memo }) => ({ reasonId, memo }),
  businessArgs: ({ appointmentId, reasonId, memo }) => ({ appointmentId, reasonId, memo }),
  stEndpointTemplate: '/jpm/v2/tenant/{tid}/appointments/{appointmentId}/hold',
});
