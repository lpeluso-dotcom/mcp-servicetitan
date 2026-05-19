import { z } from 'zod';
import { readST } from '../../st';
import type { ToolDef } from '../index';

const TENANT_ID = '000000000';

interface Args { serviceId: number }

export const get_service_details: ToolDef<Args> = {
  name: 'get_service_details',
  description: 'Get full details for a single pricebook service including pricing tiers and categories. Source: D1 (pb_services fresh 2026-04-22).',
  zodSchema: {
    serviceId: z.number().int().positive().describe('ST pricebook service ID'),
  },
  stEndpoint: { method: 'GET', path: '/pricebook/v2/tenant/{tid}/services/{serviceId}', source: 'live' },
  async handler(env, args, { actor, correlation }) {
    const data = await readST<unknown>(
      env,
      { actor, correlation },
      `/pricebook/v2/tenant/${TENANT_ID}/services/${args.serviceId}`,
    );
    return { service: data, _source: 'live' };
  },
};
