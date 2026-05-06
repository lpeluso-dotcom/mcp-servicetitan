import { z } from 'zod';
import { McpError } from '../../errors';
import { authHeaders } from '../../auth';
import { defaultShaper } from '../../response-shape';
import type { ToolDef } from '../index';

interface Args {
  active?: boolean;
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
    active: z.boolean().optional().describe('Filter to active=true or active=false; omit for both'),
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
  async handler(env, args, { actor, correlation }) {
    const page = args.page ?? 1;
    const pageSize = Math.min(args.pageSize ?? DEFAULT_PAGESIZE, MAX_PAGESIZE);
    const qs = new URLSearchParams();
    if (args.active !== undefined) qs.set('active', String(args.active));
    if (args.vendorId !== undefined) qs.set('vendorId', String(args.vendorId));
    if (args.warehouseId !== undefined) qs.set('warehouseId', String(args.warehouseId));
    qs.set('page', String(page));
    qs.set('pageSize', String(pageSize));

    const path = `/inventory/v2/tenant/${env.ST_TENANT_ID}/receipts?${qs}`;
    const resp = await env.ST_PROXY.fetch(
      `https://servicetitan-proxy/api/st/read?endpoint=${encodeURIComponent(path)}`,
      { headers: authHeaders(env, correlation, actor) },
    );
    if (!resp.ok) {
      throw new McpError('upstream_error', `inventory_receipts_list failed: ${resp.status} ${path}`, {
        correlation,
      });
    }
    const data = (await resp.json()) as { data?: RawReceipt[]; hasMore?: boolean };
    return {
      count: (data.data ?? []).length,
      receipts: (data.data ?? []).map(slim),
      has_more: !!data.hasMore,
      _source: 'live',
    };
  },
  transformResult: defaultShaper,
};
