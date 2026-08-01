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

/**
 * ST page size used while draining. Large, because every page is a round trip
 * and most rows get discarded by the balance filter.
 */
const ST_SCAN_PAGE_SIZE = 200;

/**
 * Hard ceiling on pages walked in one call — 5,000 invoices at the size above.
 * Without it, a tenant-wide call with no filters would walk the entire invoice
 * history. When this bites, the response says so rather than passing off a
 * partial scan as a complete one.
 */
const MAX_SCAN_PAGES = 25;

export const list_unpaid_invoices: ToolDef<Args> = {
  name: 'list_unpaid_invoices',
  description:
    'List invoices with an outstanding balance (unpaid or partially paid). Source: live ST (accounting invoices, ' +
    'filtered client-side to balance ≠ 0; cached 120s). ST ignores its own balance filter, so pages are drained and ' +
    'windowed locally. Check `_scan_complete`: when false the scan hit its page budget and the result is NOT ' +
    'exhaustive — an empty list then means "stopped looking", not "nothing outstanding".',
  zodSchema: {
    businessUnitId: z.number().int().positive().optional().describe('Filter by business unit ID'),
    customerId: z.number().int().positive().optional().describe('Filter by customer ID'),
    page: z.number().int().positive().default(1).describe('Page number'),
    pageSize: z.number().int().positive().max(200).default(50).describe('Page size, max 200'),
  },
  // Envelope precise (invoices/_source always present). `invoices` holds raw
  // ST accounting-invoice resources — kept permissive (record) against live
  // payload drift.
  //
  // The scan-disclosure fields are part of the envelope, not decoration: the
  // SDK validates structuredContent against this schema at RUNTIME on every
  // call, so an undeclared field fails the tool call in production.
  outputSchema: {
    invoices: z.array(z.record(z.string(), z.unknown())),
    _source: z.string(),
    _scan_complete: z.boolean(),
    _pages_scanned: z.number(),
    _unpaid_found: z.number(),
    _warning: z.string().optional(),
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
      // QUA-1108: because the filter is client-side, page/pageSize must NOT be
      // forwarded to ST. They used to be, which applied them to the UNFILTERED
      // set — so an ST page that happened to be entirely paid returned a bare
      // `[]` while unpaid invoices sat on the next page. Jessica's runbook
      // points her at this tool for A/R, so that read as "you're all caught up".
      //
      // Instead: drain ST pages at a large fixed size and window the FILTERED
      // set locally, stopping as soon as the caller's window is filled. Three
      // exits — window filled, source exhausted, page budget hit — and the
      // caller is told which, because "no unpaid invoices" and "stopped
      // looking" must never look alike.
      const baseQuery: Record<string, unknown> = {};
      if (args.businessUnitId) baseQuery.businessUnitIds = args.businessUnitId;
      if (args.customerId) baseQuery.customerId = args.customerId;

      const needed = page * pageSize;
      const unpaid: RawInvoice[] = [];
      let stPage = 1;
      let exhausted = false;

      while (unpaid.length < needed && stPage <= MAX_SCAN_PAGES) {
        const data = await readST<{ data?: RawInvoice[]; hasMore?: boolean }>(
          env,
          { actor, correlation },
          '/accounting/v2/tenant/000000000/invoices',
          { ...baseQuery, page: stPage, pageSize: ST_SCAN_PAGE_SIZE },
        );
        const rows = data.data ?? [];
        for (const invoice of rows) {
          // malformed balance → keep row visible rather than silently hiding it
          const n = Number(invoice.balance ?? 0);
          if (!Number.isFinite(n) || n !== 0) unpaid.push(invoice);
        }
        if (!data.hasMore) { exhausted = true; break; }
        stPage += 1;
      }

      const pagesScanned = Math.min(stPage, MAX_SCAN_PAGES);
      const scanComplete = exhausted || unpaid.length >= needed;
      const invoices = unpaid.slice((page - 1) * pageSize, needed);

      return {
        invoices,
        _source: 'live',
        _scan_complete: scanComplete,
        _pages_scanned: pagesScanned,
        _unpaid_found: unpaid.length,
        ...(scanComplete ? {} : {
          _warning:
            `page budget reached: scanned ${pagesScanned} ST pages ` +
            `(${pagesScanned * ST_SCAN_PAGE_SIZE} invoices) without exhausting the source, ` +
            `so this result is NOT exhaustive — more unpaid invoices may exist. ` +
            `Narrow with businessUnitId or customerId for a complete answer.`,
        }),
      };
    });
  },
  transformResult: defaultShaper,
};
