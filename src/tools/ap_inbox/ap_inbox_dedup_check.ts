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
  // Strip punctuation as well as whitespace, for the same reason `slug` does
  // it to vendor names: OCR adds a leading '#' or a trailing '.' often enough
  // that leaving them in defeats the PRIMARY dedup key. The first version
  // stripped whitespace only, so '#3873769' and '3873769' were different
  // invoices — a stricter standard applied to the noisier field than to the
  // decisive one.
  const s = String(raw)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
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

/**
 * Do two rows name the same vendor? Tri-state: `null` means UNKNOWN.
 *
 * Unknown is a real answer here and must not collapse to `false`. ST
 * auto-matched a vendorId on only 17 of 35 rows (2026-08-21) and `slim()`
 * defaults a missing name to `''`, so a row carrying an id and no name
 * compared against a row carrying a name and no id is genuinely
 * indeterminate. The first version returned `false` for that, which silently
 * demoted a real duplicate to "not a duplicate" — the dangerous direction.
 */
export function vendorsMatch(
  a: { vendor_id?: unknown; vendor_name?: unknown },
  b: { vendor_id?: unknown; vendor_name?: unknown },
): boolean | null {
  const aid = positiveId(a.vendor_id);
  const bid = positiveId(b.vendor_id);
  if (aid && bid) return aid === bid;
  const as = slug(a.vendor_name);
  const bs = slug(b.vendor_name);
  if (as !== '' && bs !== '') return as === bs;
  return null; // one side has only an id, the other only a name
}

/**
 * Are these the same physical row? Requires BOTH ids on BOTH sides.
 *
 * `BillRefSchema` declares the ids nullish, so a bare `a.id === b.id` compares
 * `undefined === undefined` and reports true. That made every hand-assembled
 * pending row look like the candidate itself, and the tool reported no
 * duplicate for a set of literally identical rows.
 */
function isSameRow(a: BillRef, b: BillRef): boolean {
  return (
    a.document_id != null &&
    b.document_id != null &&
    a.ocr_result_id != null &&
    b.ocr_result_id != null &&
    a.document_id === b.document_id &&
    a.ocr_result_id === b.ocr_result_id
  );
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

/**
 * `clear` is the ONLY verdict that means "safe to file".
 *
 * `is_duplicate: false` is not the same statement — it is also what a
 * `cannot_judge` returns, and a caller branching on the boolean alone will
 * read "I could not check this" as "I checked it and it is fine". That
 * conflation is the shape of the original incident, so the verdict is the
 * primary field and the boolean is kept only for the confirmed-duplicate case.
 */
export type DedupVerdict = 'duplicate' | 'ambiguous' | 'cannot_judge' | 'clear';

export interface DedupResult {
  verdict: DedupVerdict;
  /** True ONLY for a confirmed duplicate. Never branch on `!is_duplicate` — check `verdict`. */
  is_duplicate: boolean;
  normalized: { vendor_key: string; invoice_number: string };
  matched_against: MatchRow[];
  /** Invoice matches but vendor or amount does not, or could not be compared. Needs a human. */
  ambiguous_matches: MatchRow[];
  /** Comparison rows that could not be read at all — usually unenriched. */
  unjudgeable_comparison_rows: number;
  checks_run: string[];
  reason: string;
}

interface ParsedAmount {
  value: number;
  ok: boolean;
}

/**
 * Parse a money value, reporting whether it was actually readable.
 *
 * `Number('$4,947.88')` is NaN. The first version coerced that to 0, which
 * demoted a real duplicate to "amount differs" — and, worse, made two MISSING
 * amounts compare equal (0 === 0) and report `is_duplicate: true`. Two
 * unknowns are not agreement.
 */
function parseAmount(v: unknown): ParsedAmount {
  if (v === null || v === undefined) return { value: 0, ok: false };
  if (typeof v === 'number') return Number.isFinite(v) ? { value: v, ok: true } : { value: 0, ok: false };
  const cleaned = String(v).replace(/[$,\s]/g, '');
  if (cleaned === '') return { value: 0, ok: false };
  const n = Number(cleaned);
  return Number.isFinite(n) ? { value: n, ok: true } : { value: 0, ok: false };
}

function toRow(b: BillRef, source: 'created' | 'pending'): MatchRow {
  return {
    source,
    document_id: b.document_id ?? null,
    ocr_result_id: b.ocr_result_id ?? null,
    vendor_name: String(b.vendor_name ?? ''),
    vendor_invoice_number: String(b.vendor_invoice_number ?? ''),
    total_amount: parseAmount(b.total_amount).value,
  };
}

function cannotJudge(
  reason: string,
  normalized: { vendor_key: string; invoice_number: string },
  checks_run: string[],
  unjudgeable = 0,
): DedupResult {
  return {
    verdict: 'cannot_judge',
    is_duplicate: false,
    normalized,
    matched_against: [],
    ambiguous_matches: [],
    unjudgeable_comparison_rows: unjudgeable,
    checks_run,
    reason,
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
  const amtP = parseAmount(candidate.total_amount);
  const normalized = { vendor_key: vendorKey, invoice_number: inv };

  const checks_run = ['created_bills', ...(pendingProvided ? ['pending_self_join'] : [])];

  // No invoice number means no primary key. Refuse to judge rather than
  // return a confident "not a duplicate" — an unenriched row (see
  // ap_inbox_list_documents `enrich`) looks exactly like this.
  if (inv === '') {
    return cannotJudge(
      'Candidate has no vendor invoice number, which is the primary dedup key. ' +
        'If this row came from ap_inbox_list_documents, re-fetch it with enrich:true; the invoice ' +
        'number is not on the list row. NOT a clearance to file.',
      normalized,
      checks_run,
    );
  }

  if (!amtP.ok) {
    return cannotJudge(
      'Candidate has no readable total_amount. Amount is one of the three components that must ' +
        'agree, so no verdict is possible. NOT a clearance to file.',
      normalized,
      checks_run,
    );
  }
  const amt = amtP.value;

  const matched: MatchRow[] = [];
  const ambiguous: MatchRow[] = [];
  let unjudgeable = 0;

  const scan = (rows: BillRef[], source: 'created' | 'pending') => {
    for (const row of rows) {
      // Never compare the candidate against itself — in EITHER set. The
      // created check needs this too: list_documents returns one flat array
      // spanning both statuses, and its two per-status requests are
      // sequential, so a bill filed in between appears in both pages under the
      // same key.
      if (isSameRow(row, candidate)) continue;

      const rowInv = normalizeInvoiceNumber(row.vendor_invoice_number);
      const rowAmt = parseAmount(row.total_amount);

      // A row we cannot read is NOT a row that failed to match. Count it, and
      // let it block the `clear` verdict. Silently skipping these is how a
      // 640-row unenriched comparison set reported "no duplicate found".
      if (rowInv === '' || !rowAmt.ok) {
        unjudgeable++;
        continue;
      }
      if (rowInv !== inv) continue;

      const vendorVerdict = vendorsMatch(candidate, row);
      const amountAgrees = Math.abs(rowAmt.value - amt) < AMOUNT_TOLERANCE;

      if (vendorVerdict === true && amountAgrees) {
        matched.push(toRow(row, source));
      } else {
        // Invoice number matched. That alone is strong enough to deserve a
        // human, whether the vendor or the amount is what disagrees. The first
        // version surfaced amount mismatches and dropped vendor mismatches
        // silently — backwards, since the vendor name is the noisiest OCR
        // field and the invoice number is the decisive one.
        ambiguous.push(toRow(row, source));
      }
    }
  };

  scan(created, 'created');
  if (pendingProvided) scan(pending, 'pending');

  const is_duplicate = matched.length > 0;
  const verdict: DedupVerdict = is_duplicate
    ? 'duplicate'
    : ambiguous.length > 0
      ? 'ambiguous'
      : unjudgeable > 0
        ? 'cannot_judge'
        : 'clear';

  let reason: string;
  if (verdict === 'duplicate') {
    const where = [...new Set(matched.map((m) => m.source))].join(' + ');
    reason =
      `DUPLICATE — invoice ${inv}, vendor, and amount ${amt.toFixed(2)} all agree with ` +
      `${matched.length} row(s) in: ${where}. DO NOT FILE; filing double-counts this cost onto the job.`;
  } else if (verdict === 'ambiguous') {
    reason =
      `AMBIGUOUS — invoice ${inv} matches ${ambiguous.length} row(s), but the vendor or the amount ` +
      `does not agree with ${amt.toFixed(2)}. Could be a page split, a partial credit, or an OCR ` +
      `vendor-name variant. A human must look before filing.`;
  } else if (verdict === 'cannot_judge') {
    reason =
      `CANNOT JUDGE — ${unjudgeable} comparison row(s) had no readable invoice number or amount, so ` +
      `they were never actually compared. Re-fetch them from ap_inbox_list_documents with enrich:true ` +
      `(and page through next_cursor until it is null). This is NOT a clearance to file.`;
  } else {
    reason = `CLEAR — no duplicate found for invoice ${inv} across ${checks_run.join(' + ')}; every comparison row was readable.`;
  }

  // A caller who omits pending_bills gets only half the guarantee. Say so
  // rather than letting a clean verdict imply both checks ran.
  if (!pendingProvided) {
    reason +=
      ' WARNING: pending_bills was not supplied, so the intra-pending self-join did NOT run. ' +
      'This verdict cannot see a duplicate that is sitting elsewhere in the pending queue.';
  }

  return {
    verdict,
    is_duplicate,
    normalized,
    matched_against: matched,
    ambiguous_matches: ambiguous,
    unjudgeable_comparison_rows: unjudgeable,
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
