import { z } from 'zod';
import { readST } from '../../st';
import { defaultShaper } from '../../response-shape';
import type { ToolDef } from '../index';

interface Args {
  fromWarehouseId?: number;
  toWarehouseId?: number;
  page?: number;
  pageSize?: number;
}

interface RawTransfer {
  id: number;
  number?: string;
  status?: string;
  fromWarehouseId?: number;
  toWarehouseId?: number;
  transferredOn?: string;
}

interface SlimTransfer {
  id: number;
  transfer_number: string;
  status: string;
  from_warehouse_id: number | null;
  to_warehouse_id: number | null;
  date: string | null;
}

function slim(t: RawTransfer): SlimTransfer {
  return {
    id: t.id,
    transfer_number: t.number ?? '',
    status: t.status ?? '',
    from_warehouse_id: t.fromWarehouseId ?? null,
    to_warehouse_id: t.toWarehouseId ?? null,
    date: t.transferredOn ?? null,
  };
}

// Back-office tool (no voice consumer); pageSize tuned for PO/receipt
// enumeration, not voice-tier readback. Compare find_customer's tighter caps.
const DEFAULT_PAGESIZE = 25;
const MAX_PAGESIZE = 100;

export const inventory_transfers_list: ToolDef<Args> = {
  name: 'inventory_transfers_list',
  description:
    'List ServiceTitan inventory transfers between warehouses. Filter by from/to warehouse. Source: live ST.',
  zodSchema: {
    fromWarehouseId: z.number().int().positive().optional().describe('Filter by source warehouse ID'),
    toWarehouseId: z.number().int().positive().optional().describe('Filter by destination warehouse ID'),
    page: z.number().int().positive().optional().describe('Page number, default 1'),
    pageSize: z
      .number()
      .int()
      .positive()
      .max(MAX_PAGESIZE)
      .optional()
      .describe(`Page size, default ${DEFAULT_PAGESIZE}, max ${MAX_PAGESIZE}`),
  },
  stEndpoint: { method: 'GET', path: '/inventory/v2/tenant/{tid}/transfers', source: 'live' },
  async handler(env, args, { actor, correlation }) {
    const page = args.page ?? 1;
    const pageSize = Math.min(args.pageSize ?? DEFAULT_PAGESIZE, MAX_PAGESIZE);
    const query: Record<string, unknown> = {
      fromWarehouseId: args.fromWarehouseId,
      toWarehouseId: args.toWarehouseId,
      page,
      pageSize,
    };

    const data = await readST<{ data?: RawTransfer[]; hasMore?: boolean }>(
      env,
      { actor, correlation },
      `/inventory/v2/tenant/${env.ST_TENANT_ID}/transfers`,
      query,
    );
    return {
      count: (data.data ?? []).length,
      transfers: (data.data ?? []).map(slim),
      has_more: !!data.hasMore,
      _source: 'live',
    };
  },
  transformResult: defaultShaper,
};
