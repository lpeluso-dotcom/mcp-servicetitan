import { z } from 'zod';
import { readST } from '../../st';
import { defaultShaper } from '../../response-shape';
import type { ToolDef } from '../index';

interface Args {
  active?: boolean;
  page?: number;
  pageSize?: number;
}

interface RawVendor {
  id: number;
  name?: string;
  active?: boolean;
  phone?: string | null;
  email?: string | null;
}

interface SlimVendor {
  id: number;
  name: string;
  active: boolean | null;
  phone: string | null;
  email: string | null;
}

function slim(v: RawVendor): SlimVendor {
  return {
    id: v.id,
    name: v.name ?? '',
    active: v.active ?? null,
    phone: v.phone ?? null,
    email: v.email ?? null,
  };
}

// Back-office tool (no voice consumer); pageSize tuned for PO/receipt
// enumeration, not voice-tier readback. Compare find_customer's tighter caps.
const DEFAULT_PAGESIZE = 25;
const MAX_PAGESIZE = 100;

export const inventory_vendors_list: ToolDef<Args> = {
  name: 'inventory_vendors_list',
  description: 'List ServiceTitan inventory vendors. Optionally filter by active flag. Returns slim records (id, name, active, phone, email). Source: live ST.',
  zodSchema: {
    active: z.boolean().optional().describe('Filter to active=true or active=false; omit for both'),
    page: z.number().int().positive().optional().describe('Page number, default 1'),
    pageSize: z.number().int().positive().max(MAX_PAGESIZE).optional().describe(`Page size, default ${DEFAULT_PAGESIZE}, max ${MAX_PAGESIZE}`),
  },
  stEndpoint: { method: 'GET', path: '/inventory/v2/tenant/{tid}/vendors', source: 'live' },
  async handler(env, args, { actor, correlation }) {
    const page = args.page ?? 1;
    const pageSize = Math.min(args.pageSize ?? DEFAULT_PAGESIZE, MAX_PAGESIZE);
    const query: Record<string, unknown> = {
      active: args.active,
      page,
      pageSize,
    };

    const data = await readST<{ data?: RawVendor[]; hasMore?: boolean }>(
      env,
      { actor, correlation },
      `/inventory/v2/tenant/${env.ST_TENANT_ID}/vendors`,
      query,
    );
    return {
      count: (data.data ?? []).length,
      vendors: (data.data ?? []).map(slim),
      has_more: !!data.hasMore,
      _source: 'live',
    };
  },
  transformResult: defaultShaper,
};
