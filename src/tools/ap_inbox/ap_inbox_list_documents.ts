// ============================================================
// ap_inbox_list_documents — QUA-1167.
//
// Lists AP-inbox documents across the pending/created boundary. That span is
// the whole point: extract-classify.js:36 filters to billWasCreated === false
// before anything downstream runs, which is why the skill's dedup is
// structurally incapable of seeing an already-filed bill.
//
// COST SHAPE. The list call is cheap — one request per status, pageSize up to
// 2000, and totalCount comes back without paging. The per-document
// ReadBillDocument sweep is NOT cheap: 516 calls took ~19 minutes at ~0.45
// rows/sec, which exceeds a Worker's wall clock and approaches the
// 1000-subrequest ceiling. So enrichment is opt-in, capped, and resumable via
// a cursor.
// ============================================================

import { z } from 'zod';
import { apInboxFetch, unwrap, type ApInboxAuth } from '../../ap-inbox';
import { McpError } from '../../errors';
import { normalizeInvoiceNumber } from './ap_inbox_dedup_check';
import type { ToolDef } from '../index';

/** GetBillDocuments status codes, confirmed live 2026-08-21 and 2026-08-24. */
export const STATUS = {
  SCAN_PENDING: 1,
  PENDING: 2, // "Ready" — the work queue
  CREATED: 3, // "Reviewed" — already filed
  EMPTY: 4,
} as const;

const DEFAULT_STATUSES = [STATUS.PENDING, STATUS.CREATED];
const DEFAULT_PAGE_SIZE = 1000;
const MAX_PAGE_SIZE = 2000;
const DEFAULT_ENRICH_LIMIT = 50;
const MAX_ENRICH_LIMIT = 200;

/** A GetBillDocuments row. Verified live: exactly 13 keys, `vendorName` among them. */
interface RawRow {
  id: number;
  ocrResultId: number;
  originalFilename?: string;
  filename?: string;
  vendorName?: string;
  documentType?: number;
  date?: string;
  status?: number;
  scanComplete?: boolean;
  billWasCreated?: boolean;
  totalAmount?: number;
  documentCount?: number;
  currentDocument?: number;
}

interface SlimDocument {
  document_id: number;
  ocr_result_id: number;
  original_filename: string;
  vendor_name: string;
  total_amount: number;
  status: number;
  scan_complete: boolean;
  bill_was_created: boolean;
  /** Enrich-only. null means NOT FETCHED, not "this bill has none". See `enriched`. */
  vendor_invoice_number: string | null;
  vendor_id: number | null;
  is_bill_duplicate: boolean | null;
}

// NOTE there is deliberately no `created_bill_id`. It does not exist on any
// ServiceTitan read surface — the row carries only the boolean
// `billWasCreated`, and the billId appears solely in the
// createBillPantheonDemo response, whose field name was never captured (all 44
// calls on 2026-08-17 returned None). Shipping an always-null field would
// imply the question is answerable. It is not.
function slim(r: RawRow): SlimDocument {
  return {
    document_id: r.id, // the row calls it `id`; ReadBillDocument calls it documentId
    ocr_result_id: r.ocrResultId,
    original_filename: r.originalFilename ?? '',
    vendor_name: r.vendorName ?? '',
    total_amount: Number(r.totalAmount ?? 0),
    status: Number(r.status ?? 0),
    scan_complete: !!r.scanComplete,
    bill_was_created: !!r.billWasCreated,
    vendor_invoice_number: null,
    vendor_id: null,
    is_bill_duplicate: null,
  };
}

interface Args extends ApInboxAuth {
  statuses?: number[];
  page_size?: number;
  enrich?: boolean;
  enrich_limit?: number;
  enrich_cursor?: number;
}

export const ap_inbox_list_documents: ToolDef<Args> = {
  name: 'ap_inbox_list_documents',
  description:
    'List ServiceTitan AP-inbox documents across BOTH the pending queue and already-created bills ' +
    '(statuses [2,3] by default). Seeing across that boundary is required to detect a re-forwarded ' +
    'invoice, which arrives under a new documentId. Returns vendor_name, total_amount and ' +
    'bill_was_created from the cheap list call; set enrich:true to also fetch vendor_invoice_number ' +
    'per document (bounded by enrich_limit, resumable via next_cursor — the full sweep is ~0.45 ' +
    'rows/sec and will not fit in one request). Source: live ST — the session-cookie internal API at ' +
    'go.servicetitan.com/app/api/accounting/inbox, which has no OAuth equivalent, so the caller must ' +
    'supply a browser session. Nothing is stored.',
  zodSchema: {
    session_cookie: z
      .string()
      .min(1)
      .describe(
        'Raw Cookie header from a live go.servicetitan.com session — must include .AspNetCore.AUTH*, __cf_bm and cf_clearance. Capture via DevTools "Copy as cURL" on any /app/api/* request. Never stored; redacted from the audit log.',
      ),
    csrf_token: z
      .string()
      .min(1)
      .describe(
        'URL-DECODED value of the X-CSRF-Token cookie from the same capture. Never stored; redacted from the audit log.',
      ),
    statuses: z
      .array(z.number().int())
      .optional()
      .describe(
        'Which document statuses to fetch: 1=scan pending, 2=pending/Ready, 3=created/Reviewed, 4=empty. Default [2,3]. Narrowing to [2] reintroduces the QUA-1167 blind spot — do it only for a deliberate pending-only view.',
      ),
    page_size: z
      .number()
      .int()
      .positive()
      .max(MAX_PAGE_SIZE)
      .optional()
      .describe(`Rows per status request. Default ${DEFAULT_PAGE_SIZE}, max ${MAX_PAGE_SIZE}.`),
    enrich: z
      .boolean()
      .optional()
      .describe(
        'Fetch ReadBillDocument per document to fill vendor_invoice_number / vendor_id / is_bill_duplicate. Default false. Required before ap_inbox_dedup_check can judge anything.',
      ),
    enrich_limit: z
      .number()
      .int()
      .positive()
      .max(MAX_ENRICH_LIMIT)
      .optional()
      .describe(
        `Max per-document reads in one call. Default ${DEFAULT_ENRICH_LIMIT}, max ${MAX_ENRICH_LIMIT}. Keeps the request inside the Worker's wall clock and subrequest budget.`,
      ),
    enrich_cursor: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Row offset to resume enrichment from. Pass the previous call\'s next_cursor. Default 0.'),
  },
  stEndpoint: {
    method: 'POST',
    path: '/app/api/accounting/inbox/GetBillDocuments',
    source: 'live',
  },
  async handler(_env, args, { correlation }) {
    const auth: ApInboxAuth = {
      session_cookie: args.session_cookie,
      csrf_token: args.csrf_token,
    };
    const statuses = args.statuses?.length ? args.statuses : DEFAULT_STATUSES;
    const pageSize = Math.min(args.page_size ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

    const documents: SlimDocument[] = [];
    const total_by_status: Record<string, number> = {};

    // ONE REQUEST PER STATUS, not status:[2,3] in a single call.
    //
    // ServiceTitan silently ignores parameters it does not understand and
    // returns an unfiltered page as HTTP 200 (QUA-1054/QUA-951) — the defect
    // class rejectUnsupportedSTFilters exists to prevent. The array form is
    // only ever observed with a single element. If ST honoured just the first
    // element we would silently get pending-only, which is exactly the
    // blindness this tool exists to fix. Per-status calls make that
    // unobservable failure impossible, and cost one extra request.
    for (const status of statuses) {
      const page = await apInboxFetch<{ result?: RawRow[]; totalCount?: number }>(
        auth,
        '/GetBillDocuments',
        {
          method: 'POST',
          correlation,
          body: {
            search: '',
            status: [status],
            orderBy: 'date',
            desc: true,
            pageIndex: 1,
            pageSize,
          },
        },
      );

      const rows = page.result ?? [];

      // Assert the filter was actually applied. A wrong answer is worse than
      // no answer: silently accepting rows of another status would make a
      // "pending only" view quietly include filed bills, or vice versa.
      const wrong = rows.find((r) => Number(r.status) !== status);
      if (wrong) {
        throw new McpError(
          'upstream_error',
          `GetBillDocuments was asked for status ${status} but returned a row with status ` +
            `${wrong.status} (document ${wrong.id}). ServiceTitan appears to have dropped the ` +
            `status filter and returned an unfiltered page. Refusing to return data that would ` +
            `look like a filtered result.`,
          { correlation },
        );
      }

      total_by_status[String(status)] = Number(page.totalCount ?? rows.length);
      documents.push(...rows.map(slim));
    }

    // ── Optional, bounded enrichment ──────────────────────────────────────
    const enrich = args.enrich === true;
    const cursor = args.enrich_cursor ?? 0;
    const limit = Math.min(args.enrich_limit ?? DEFAULT_ENRICH_LIMIT, MAX_ENRICH_LIMIT);
    let next_cursor: number | null = null;

    if (enrich) {
      const end = Math.min(cursor + limit, documents.length);
      for (let i = cursor; i < end; i++) {
        const d = documents[i];
        const detail = await apInboxFetch<{ isBillDuplicate?: boolean; billData?: Record<string, unknown> }>(
          auth,
          '/ReadBillDocument',
          {
            method: 'GET',
            correlation,
            query: { documentId: d.document_id, ocrResultId: d.ocr_result_id },
          },
        );
        const bd = detail.billData ?? {};
        const invRaw = unwrap(bd.vendorDocumentNumber);
        d.vendor_invoice_number = normalizeInvoiceNumber(invRaw) || null;

        // purchasingVendor.value is the vendorId and is often null — ST
        // auto-matched only 17 of 35 rows on 2026-08-21. .text is the OCR name.
        const pv = bd.purchasingVendor as { value?: unknown; text?: unknown } | undefined;
        const vid = Number(pv?.value);
        d.vendor_id = Number.isFinite(vid) && vid > 0 ? vid : null;
        if (!d.vendor_name && typeof pv?.text === 'string') d.vendor_name = pv.text;

        // ST's own flag. ADVISORY ONLY — it caught zero of 7 real duplicates
        // on 2026-08-17 (false on all 115 pending). Never branch on it.
        d.is_bill_duplicate = detail.isBillDuplicate ?? null;
      }
      if (end < documents.length) next_cursor = end;
    }

    return {
      count: documents.length,
      statuses_requested: statuses,
      total_by_status,
      enriched: enrich,
      // Makes the null-vs-not-fetched distinction explicit. An unenriched
      // vendor_invoice_number is null because we did not ask, NOT because the
      // bill has none — treating those the same is how a dedup check returns a
      // confident false negative.
      enrich_note: enrich
        ? `Enriched rows ${cursor}..${Math.min(cursor + limit, documents.length) - 1}.` +
          (next_cursor !== null
            ? ` ${documents.length - next_cursor} rows still unenriched — call again with enrich_cursor:${next_cursor}.`
            : ' All rows enriched.')
        : 'NOT ENRICHED: vendor_invoice_number/vendor_id/is_bill_duplicate are null because they were not fetched, not because the bills lack them. ap_inbox_dedup_check cannot judge these rows.',
      next_cursor,
      documents,
      _source: 'live-internal',
    };
  },
};
