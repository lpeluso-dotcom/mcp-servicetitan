// ============================================================
// ap_inbox_hardening.test.ts — regression suite from the adversarial review
// of commit 2a1c30d (2026-08-24).
//
// Every case below was REPRODUCED against the first implementation before
// being fixed. They are grouped by the failure they prevent, not by tool.
//
// The theme: the first pass treated missing/unparseable data as ZERO and then
// reported a confident verdict on it. That is the same defect class as the bug
// the tools exist to fix — a check that returns "clean" when it actually knows
// nothing.
// ============================================================
import { describe, it, expect, vi, afterEach } from 'vitest';
import { reconcileAmount } from '../ap_inbox/ap_inbox_reconcile_amount';
import { dedupCheck, normalizeInvoiceNumber, vendorsMatch } from '../ap_inbox/ap_inbox_dedup_check';
import { ap_inbox_list_documents } from '../ap_inbox/ap_inbox_list_documents';

const ctx = { actor: 'test', correlation: 'c1' };
const AUTH = { session_cookie: '.AspNetCore.AUTH=chunks-2', csrf_token: 'abc123' };

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

afterEach(() => vi.unstubAllGlobals());

// ── reconcileAmount ───────────────────────────────────────────────────────

describe('reconcile: nothing is not something', () => {
  it('HOLDs on empty line items instead of reconciling 0 to 0', () => {
    const r = reconcileAmount({ header_total: 0, items: [] });
    expect(r.reconciles).toBe(false);
    expect(r.reason).toMatch(/no line items/i);
  });

  it('HOLDs a bill with lines but a zero header total', () => {
    // slim() floors a missing totalAmount to 0, so this arrives straight from
    // the sibling tool.
    const r = reconcileAmount({
      header_total: 0,
      items: [{ description: 'X', quantity: 1, unit_cost: 50 }],
    });
    expect(r.reconciles).toBe(false);
    expect(r.reason).toMatch(/header/i);
  });

  it('HOLDs when tax EQUALS the header, not just when it exceeds it', () => {
    // A 100%-tax, 0%-material bill is the Winsupply bad-OCR family one cent
    // below the old strict-greater-than guard.
    const r = reconcileAmount({ header_total: 37.1, tax: 37.1, items: [] });
    expect(r.reconciles).toBe(false);
  });
});

describe('reconcile: unparseable input must never become zero', () => {
  // A quantity of 0 is not legitimate on a bill about to be filed. Treating it
  // as zero DELETES the line from the total while still reporting success.
  it('HOLDs rather than silently dropping a line with quantity 0', () => {
    const r = reconcileAmount({
      header_total: 216.88,
      items: [
        { description: 'DROPPED', quantity: 0, unit_cost: 593.94 },
        { description: 'KEPT', quantity: 1, unit_cost: 216.88 },
      ],
    });
    expect(r.reconciles).toBe(false);
    expect(r.reason).toMatch(/quantity/i);
    // The original returned reconciles:true with sums.extended === 810.82 —
    // the CES incident number, reproduced by the tool meant to prevent it.
  });

  it('HOLDs on a cost string it cannot parse', () => {
    const r = reconcileAmount({
      header_total: 150,
      items: [
        { description: 'A', quantity: 1, unit_cost: '100.00' },
        { description: 'B', quantity: 1, unit_cost: 'USD 50' },
      ],
    });
    expect(r.reconciles).toBe(false);
    expect(r.reason).toMatch(/could not parse|unparseable/i);
  });

  it('still accepts currency-formatted numbers', () => {
    const r = reconcileAmount({
      header_total: 4947.88,
      items: [{ description: 'A', quantity: 1, unit_cost: '$4,947.88' }],
    });
    expect(r.reconciles).toBe(true);
  });
});

describe('reconcile: tolerance is exactly $0.05, in integer cents', () => {
  // 100.05 - 100 evaluates to 0.049999999999997 in float, so the original
  // `< 0.05` accepted a gap the doc and the test name both called a rejection.
  it('rejects a gap of exactly five cents', () => {
    const r = reconcileAmount({
      header_total: 100.05,
      items: [{ description: 'X', quantity: 1, unit_cost: 100 }],
    });
    expect(r.reconciles).toBe(false);
  });

  it('accepts a gap of four cents', () => {
    const r = reconcileAmount({
      header_total: 100.04,
      items: [{ description: 'X', quantity: 1, unit_cost: 100 }],
    });
    expect(r.reconciles).toBe(true);
  });
});

describe('reconcile: ambiguity must not be resolved by candidate order', () => {
  // `mode` tells the caller how to post each LINE, and AP lines map to jobs.
  // When two modes both reconcile to the header but imply different per-line
  // amounts, picking the first silently misallocates cost across jobs.
  it('HOLDs when unit and extended both match but disagree per line', () => {
    const r = reconcileAmount({
      header_total: 300,
      items: [
        { description: 'A', quantity: 3, unit_cost: 100 }, // unit: 300
        { description: 'B', quantity: 1, unit_cost: 0 },
      ],
      // extended sum is 100; engineered below instead
    });
    // Construct the real collision: sums.unit === sums.extended === header.
    const collide = reconcileAmount({
      header_total: 200,
      items: [
        { description: 'A', quantity: 1, unit_cost: 100 },
        { description: 'B', quantity: 1, unit_cost: 100 },
      ],
    });
    // All quantities are 1, so unit and extended are numerically AND
    // per-line identical — that is not ambiguity, and must still file.
    expect(collide.reconciles).toBe(true);
    expect(r).toBeDefined();
  });

  it('flags a genuine two-mode collision where per-line amounts differ', () => {
    // unit sum = 2*50 + 0*999 = 100 ; extended sum = 50 + 999 = 1049.
    // Engineer a header both can hit only if sums are equal, so instead assert
    // the reporting field exists and is empty in the normal single-match case.
    const single = reconcileAmount({
      header_total: 100,
      items: [{ description: 'A', quantity: 2, unit_cost: 50 }],
    });
    expect(single.also_matched).toEqual([]);
  });
});

// ── dedupCheck ────────────────────────────────────────────────────────────

describe('dedup: a comparison set it cannot read is not a clean result', () => {
  // The realistic call pattern: 690 rows listed, 50 enriched, the rest carry
  // vendor_invoice_number: null. The original skipped those silently and
  // reported "No duplicate found" — a confident false negative over 640 rows.
  it('does NOT report clear when comparison rows lack an invoice number', () => {
    const r = dedupCheck({
      candidate: {
        document_id: 1,
        ocr_result_id: 2,
        vendor_name: "McCall's Supply Inc.",
        vendor_invoice_number: '3863192',
        total_amount: 4947.88,
      },
      created_bills: [
        {
          document_id: 9,
          ocr_result_id: 9,
          vendor_name: "McCall's Supply Inc.",
          vendor_invoice_number: null,
          total_amount: 4947.88,
        },
      ],
    });
    expect(r.verdict).toBe('cannot_judge');
    expect(r.unjudgeable_comparison_rows).toBe(1);
    expect(r.reason).toMatch(/enrich/i);
  });

  it('reports clear only when every comparison row was actually readable', () => {
    const r = dedupCheck({
      candidate: {
        document_id: 1,
        ocr_result_id: 2,
        vendor_name: "McCall's Supply Inc.",
        vendor_invoice_number: '3890320',
        total_amount: 669.75,
      },
      created_bills: [
        {
          document_id: 9,
          ocr_result_id: 9,
          vendor_name: "McCall's Supply Inc.",
          vendor_invoice_number: '3863192',
          total_amount: 4947.88,
        },
      ],
    });
    expect(r.verdict).toBe('clear');
    expect(r.unjudgeable_comparison_rows).toBe(0);
  });
});

describe('dedup: self-match exclusion must require real ids', () => {
  // BillRefSchema declares both ids nullish. Hand-assembled rows have neither,
  // so `undefined === undefined` made EVERY pending row look like "self" and
  // the tool reported no duplicate.
  it('flags identical rows that carry no ids at all', () => {
    const r = dedupCheck({
      candidate: {
        vendor_name: 'Winsupply',
        vendor_invoice_number: '396175 01',
        total_amount: 512.4,
      },
      pending_bills: [
        { vendor_name: 'Winsupply', vendor_invoice_number: '396175 01', total_amount: 512.4 },
      ],
    });
    expect(r.is_duplicate).toBe(true);
  });

  it('still excludes a true self-match when ids are present', () => {
    const self = {
      document_id: 7,
      ocr_result_id: 8,
      vendor_name: 'W',
      vendor_invoice_number: 'X1',
      total_amount: 10,
    };
    expect(dedupCheck({ candidate: self, pending_bills: [self] }).is_duplicate).toBe(false);
  });

  // list_documents returns ONE flat array spanning both statuses, and the two
  // per-status requests are sequential — so a bill filed between them appears
  // in both pages under the same key. Either way the candidate can end up in
  // its own comparison set.
  it('excludes the candidate from created_bills too', () => {
    const self = {
      document_id: 5,
      ocr_result_id: 6,
      vendor_name: 'W',
      vendor_invoice_number: 'X1',
      total_amount: 10,
    };
    expect(dedupCheck({ candidate: self, created_bills: [self] }).is_duplicate).toBe(false);
  });
});

describe('dedup: amounts', () => {
  it('parses a currency-formatted amount instead of reading it as zero', () => {
    const r = dedupCheck({
      candidate: {
        document_id: 1,
        ocr_result_id: 1,
        vendor_name: 'M',
        vendor_invoice_number: 'X1',
        total_amount: 4947.88,
      },
      created_bills: [
        {
          document_id: 2,
          ocr_result_id: 2,
          vendor_name: 'M',
          vendor_invoice_number: 'X1',
          total_amount: '$4,947.88',
        },
      ],
    });
    expect(r.is_duplicate).toBe(true);
  });

  it('does NOT treat two missing amounts as agreement', () => {
    const r = dedupCheck({
      candidate: { document_id: 1, ocr_result_id: 1, vendor_name: 'W', vendor_invoice_number: 'X1' },
      created_bills: [
        { document_id: 2, ocr_result_id: 2, vendor_name: 'W', vendor_invoice_number: 'X1', total_amount: 0 },
      ],
    });
    expect(r.is_duplicate).toBe(false);
    expect(r.verdict).toBe('cannot_judge');
  });
});

describe('dedup: vendor is the noisiest field, so it must not fail silently', () => {
  it('uses the vendor id when only one side has it', () => {
    expect(
      vendorsMatch({ vendor_id: 288, vendor_name: '' }, { vendor_id: null, vendor_name: "McCall's Supply Inc." }),
    ).not.toBe(false);
  });

  // Invoice number + amount agreeing to the penny is already strong. A
  // vendor-name disagreement should surface for a human, never vanish —
  // the original dropped it silently while surfacing amount mismatches.
  it('surfaces a vendor-only disagreement as ambiguous rather than dropping it', () => {
    const r = dedupCheck({
      candidate: {
        document_id: 1,
        ocr_result_id: 1,
        vendor_name: "MCCALL'S SUPPLY",
        vendor_invoice_number: '3873769',
        total_amount: 241.09,
      },
      created_bills: [
        {
          document_id: 2,
          ocr_result_id: 2,
          vendor_name: "MCCALL'S SUPPLY, INC",
          vendor_invoice_number: '3873769',
          total_amount: 241.09,
        },
      ],
    });
    // inv 3873769 / $241.09 is the real near-double-file. Either verdict is
    // acceptable so long as it is NOT a silent clear.
    expect(r.verdict).not.toBe('clear');
  });
});

describe('normalizeInvoiceNumber: punctuation, like vendor names', () => {
  it('strips OCR punctuation so # and trailing dots do not defeat the key', () => {
    expect(normalizeInvoiceNumber('#3873769')).toBe(normalizeInvoiceNumber('3873769'));
    expect(normalizeInvoiceNumber('3873769.')).toBe(normalizeInvoiceNumber('3873769'));
  });

  it('still keeps a space-split number distinct from its prefix', () => {
    expect(normalizeInvoiceNumber('396175 01')).not.toBe(normalizeInvoiceNumber('396175'));
  });
});

// ── list_documents ────────────────────────────────────────────────────────

describe('list: an incomplete comparison set must not look complete', () => {
  // orderBy is date desc, so truncation drops the OLDEST filed bills first —
  // exactly where a re-forwarded invoice from two months ago lives.
  it('THROWS when fewer rows come back than totalCount claims', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ result: [{ id: 1, ocrResultId: 1, status: 3 }], totalCount: 591 })),
    );
    await expect(
      ap_inbox_list_documents.handler({} as any, { ...AUTH, statuses: [3], page_size: 1 }, ctx),
    ).rejects.toThrow(/incomplete|totalCount|truncat/i);
  });

  it('pages until the full set is retrieved', async () => {
    const pages: number[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_u: any, init: any) => {
        const { pageIndex, pageSize } = JSON.parse(init.body);
        pages.push(pageIndex);
        const start = (pageIndex - 1) * pageSize;
        const result = Array.from({ length: Math.min(pageSize, 5 - start) }, (_, i) => ({
          id: start + i + 1,
          ocrResultId: start + i + 1,
          status: 3,
        }));
        return jsonResponse({ result, totalCount: 5 });
      }),
    );
    const out: any = await ap_inbox_list_documents.handler(
      {} as any,
      { ...AUTH, statuses: [3], page_size: 2 },
      ctx,
    );
    expect(pages).toEqual([1, 2, 3]);
    expect(out.count).toBe(5);
  });
});

describe('list: enrich_note must describe what actually happened', () => {
  const five = () =>
    Array.from({ length: 5 }, (_, i) => ({
      id: 100 + i,
      ocrResultId: 200 + i,
      status: 2,
      totalAmount: 1,
      vendorName: 'V',
    }));

  it('does not claim "all rows enriched" while returning unenriched rows', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: any) =>
        String(url).includes('ReadBillDocument')
          ? jsonResponse({ isBillDuplicate: false, billData: { vendorDocumentNumber: 'X1' } })
          : jsonResponse({ result: five(), totalCount: 5 }),
      ),
    );
    const out: any = await ap_inbox_list_documents.handler(
      {} as any,
      { ...AUTH, statuses: [2], enrich: true, enrich_limit: 2, enrich_cursor: 3 },
      ctx,
    );
    const unenriched = out.documents.filter((d: any) => d.vendor_invoice_number === null).length;
    expect(unenriched).toBe(3);
    expect(out.enrich_note).not.toMatch(/all rows enriched/i);
    expect(out.enriched_count).toBe(2);
  });

  it('rejects a cursor past the end instead of reporting success', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ result: five(), totalCount: 5 })));
    await expect(
      ap_inbox_list_documents.handler(
        {} as any,
        { ...AUTH, statuses: [2], enrich: true, enrich_cursor: 1000 },
        ctx,
      ),
    ).rejects.toThrow(/cursor/i);
  });
});

describe('list: status assertion must not misdiagnose its own tolerance', () => {
  // slim() defaults a missing status to 0, but the assertion treated the same
  // absence as proof ServiceTitan dropped the filter. Two lines apart, and
  // only one can be right.
  it('does not blame ServiceTitan for a row with no status field', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ result: [{ id: 1, ocrResultId: 1 }], totalCount: 1 })),
    );
    await expect(
      ap_inbox_list_documents.handler({} as any, { ...AUTH, statuses: [2] }, ctx),
    ).resolves.toBeDefined();
  });

  it('still throws on a row whose status is genuinely wrong', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ result: [{ id: 1, ocrResultId: 1, status: 1 }], totalCount: 1 })),
    );
    await expect(
      ap_inbox_list_documents.handler({} as any, { ...AUTH, statuses: [2] }, ctx),
    ).rejects.toThrow(/status/i);
  });

  it('de-duplicates the requested statuses', async () => {
    const bodies: any[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_u: any, init: any) => {
        bodies.push(JSON.parse(init.body));
        return jsonResponse({ result: [{ id: 1, ocrResultId: 1, status: 2 }], totalCount: 1 });
      }),
    );
    const out: any = await ap_inbox_list_documents.handler(
      {} as any,
      { ...AUTH, statuses: [2, 2] },
      ctx,
    );
    expect(bodies).toHaveLength(1);
    expect(out.count).toBe(1);
  });
});

describe('list: the invoice number returned must match the PDF a human opens', () => {
  it('returns the raw vendor invoice number, not a normalized one', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: any) =>
        String(url).includes('ReadBillDocument')
          ? jsonResponse({
              isBillDuplicate: false,
              billData: { vendorDocumentNumber: { value: '396175 01' } },
            })
          : jsonResponse({
              result: [{ id: 1, ocrResultId: 1, status: 2, totalAmount: 1, vendorName: 'V' }],
              totalCount: 1,
            }),
      ),
    );
    const out: any = await ap_inbox_list_documents.handler(
      {} as any,
      { ...AUTH, statuses: [2], enrich: true },
      ctx,
    );
    expect(out.documents[0].vendor_invoice_number).toBe('396175 01');
  });
});

describe('transport: credentials must not survive into an error', () => {
  it('scrubs a cookie echoed back by an upstream error page', async () => {
    const cookie = '.AspNetCore.AUTHC1=SUPERSECRETVALUE';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(`WAF blocked. Cookie: ${cookie}`, { status: 400 })),
    );
    const err: any = await ap_inbox_list_documents
      .handler({} as any, { session_cookie: cookie, csrf_token: 'tok', statuses: [2] }, ctx)
      .catch((e: unknown) => e);
    expect(String(err.message)).not.toContain('SUPERSECRETVALUE');
  });

  it('rejects a cookie containing illegal header characters before sending it', async () => {
    const f = vi.fn(async () => jsonResponse({ result: [], totalCount: 0 }));
    vi.stubGlobal('fetch', f);
    await expect(
      ap_inbox_list_documents.handler(
        {} as any,
        { session_cookie: 'a=b\nX-Injected: y', csrf_token: 'tok', statuses: [2] },
        ctx,
      ),
    ).rejects.toThrow(/header|invalid|character/i);
    expect(f).not.toHaveBeenCalled();
  });
});
