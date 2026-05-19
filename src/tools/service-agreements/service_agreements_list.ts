import { z } from 'zod';
import { readST } from '../../st-read';
import type { ToolDef } from '../index';

const TENANT_ID = '000000000';

interface Args {
  page?: number;
  pageSize?: number;
}

export const service_agreements_list: ToolDef<Args> = {
  name: 'service_agreements_list',
  description:
    'List ServiceTitan service agreements. ST-77 adds BillingScheduleType=Custom; ST-77.1 adds customFields on responses. Source: live ST.',
  zodSchema: {
    page: z.number().int().positive().optional().describe('Page number, default 1'),
    pageSize: z.number().int().positive().max(200).optional().describe('Page size, default 50, max 200'),
  },
  stEndpoint: {
    method: 'GET',
    path: '/service-agreements/v2/tenant/{tid}/service-agreements',
    source: 'live',
  },
  async handler(env, args, { actor, correlation }) {
    const qs = new URLSearchParams();
    qs.set('page', String(args.page ?? 1));
    qs.set('pageSize', String(Math.min(args.pageSize ?? 50, 200)));
    const data = await readST<{ data?: unknown[]; hasMore?: boolean }>(
      env,
      `/service-agreements/v2/tenant/${TENANT_ID}/service-agreements?${qs.toString()}`,
      { actor, correlation }
    );
    return { service_agreements: data.data ?? [], has_more: !!data.hasMore, _source: 'live' };
  },
};
