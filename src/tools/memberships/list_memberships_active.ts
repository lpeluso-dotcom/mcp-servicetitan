import { z } from 'zod';
import { McpError } from '../../errors';
import { authHeaders } from '../../auth';
import type { ToolDef } from '../index';

interface Args { customerId?: number; locationId?: number; page?: number; pageSize?: number }

// Fields returned per membership. ST responses include ~35 fields per record,
// most of which are null/unused and blow the MCP result token limit at pageSize > 50.
const ESSENTIAL_FIELDS = [
  'id', 'status', 'customerId', 'locationId', 'membershipTypeId',
  'businessUnitId', 'from', 'to', 'duration', 'billingFrequency',
  'followUpStatus', 'cancellationDate', 'nextScheduledBillDate',
] as const;

function trim(m: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ESSENTIAL_FIELDS) out[k] = m[k];
  return out;
}

export const list_memberships_active: ToolDef<Args> = {
  name: 'list_memberships_active',
  description: 'List active memberships. Reads live from ST. D1-first migration tracked as v1.3 follow-up — Phase 1 D1 sync expansion landed 2026-04-28; `memberships` table is populated but tools haven\'t been flipped to D1-first reads yet. Response is trimmed to essential fields; client-side filtered to status=Active since ST statuses param filters on the meaningless active-bool, not the status enum.',
  zodSchema: {
    customerId: z.number().int().positive().optional().describe('Filter by customer ID'),
    locationId: z.number().int().positive().optional().describe('Filter by location ID'),
    page: z.number().int().positive().default(1).describe('Page number'),
    pageSize: z.number().int().positive().max(100).default(50).describe('Page size, max 100 (capped to keep response under MCP token limit)'),
  },
  async handler(env, args, { actor, correlation }) {
    const qs = new URLSearchParams();
    qs.set('status', 'Active');
    if (args.customerId) qs.set('customerId', String(args.customerId));
    if (args.locationId) qs.set('locationId', String(args.locationId));
    qs.set('page', String(args.page ?? 1));
    qs.set('pageSize', String(args.pageSize ?? 50));

    const resp = await env.TAYLOR_AI.fetch(
      `https://taylor-ai/api/st/read?endpoint=${encodeURIComponent(`/memberships/v2/tenant/431848990/memberships?${qs}`)}`,
      { headers: authHeaders(env, correlation, actor) }
    );
    if (!resp.ok) throw new McpError('upstream_error', `list_memberships_active failed: ${resp.status}`, { correlation });
    const data = await resp.json<{ data?: Record<string, unknown>[] }>();
    const raw = data.data ?? [];
    const activeOnly = raw.filter((m) => m.status === 'Active');
    return {
      memberships: activeOnly.map(trim),
      _source: 'live',
      _filtered: raw.length !== activeOnly.length ? { received: raw.length, kept: activeOnly.length } : undefined,
    };
  },
};
