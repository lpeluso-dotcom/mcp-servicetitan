// ============================================================
// ap_inbox_dedup_check.test.ts — QUA-1167.
//
// The ticket's requirement, verbatim:
//   "A negative control exists and is checked in: seed a pending row whose
//    invoice# matches a known filed bill, prove the gate rejects it, and prove
//    the same gate passes a genuinely new invoice. A check that has never
//    failed is not a check."
//
// Both halves live in the first describe block. Neither is optional.
// ============================================================
import { describe, it, expect } from 'vitest';
import {
  ap_inbox_dedup_check,
  dedupCheck,
  normalizeInvoiceNumber,
  normalizeVendorKey,
} from '../ap_inbox/ap_inbox_dedup_check';

const ctx = { actor: 'test', correlation: 'c1' };

// A bill already filed in ServiceTitan (billWasCreated === true).
const FILED = {
  document_id: 82702843,
  ocr_result_id: 82657653,
  vendor_name: "McCall's Supply Inc.",
  vendor_id: 288,
  vendor_invoice_number: '3863192',
  total_amount: 4947.88,
};

describe('ap_inbox_dedup_check — THE NEGATIVE CONTROL (QUA-1167)', () => {
  // Doc 82595843 sat in the backlog labelled "reconciles to the penny, ready
  // to enter". Invoice 3863192 was ALREADY FILED on doc 82702843. Entering it
  // would have double-counted $4,947.88 into job costs.
  it('FLAGS a pending row whose invoice matches a filed bill', () => {
    const r = dedupCheck({
      candidate: {
        document_id: 82595843,
        ocr_result_id: 82595844,
        vendor_name: "MCCALL'S SUPPLY, INC",
        vendor_invoice_number: '3863192',
        total_amount: 4947.88,
      },
      created_bills: [FILED],
    });
    expect(r.is_duplicate).toBe(true);
    expect(r.matched_against).toHaveLength(1);
    expect(r.matched_against[0].document_id).toBe(82702843);
    expect(r.matched_against[0].source).toBe('created');
  });

  // The other half. Without this, the gate above could be `return true`.
  it('does NOT flag a genuinely new invoice', () => {
    const r = dedupCheck({
      candidate: {
        document_id: 85468269,
        ocr_result_id: 85468404,
        vendor_name: "McCall's Supply Inc.",
        vendor_invoice_number: '3890320',
        total_amount: 669.75,
      },
      created_bills: [FILED],
    });
    expect(r.is_duplicate).toBe(false);
    expect(r.matched_against).toHaveLength(0);
  });
});

describe('ap_inbox_dedup_check — structural blindness is the bug being fixed', () => {
  // extract-classify.js:36 filters to billWasCreated === false before anything
  // downstream runs, so the skill's dedup can only compare pending to pending.
  // A re-forwarded PDF arrives under a NEW documentId and slips through. That
  // blind spot let 87 duplicates ($65,085.37) past on 2026-08-01, and would
  // have double-counted ~$113K if the QUA-1082 pipeline had run.
  it('sees across the pending/created boundary, not just within pending', () => {
    const r = dedupCheck({
      candidate: {
        document_id: 99999999,
        ocr_result_id: 99999998,
        vendor_name: "McCall's Supply Inc.",
        vendor_invoice_number: '3863192',
        total_amount: 4947.88,
      },
      created_bills: [FILED],
      pending_bills: [], // nothing pending — the skill would report "clean"
    });
    expect(r.is_duplicate).toBe(true);
    expect(r.checks_run).toContain('created_bills');
  });

  // validateVdn only compares against created bills, so it is structurally
  // blind to THIS case. On 2026-08-05 all 42 pending returned "not already
  // entered" while three same-invoice pairs existed inside the pending set.
  it('also catches duplicates inside the pending set', () => {
    const r = dedupCheck({
      candidate: {
        document_id: 90000001,
        ocr_result_id: 90000002,
        vendor_name: 'Darlington',
        vendor_invoice_number: 'PS-INV229380',
        total_amount: 512.4,
      },
      created_bills: [],
      pending_bills: [
        {
          document_id: 90000010,
          ocr_result_id: 90000011,
          vendor_name: 'Darlington',
          vendor_invoice_number: 'PS-INV229380',
          total_amount: 512.4,
        },
      ],
    });
    expect(r.is_duplicate).toBe(true);
    expect(r.matched_against[0].source).toBe('pending');
    expect(r.checks_run).toEqual(expect.arrayContaining(['created_bills', 'pending_self_join']));
  });

  it('does not match the candidate against itself in the pending set', () => {
    const self = {
      document_id: 90000001,
      ocr_result_id: 90000002,
      vendor_name: 'Darlington',
      vendor_invoice_number: 'PS-INV229380',
      total_amount: 512.4,
    };
    const r = dedupCheck({ candidate: self, created_bills: [], pending_bills: [self] });
    expect(r.is_duplicate).toBe(false);
  });
});

describe('ap_inbox_dedup_check — all three components must agree', () => {
  const base = {
    document_id: 1,
    ocr_result_id: 2,
    vendor_name: "McCall's Supply Inc.",
    vendor_invoice_number: '3863192',
    total_amount: 4947.88,
  };

  it('does not flag when the amount differs', () => {
    const r = dedupCheck({ candidate: { ...base, total_amount: 1234.56 }, created_bills: [FILED] });
    expect(r.is_duplicate).toBe(false);
  });

  it('does not flag when the vendor differs', () => {
    const r = dedupCheck({ candidate: { ...base, vendor_name: 'Winsupply' }, created_bills: [FILED] });
    expect(r.is_duplicate).toBe(false);
  });

  // Same invoice + vendor at a DIFFERENT amount is not a duplicate, but it is
  // worth a human's eye — a page-split or a partial credit. Surfaced
  // separately rather than silently dropped.
  it('surfaces an invoice+vendor match at a differing amount as ambiguous', () => {
    const r = dedupCheck({ candidate: { ...base, total_amount: 1234.56 }, created_bills: [FILED] });
    expect(r.is_duplicate).toBe(false);
    expect(r.ambiguous_matches).toHaveLength(1);
    expect(r.ambiguous_matches[0].document_id).toBe(82702843);
  });

  it('refuses to judge when the candidate has no invoice number', () => {
    const r = dedupCheck({
      candidate: { ...base, vendor_invoice_number: null },
      created_bills: [FILED],
    });
    expect(r.is_duplicate).toBe(false);
    expect(r.reason).toMatch(/invoice number/i);
  });
});

describe('normalizeInvoiceNumber', () => {
  // Real invoice numbers contain spaces. A naive \S+ parse truncates them,
  // and Carolina prints job numbers space-split as '8480 9343'.
  it('does NOT truncate at the first space', () => {
    expect(normalizeInvoiceNumber('396175 01')).toBe('39617501');
    expect(normalizeInvoiceNumber('396175 01')).not.toBe('396175');
  });

  it('keeps a space-split number distinct from its prefix', () => {
    expect(normalizeInvoiceNumber('396175 01')).not.toBe(normalizeInvoiceNumber('396175'));
  });

  it('uppercases and strips leading zeros', () => {
    expect(normalizeInvoiceNumber('0012345')).toBe('12345');
    expect(normalizeInvoiceNumber('ps-inv229380')).toBe('PS-INV229380');
  });

  it('treats zero-padded variants of the same invoice as equal', () => {
    expect(normalizeInvoiceNumber('0012345')).toBe(normalizeInvoiceNumber('12345'));
  });

  it('does not reduce an all-zero string to empty', () => {
    expect(normalizeInvoiceNumber('000')).toBe('0');
  });

  it('returns empty for null/blank', () => {
    expect(normalizeInvoiceNumber(null)).toBe('');
    expect(normalizeInvoiceNumber('   ')).toBe('');
  });
});

describe('normalizeVendorKey', () => {
  // dedup-and-bucket.py keys on (v.lower().strip(), inv) with no punctuation
  // handling, so OCR spelling variants split the group. That let two real
  // McCall's duplicates escape — inv 3873769 ($241.09) and 3872849
  // ($3,993.33). Without a manual re-check $241.09 would have been FILED TWICE.
  it('matches OCR spelling variants of the same vendor', () => {
    expect(normalizeVendorKey({ vendor_name: "MCCALL'S SUPPLY, INC" })).toBe(
      normalizeVendorKey({ vendor_name: "McCall's Supply Inc." }),
    );
  });

  it('matches a trailing-period variant', () => {
    expect(normalizeVendorKey({ vendor_name: 'WINSUPPLY FLORENCE SC CO.' })).toBe(
      normalizeVendorKey({ vendor_name: 'WINSUPPLY FLORENCE SC CO' }),
    );
  });

  it('prefers vendor_id over the OCR name when present', () => {
    // ST auto-matched a vendorId on only 17 of 35 rows, so the id is the
    // stronger key when it exists but cannot be the only one.
    expect(normalizeVendorKey({ vendor_id: 288, vendor_name: 'garbled ocr text' })).toBe('id:288');
  });

  it('does not treat vendorId 0 as present', () => {
    // build-file-list.py:29 uses `if rec.get("vid")`, so a vendorId of 0 is
    // falsy and silently falls through. Assert we key on the name instead of
    // producing 'id:0'.
    expect(normalizeVendorKey({ vendor_id: 0, vendor_name: 'Ferguson' })).toBe('ferguson');
  });

  it('keeps genuinely different vendors distinct', () => {
    // The master's 'Hoffman & Hoffman, Inc.' is a DIFFERENT entity from
    // 'Hoffman Parts & Warehouse, LLC' — do not map them together.
    expect(normalizeVendorKey({ vendor_name: 'Hoffman & Hoffman, Inc.' })).not.toBe(
      normalizeVendorKey({ vendor_name: 'Hoffman Parts & Warehouse, LLC' }),
    );
  });
});

describe('ap_inbox_dedup_check — tool contract', () => {
  it('is a read-only computed tool', () => {
    expect(ap_inbox_dedup_check.isWrite).toBeFalsy();
    expect(ap_inbox_dedup_check.stEndpoint?.source).toBe('computed');
  });

  it('describes every schema field', () => {
    for (const [name, field] of Object.entries(ap_inbox_dedup_check.zodSchema)) {
      expect((field as any).description, `${name} needs .describe()`).toBeTruthy();
    }
  });

  it('returns a duplicate verdict through the handler', async () => {
    await expect(
      ap_inbox_dedup_check.handler(
        {} as any,
        {
          candidate: {
            document_id: 82595843,
            ocr_result_id: 82595844,
            vendor_name: "MCCALL'S SUPPLY, INC",
            vendor_invoice_number: '3863192',
            total_amount: 4947.88,
          },
          created_bills: [FILED],
        },
        ctx,
      ),
    ).resolves.toMatchObject({ is_duplicate: true });
  });
});
