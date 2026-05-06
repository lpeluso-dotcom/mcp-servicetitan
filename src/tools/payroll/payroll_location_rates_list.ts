import { z } from 'zod';
import { McpError } from '../../errors';
import { authHeaders } from '../../auth';
import { defaultShaper } from '../../response-shape';
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
  async handler(env, args, { actor, correlation }) {
    const page = args.page ?? 1;
    const pageSize = Math.min(args.pageSize ?? DEFAULT_PAGESIZE, MAX_PAGESIZE);
    const qs = new URLSearchParams();
    if (args.active !== undefined) qs.set('active', String(args.active));
    // ST endpoint expects `locationIds` (plural) per ServiceTitan API spec — even
    // when filtering by a single ID. Friendly arg name stays singular.
    if (args.locationId !== undefined) qs.set('locationIds', String(args.locationId));
    qs.set('page', String(page));
    qs.set('pageSize', String(pageSize));

    const path = `/payroll/v2/tenant/${env.ST_TENANT_ID}/locations/rates?${qs}`;
    const resp = await env.ST_PROXY.fetch(
      `https://servicetitan-proxy/api/st/read?endpoint=${encodeURIComponent(path)}`,
      { headers: authHeaders(env, correlation, actor) },
    );
    if (!resp.ok) {
      throw new McpError('upstream_error', `payroll_location_rates_list failed: ${resp.status} ${path}`, {
        correlation,
      });
    }
    const data = (await resp.json()) as { data?: RawLocationRate[]; hasMore?: boolean };
    return {
      count: (data.data ?? []).length,
      rates: (data.data ?? []).map(slim),
      has_more: !!data.hasMore,
      _source: 'live',
    };
  },
  transformResult: defaultShaper,
};
