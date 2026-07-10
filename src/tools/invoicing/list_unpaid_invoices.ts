import { z } from 'zod';
import { readST } from '../../st';
import { cacheGet } from '../../cache';
import type { ToolDef } from '../index';
import { defaultShaper } from '../../response-shape';

interface Args { businessUnitId?: number; customerId?: number; page?: number; pageSize?: number }

interface RawInvoice {
  balance?: number | string | null;
  [key: string]: unknown;
}

export const list_unpaid_invoices: ToolDef<Args> = {
  name: 'list_unpaid_invoices',
  description: 'List invoices with an outstanding balance (unpaid or partially paid). Source: live ST (accounting invoices, filtered client-side to balance ≠ 0; cached 120s). Default page size 50, max 200.',
  zodSchema: {
    businessUnitId: z.number().int().positive().optional().describe('Filter by business unit ID'),
    customerId: z.number().int().positive().optional().describe('Filter by customer ID'),
    page: z.number().int().positive().default(1).describe('Page number'),
    pageSize: z.number().int().positive().max(200).default(50).describe('Page size, max 200'),
  },
  // Envelope precise (invoices/_source always present). `invoices` holds raw
  // ST accounting-invoice resources — kept permissive (record) against live
  // payload drift.
  outputSchema: {
    invoices: z.array(z.record(z.string(), z.unknown())),
    _source: z.string(),
  },
  stEndpoint: { method: 'GET', path: '/accounting/v2/tenant/{tid}/invoices', source: 'live' },
  async handler(env, args, { actor, correlation }) {
    const page = args.page ?? 1;
    const pageSize = args.pageSize ?? 50;
    const cacheKey = JSON.stringify({ bu: args.businessUnitId ?? 0, customer: args.customerId ?? 0, page, pageSize });

    return cacheGet(env, 'servicetitan:list_unpaid_invoices', cacheKey, 120, async () => {
      // balanceExcludeZero is NOT sent — ST's /accounting/v2/tenant/{tid}/invoices
      // endpoint silently ignores it (confirmed against the D1 mirror: the real
      // unpaid-invoice count doesn't match what this endpoint returns with the
      // param set). Same failure class as list_jobs_today's scheduledOnOrAfter/
      // Before params (QUA-649 / fixed for jobs in PR #41) — filter client-side
      // instead of trusting ST to honor an unsupported param.
      //
      // Known limitation carried over from the pre-fix behavior: page/pageSize
      // are still applied server-side against the UNFILTERED set, so a page can
      // legitimately come back with fewer than `pageSize` unpaid invoices (or
      // zero) even when more exist on later pages — this doesn't drain pages
      // the way list_jobs_today's appointment fix does. Fine for QUA-649's
      // immediate correctness bug; a full pagination-aware rewrite is a
      // separate, larger follow-up.
      const query: Record<string, unknown> = { page, pageSize };
      if (args.businessUnitId) query.businessUnitIds = args.businessUnitId;
      if (args.customerId) query.customerId = args.customerId;

      const data = await readST<{ data?: RawInvoice[] }>(
        env,
        { actor, correlation },
        '/accounting/v2/tenant/000000000/invoices',
        query,
      );
      const invoices = (data.data ?? []).filter((inv) => {
        // malformed balance → keep row visible rather than silently hiding it
        const n = Number(inv.balance ?? 0);
        return !Number.isFinite(n) || n !== 0;
      });
      return { invoices, _source: 'live' };
    });
  },
  transformResult: defaultShaper,
};
