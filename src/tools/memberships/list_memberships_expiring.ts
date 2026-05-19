import { z } from 'zod';
import { readST } from '../../st';
import type { ToolDef } from '../index';

interface Args { windowDays: number; customerId?: number; page?: number; pageSize?: number }

// ST response fields kept. See list_memberships_active for rationale.
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

// Semantics pinned: 'to' BETWEEN now AND now+windowDays AND status='Active'.
// Do NOT use renewedById — unreliable per local operations notes.
export const list_memberships_expiring: ToolDef<Args> = {
  name: 'list_memberships_expiring',
  description: 'List active memberships expiring within the next N days. Uses expirationDate range filter (NOT renewedById — unreliable). Response is trimmed to essential fields; client-side filtered to status=Active. Reads live from ST. D1-first migration tracked as v1.3 follow-up — Phase 1 D1 sync expansion landed 2026-04-28; `memberships` table is populated but tools haven\'t been flipped to D1-first reads yet.',
  zodSchema: {
    windowDays: z.number().int().positive().describe('Number of days ahead to look for expiring memberships (e.g. 30 = expiring within 30 days)'),
    customerId: z.number().int().positive().optional().describe('Filter by customer ID'),
    page: z.number().int().positive().default(1).describe('Page number'),
    pageSize: z.number().int().positive().max(100).default(50).describe('Page size, max 100 (capped to keep response under MCP token limit)'),
  },
  stEndpoint: { method: 'GET', path: '/memberships/v2/tenant/{tid}/memberships', source: 'live' },
  async handler(env, args, { actor, correlation }) {
    const now = new Date();
    const windowEnd = new Date(now.getTime() + args.windowDays * 24 * 60 * 60 * 1000);

    const query: Record<string, unknown> = {
      status: 'Active',
      activeThroughOnOrAfter: now.toISOString(),
      activeThroughBefore: windowEnd.toISOString(),
      customerId: args.customerId,
      page: args.page ?? 1,
      pageSize: args.pageSize ?? 50,
    };

    const data = await readST<{ data?: Record<string, unknown>[] }>(
      env,
      { actor, correlation },
      `/memberships/v2/tenant/000000000/memberships`,
      query,
    );
    const raw = data.data ?? [];
    const activeOnly = raw.filter((m) => m.status === 'Active');
    return {
      memberships: activeOnly.map(trim),
      windowDays: args.windowDays,
      _source: 'live',
      _filtered: raw.length !== activeOnly.length ? { received: raw.length, kept: activeOnly.length } : undefined,
    };
  },
};
