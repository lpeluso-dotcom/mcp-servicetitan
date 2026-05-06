import { z } from 'zod';
import { McpError } from '../../errors';
import { authHeaders } from '../../auth';
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
  async handler(env, args, { actor, correlation }) {
    const page = args.page ?? 1;
    const pageSize = Math.min(args.pageSize ?? DEFAULT_PAGESIZE, MAX_PAGESIZE);
    const qs = new URLSearchParams();
    if (args.fromWarehouseId !== undefined) qs.set('fromWarehouseId', String(args.fromWarehouseId));
    if (args.toWarehouseId !== undefined) qs.set('toWarehouseId', String(args.toWarehouseId));
    qs.set('page', String(page));
    qs.set('pageSize', String(pageSize));

    const path = `/inventory/v2/tenant/${env.ST_TENANT_ID}/transfers?${qs}`;
    const resp = await env.ST_PROXY.fetch(
      `https://servicetitan-proxy/api/st/read?endpoint=${encodeURIComponent(path)}`,
      { headers: authHeaders(env, correlation, actor) },
    );
    if (!resp.ok) {
      throw new McpError('upstream_error', `inventory_transfers_list failed: ${resp.status} ${path}`, {
        correlation,
      });
    }
    const data = (await resp.json()) as { data?: RawTransfer[]; hasMore?: boolean };
    return {
      count: (data.data ?? []).length,
      transfers: (data.data ?? []).map(slim),
      has_more: !!data.hasMore,
      _source: 'live',
    };
  },
  transformResult: defaultShaper,
};
