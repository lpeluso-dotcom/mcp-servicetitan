import { z } from 'zod';
import { readST } from '../../st-read';
import type { ToolDef } from '../index';

const TENANT_ID = '000000000';

interface Args {
  appointmentId: number;
}

export const appointment_get: ToolDef<Args> = {
  name: 'appointment_get',
  description:
    'Get one ServiceTitan appointment by ID. ST-77 adds active and ST-77.1 adds appointmentSummaries to appointment responses. Source: live ST.',
  zodSchema: {
    appointmentId: z.number().int().positive().describe('ST appointment ID'),
  },
  stEndpoint: {
    method: 'GET',
    path: '/jpm/v2/tenant/{tid}/appointments/{appointmentId}',
    source: 'live',
  },
  async handler(env, args, { actor, correlation }) {
    const appointment = await readST(env, `/jpm/v2/tenant/${TENANT_ID}/appointments/${args.appointmentId}`, {
      actor,
      correlation,
    });
    return { appointment, _source: 'live' };
  },
};
