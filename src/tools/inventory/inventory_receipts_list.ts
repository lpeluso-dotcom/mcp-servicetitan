import { z } from 'zod';
import { readST } from '../../st';
import { defaultShaper } from '../../response-shape';
import type { ToolDef } from '../index';

interface Args {
  vendorId?: number;
  warehouseId?: number;
  page?: number;
  pageSize?: number;
}

interface RawReceipt {
  id: number;
  number?: string;
  status?: string;
  vendorId?: number;
  warehouseId?: number;
  receivedOn?: string;
  total?: number;
}

interface SlimReceipt {
  id: number;
  receipt_number: string;
  status: string;
  vendor_id: number | null;
  warehouse_id: number | null;
  date: string | null;
  total: number;
}

function slim(r: RawReceipt): SlimReceipt {
  return {
    id: r.id,
    receipt_number: r.number ?? '',
    status: r.status ?? '',
    vendor_id: r.vendorId ?? null,
    warehouse_id: r.warehouseId ?? null,
    date: r.receivedOn ?? null,
    total: r.total ?? 0,
  };
}

// Back-office tool (no voice consumer); pageSize tuned for PO/receipt
// enumeration, not voice-tier readback. Compare find_customer's tighter caps.
const DEFAULT_PAGESIZE = 25;
const MAX_PAGESIZE = 100;

export const inventory_receipts_list: ToolDef<Args> = {
  name: 'inventory_receipts_list',
  description:
    'List ServiceTitan inventory receipts (incoming items from POs). Filter by vendor or warehouse. Source: live ST.',
  zodSchema: {
    vendorId: z.number().int().positive().optional().describe('Filter by vendor ID'),
    warehouseId: z.number().int().positive().optional().describe('Filter by warehouse ID'),
    page: z.number().int().positive().optional().describe('Page number, default 1'),
    pageSize: z
      .number()
      .int()
      .positive()
      .max(MAX_PAGESIZE)
      .optional()
      .describe(`Page size, default ${DEFAULT_PAGESIZE}, max ${MAX_PAGESIZE}`),
  },
  stEndpoint: { method: 'GET', path: '/inventory/v2/tenant/{tid}/receipts', source: 'live' },
  async handler(env, args, { actor, correlation }) {
    const page = args.page ?? 1;
    const pageSize = Math.min(args.pageSize ?? DEFAULT_PAGESIZE, MAX_PAGESIZE);
    const query: Record<string, unknown> = {
      vendorId: args.vendorId,
      warehouseId: args.warehouseId,
      page,
      pageSize,
    };

    const data = await readST<{ data?: RawReceipt[]; hasMore?: boolean }>(
      env,
      { actor, correlation },
      `/inventory/v2/tenant/${env.ST_TENANT_ID}/receipts`,
      query,
    );
    return {
      count: (data.data ?? []).length,
      receipts: (data.data ?? []).map(slim),
      has_more: !!data.hasMore,
      _source: 'live',
    };
  },
  transformResult: defaultShaper,
};
