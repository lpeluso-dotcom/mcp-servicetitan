// ============================================================
// ap_inbox_dedup_check — QUA-1167.
//
// Answers: "has this AP-inbox document already been filed, or is it already
// sitting in the pending queue twice?"
//
// THE BUG THIS EXISTS TO FIX. extract-classify.js:36 filters to
// billWasCreated === false before anything downstream runs, so the skill's
// dedup can only ever compare pending rows to each other. A re-forwarded PDF
// arrives under a NEW documentId and slips straight through. file-bills.js:50
// does skip billWasCreated rows, but that is same-document idempotency, not
// cross-document dedup — a guard that has never failed because it cannot.
//
// Cost of the gap: 87 duplicates / $65,085.37 undetected on 2026-08-01, and a
// ~$113K near-miss when 237 of 457 forwarded invoices turned out to be
// already-filed bills.
//
// TWO INDEPENDENT CHECKS ARE REQUIRED. Each is blind to what the other sees:
//   - candidate vs created  — catches the re-forwarded PDF. (validateVdn's job,
//     except validateVdn's real path is unknown and it 404s on every guess.)
//   - pending self-join     — catches intra-pending duplicates. On 2026-08-05
//     all 42 pending returned "not already entered" while three same-invoice
//     pairs sat inside the pending set.
//
// Pure computation: no network, no session cookie. Feed it the rows from
// ap_inbox_list_documents.
// ============================================================

import { z } from 'zod';
import type { ToolDef } from '../index';

/** Amounts must agree to the penny — the 2026-08-17 pre-check standard. */
const AMOUNT_TOLERANCE = 0.01;

/**
 * Uppercase, strip ALL whitespace, strip leading zeros.
 *
 * DO NOT TRUNCATE AT THE FIRST SPACE. Real invoice numbers contain one —
 * Winsupply prints `396175 01`, and Carolina prints job numbers space-split as
 * `8480 9343`. A naive `\S+` parse silently halves them.
 *
 * Suffixes are deliberately NOT stripped: Johnstone's `.001` (page sequence)
 * and McCall's `-2026-07-07` (embedded date) do cause missed duplicates, but a
 * page-split invoice carries a DIFFERENT amount and so fails the amount gate
 * anyway. Revisit with evidence, not by guess.
 */
export function normalizeInvoiceNumber(raw: unknown): string {
  if (raw === null || raw === undefined) return '';
  const s = String(raw)
    .toUpperCase()
    .replace(/\s+/g, '');
  if (s === '') return '';
  const stripped = s.replace(/^0+/, '');
  // '000' must not collapse to '' — that would make every zero-ish invoice
  // number look identical (and equal to "no invoice number at all").
  return stripped === '' ? '0' : stripped;
}

function slug(name: unknown): string {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function positiveId(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * A single canonical key for one bill's vendor — id when we have one, else a
 * punctuation-stripped name slug.
 *
 * dedup-and-bucket.py keys on `(v.lower().strip(), inv)`, which does no
 * punctuation handling at all, so `"MCCALL'S SUPPLY, INC"` and
 * `"McCall's Supply Inc."` land in different buckets. That let two real
 * duplicates escape: inv 3873769 ($241.09) and 3872849 ($3,993.33). Without a
 * manual re-check, $241.09 would have been filed twice.
 *
 * NOTE this is the key for grouping/display. Pairwise comparison uses
 * `vendorsMatch`, because one side often has an id and the other does not —
 * ST auto-matched a vendorId on only 17 of 35 rows on 2026-08-21.
 */
export function normalizeVendorKey(v: { vendor_id?: unknown; vendor_name?: unknown }): string {
  const id = positiveId(v.vendor_id);
  return id ? `id:${id}` : slug(v.vendor_name);
}

/** True when two rows are the same vendor. Ids win when BOTH sides have one. */
export function vendorsMatch(
  a: { vendor_id?: unknown; vendor_name?: unknown },
  b: { vendor_id?: unknown; vendor_name?: unknown },
): boolean {
  const aid = positiveId(a.vendor_id);
  const bid = positiveId(b.vendor_id);
  if (aid && bid) return aid === bid;
  const as = slug(a.vendor_name);
  const bs = slug(b.vendor_name);
  return as !== '' && as === bs;
}

export interface BillRef {
  document_id?: number | null;
  ocr_result_id?: number | null;
  vendor_name?: unknown;
  vendor_id?: unknown;
  vendor_invoice_number?: unknown;
  total_amount?: unknown;
}

interface MatchRow {
  source: 'created' | 'pending';
  document_id: number | null;
  ocr_result_id: number | null;
  vendor_name: string;
  vendor_invoice_number: string;
  total_amount: number;
}

export interface DedupResult {
  is_duplicate: boolean;
  normalized: { vendor_key: string; invoice_number: string };
  matched_against: MatchRow[];
  /** Same invoice + vendor, DIFFERENT amount. Not a duplicate; still worth a human's eye. */
  ambiguous_matches: MatchRow[];
  checks_run: string[];
  reason: string;
}

function amount(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function toRow(b: BillRef, source: 'created' | 'pending'): MatchRow {
  return {
    source,
    document_id: b.document_id ?? null,
    ocr_result_id: b.ocr_result_id ?? null,
    vendor_name: String(b.vendor_name ?? ''),
    vendor_invoice_number: String(b.vendor_invoice_number ?? ''),
    total_amount: amount(b.total_amount),
  };
}

export function dedupCheck(input: {
  candidate: BillRef;
  created_bills?: BillRef[];
  pending_bills?: BillRef[];
}): DedupResult {
  const { candidate } = input;
  const created = input.created_bills ?? [];
  const pendingProvided = Array.isArray(input.pending_bills);
  const pending = input.pending_bills ?? [];

  const inv = normalizeInvoiceNumber(candidate.vendor_invoice_number);
  const vendorKey = normalizeVendorKey(candidate);
  const amt = amount(candidate.total_amount);

  const checks_run = ['created_bills', ...(pendingProvided ? ['pending_self_join'] : [])];

  // No invoice number means no primary key. Refuse to judge rather than
  // return a confident "not a duplicate" — an unenriched row (see
  // ap_inbox_list_documents `enrich`) looks exactly like this.
  if (inv === '') {
    return {
      is_duplicate: false,
      normalized: { vendor_key: vendorKey, invoice_number: '' },
      matched_against: [],
      ambiguous_matches: [],
      checks_run,
      reason:
        'Candidate has no vendor invoice number, which is the primary dedup key — cannot judge. ' +
        'If this row came from ap_inbox_list_documents, re-fetch it with enrich:true; the invoice ' +
        'number is not on the list row. NOT a clearance to file.',
    };
  }

  const matched: MatchRow[] = [];
  const ambiguous: MatchRow[] = [];

  const scan = (rows: BillRef[], source: 'created' | 'pending') => {
    for (const row of rows) {
      // Never match the candidate against itself in the pending set.
      if (
        source === 'pending' &&
        row.document_id === candidate.document_id &&
        row.ocr_result_id === candidate.ocr_result_id
      ) {
        continue;
      }
      const rowInv = normalizeInvoiceNumber(row.vendor_invoice_number);
      if (rowInv === '' || rowInv !== inv) continue;
      if (!vendorsMatch(candidate, row)) continue;

      // Invoice + vendor agree. The amount decides duplicate vs ambiguous.
      if (Math.abs(amount(row.total_amount) - amt) < AMOUNT_TOLERANCE) {
        matched.push(toRow(row, source));
      } else {
        ambiguous.push(toRow(row, source));
      }
    }
  };

  scan(created, 'created');
  if (pendingProvided) scan(pending, 'pending');

  const is_duplicate = matched.length > 0;

  let reason: string;
  if (is_duplicate) {
    const where = [...new Set(matched.map((m) => m.source))].join(' + ');
    reason =
      `DUPLICATE — invoice ${inv}, vendor, and amount ${amt.toFixed(2)} all agree with ` +
      `${matched.length} row(s) in: ${where}. DO NOT FILE; filing double-counts this cost onto the job.`;
  } else if (ambiguous.length > 0) {
    reason =
      `Not a duplicate: invoice ${inv} and vendor match ${ambiguous.length} row(s), but the amount ` +
      `differs from ${amt.toFixed(2)}. Could be a page split or a partial credit — have a human look ` +
      `before filing.`;
  } else {
    reason = `No duplicate found for invoice ${inv} across ${checks_run.join(' + ')}.`;
  }

  // A caller who omits pending_bills gets only half the guarantee. Say so
  // rather than letting a clean verdict imply both checks ran.
  if (!pendingProvided) {
    reason +=
      ' WARNING: pending_bills was not supplied, so the intra-pending self-join did NOT run. ' +
      'This verdict cannot see a duplicate that is sitting elsewhere in the pending queue.';
  }

  return {
    is_duplicate,
    normalized: { vendor_key: vendorKey, invoice_number: inv },
    matched_against: matched,
    ambiguous_matches: ambiguous,
    checks_run,
    reason,
  };
}

const BillRefSchema = z
  .object({
    document_id: z.number().nullish(),
    ocr_result_id: z.number().nullish(),
    vendor_name: z.unknown().optional(),
    vendor_id: z.unknown().optional(),
    vendor_invoice_number: z.unknown().optional(),
    total_amount: z.unknown().optional(),
  })
  .passthrough();

interface Args {
  candidate: BillRef;
  created_bills?: BillRef[];
  pending_bills?: BillRef[];
}

export const ap_inbox_dedup_check: ToolDef<Args> = {
  name: 'ap_inbox_dedup_check',
  description:
    'Check whether an AP-inbox document duplicates a bill that is ALREADY FILED in ServiceTitan, or ' +
    'another row already in the pending queue. Requires invoice number + vendor + amount to all agree ' +
    'before flagging. Handles OCR vendor-name variants and zero-padded / space-containing invoice ' +
    'numbers. Feed it rows from ap_inbox_list_documents (enrich:true — the invoice number is not on the ' +
    'list row). Source: computed — pure set logic over rows you pass in, no ServiceTitan call and no ' +
    'session needed. Do NOT rely on ST\'s own isBillDuplicate flag: it caught zero of 7 real ' +
    'duplicates on 2026-08-17.',
  zodSchema: {
    candidate: BillRefSchema.describe(
      'The document being considered for filing. Needs vendor_invoice_number, total_amount, and either vendor_id or vendor_name.',
    ),
    created_bills: z
      .array(BillRefSchema)
      .optional()
      .describe(
        'Rows already filed in ServiceTitan (billWasCreated === true, status 3). This is the set the skill is structurally blind to and the reason QUA-1167 exists.',
      ),
    pending_bills: z
      .array(BillRefSchema)
      .optional()
      .describe(
        'Other rows still pending (status 2), for the intra-pending self-join. Omitting this disables that check and the result says so — supply it whenever you have it.',
      ),
  },
  stEndpoint: { method: 'GET', path: '(computed — no ServiceTitan call)', source: 'computed' },
  async handler(_env, args) {
    return dedupCheck(args);
  },
};
