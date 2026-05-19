import { z } from 'zod';
import { defaultShaper } from '../../response-shape';
import { readST } from '../../st';
import type { ToolDef } from '../index';

interface Args {
  active?: boolean;
  locationId?: number;
  page?: number;
  pageSize?: number;
}

interface RawLocationRate {
  id: number;
  locationId?: number;
  hourlyRate?: number;
  active?: boolean;
}

interface SlimLocationRate {
  id: number;
  location_id: number | null;
  hourly_rate: number;
  active: boolean | null;
}

function slim(r: RawLocationRate): SlimLocationRate {
  return {
    id: r.id,
    location_id: r.locationId ?? null,
    hourly_rate: r.hourlyRate ?? 0,
    active: r.active ?? null,
  };
}

// Back-office tool (no voice consumer); pageSize tuned for PO/receipt
// enumeration, not voice-tier readback. Compare find_customer's tighter caps.
const DEFAULT_PAGESIZE = 25;
const MAX_PAGESIZE = 100;

export const payroll_location_rates_list: ToolDef<Args> = {
  name: 'payroll_location_rates_list',
  description:
    'List ServiceTitan location-based pay rates. Filter by location or active flag. Source: live ST.',
  zodSchema: {
    active: z.boolean().optional().describe('Filter to active=true or active=false; omit for both'),
    locationId: z.number().int().positive().optional().describe('Filter by location ID'),
    page: z.number().int().positive().optional().describe('Page number, default 1'),
    pageSize: z
      .number()
      .int()
      .positive()
      .max(MAX_PAGESIZE)
      .optional()
      .describe(`Page size, default ${DEFAULT_PAGESIZE}, max ${MAX_PAGESIZE}`),
  },
  stEndpoint: { method: 'GET', path: '/payroll/v2/tenant/{tid}/locations/rates', source: 'live' },
  async handler(env, args, { actor, correlation }) {
    const page = args.page ?? 1;
    const pageSize = Math.min(args.pageSize ?? DEFAULT_PAGESIZE, MAX_PAGESIZE);
    const query: Record<string, unknown> = {
      active: args.active,
      locationId: args.locationId,
      page,
      pageSize,
    };

    const data = await readST<{ data?: RawLocationRate[]; hasMore?: boolean }>(
      env,
      { actor, correlation },
      `/payroll/v2/tenant/${env.ST_TENANT_ID}/locations/rates`,
      query,
    );
    return {
      count: (data.data ?? []).length,
      rates: (data.data ?? []).map(slim),
      has_more: !!data.hasMore,
      _source: 'live',
    };
  },
  transformResult: defaultShaper,
};
