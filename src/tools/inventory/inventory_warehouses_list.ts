import { z } from 'zod';
import { readST } from '../../st';
import { defaultShaper } from '../../response-shape';
import type { ToolDef } from '../index';

interface Args {
  active?: boolean;
  page?: number;
  pageSize?: number;
}

interface RawAddress {
  street?: string;
  unit?: string | null;
  city?: string;
  state?: string;
  zip?: string;
}

interface RawWarehouse {
  id: number;
  name?: string;
  active?: boolean;
  address?: RawAddress;
}

interface SlimWarehouse {
  id: number;
  name: string;
  active: boolean | null;
  address: string;
}

function buildAddress(a?: RawAddress): string {
  if (!a) return '';
  const parts = [a.street, a.unit, a.city, a.state, a.zip].filter(Boolean);
  return parts.join(', ');
}

function slim(w: RawWarehouse): SlimWarehouse {
  return {
    id: w.id,
    name: w.name ?? '',
    active: w.active ?? null,
    address: buildAddress(w.address),
  };
}

// Back-office tool (no voice consumer); pageSize tuned for PO/receipt
// enumeration, not voice-tier readback. Compare find_customer's tighter caps.
const DEFAULT_PAGESIZE = 25;
const MAX_PAGESIZE = 100;

export const inventory_warehouses_list: ToolDef<Args> = {
  name: 'inventory_warehouses_list',
  description:
    'List ServiceTitan warehouses (storage locations for inventory). Filter by active flag. Returns slim records (id, name, active, address). Source: live ST.',
  zodSchema: {
    active: z.boolean().optional().describe('Filter to active=true or active=false; omit for both'),
    page: z.number().int().positive().optional().describe('Page number, default 1'),
    pageSize: z
      .number()
      .int()
      .positive()
      .max(MAX_PAGESIZE)
      .optional()
      .describe(`Page size, default ${DEFAULT_PAGESIZE}, max ${MAX_PAGESIZE}`),
  },
  stEndpoint: { method: 'GET', path: '/inventory/v2/tenant/{tid}/warehouses', source: 'live' },
  async handler(env, args, { actor, correlation }) {
    const page = args.page ?? 1;
    const pageSize = Math.min(args.pageSize ?? DEFAULT_PAGESIZE, MAX_PAGESIZE);
    const query: Record<string, unknown> = {
      active: args.active,
      page,
      pageSize,
    };

    const data = await readST<{ data?: RawWarehouse[]; hasMore?: boolean }>(
      env,
      { actor, correlation },
      `/inventory/v2/tenant/${env.ST_TENANT_ID}/warehouses`,
      query,
    );
    return {
      count: (data.data ?? []).length,
      warehouses: (data.data ?? []).map(slim),
      has_more: !!data.hasMore,
      _source: 'live',
    };
  },
  transformResult: defaultShaper,
};
