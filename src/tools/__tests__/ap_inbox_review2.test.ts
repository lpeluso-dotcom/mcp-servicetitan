// ============================================================
// ap_inbox_review2.test.ts — second adversarial review of PR #111
// (reviewed head b7e8fec). Every case here was REPRODUCED against that
// head before being fixed.
//
// The governing rule for this whole file: a confident false `clear`,
// `duplicate`, or `reconciles: true` is materially worse than
// `cannot_judge` or a HOLD. Malformed, missing, incomplete and
// unparseable data are treated as HOSTILE, not as zero.
// ============================================================
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ap_inbox_list_documents } from '../ap_inbox/ap_inbox_list_documents';
import { dedupCheck } from '../ap_inbox/ap_inbox_dedup_check';
import { reconcileAmount } from '../ap_inbox/ap_inbox_reconcile_amount';
import { RESULT_THRESHOLD } from '../../resources/results';

const ctx = { actor: 'test', correlation: 'c1' };
const AUTH = { session_cookie: '.AspNetCore.AUTH=chunks-2', csrf_token: 'abc123' };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

/** A structurally COMPLETE row. Findings below remove one field at a time. */
const goodRow = (over: Record<string, unknown> = {}) => ({
  id: 1,
  ocrResultId: 11,
  originalFilename: 'Inv1.pdf',
  vendorName: 'V',
  status: 3,
  scanComplete: true,
  billWasCreated: true,
  totalAmount: 100,
  ...over,
});

const listOnce = (body: unknown) => {
  vi.stubGlobal('fetch', vi.fn(async () => json(body)));
  return ap_inbox_list_documents.handler({} as any, { ...AUTH, statuses: [3] }, ctx);
};

afterEach(() => vi.unstubAllGlobals());

// ── [P1-A] Malformed GetBillDocuments success envelopes ──────────────────

describe('[P1-A] a JSON 200 is not proof of a valid envelope', () => {
  // "{}" currently yields {count:0, total_by_status:{"3":0}, documents:[]} —
  // an empty inbox. Contract drift or a JSON-shaped error therefore becomes
  // "there are no created bills", which is a false clearance one tool later.
  it('rejects {} instead of reporting an empty inbox', async () => {
    await expect(listOnce({})).rejects.toThrow(/envelope|malformed|result/i);
  });

  it('rejects result: null', async () => {
    await expect(listOnce({ result: null, totalCount: 0 })).rejects.toThrow(/result/i);
  });

  it('rejects a non-array result', async () => {
    await expect(listOnce({ result: { rows: [] }, totalCount: 0 })).rejects.toThrow(/array|result/i);
  });

  it('rejects a missing totalCount — completeness cannot be proven without it', async () => {
    await expect(listOnce({ result: [] })).rejects.toThrow(/totalCount/i);
  });

  it('rejects a non-numeric totalCount rather than letting NaN pass the gate', async () => {
    // NaN is especially dangerous: `rows.length < NaN` is false, so the
    // completeness assertion silently succeeds.
    await expect(listOnce({ result: [], totalCount: 'abc' })).rejects.toThrow(/totalCount/i);
  });

  it('rejects a negative or fractional totalCount', async () => {
    await expect(listOnce({ result: [], totalCount: -1 })).rejects.toThrow(/totalCount/i);
    await expect(listOnce({ result: [], totalCount: 1.5 })).rejects.toThrow(/totalCount/i);
  });
});

// ── [P1-B] Missing row data must not become authoritative ────────────────

describe('[P1-B] missing row fields must not be coerced to zero/false', () => {
  it('rejects a row with no status rather than emitting it as pending(0)', async () => {
    const { status: _drop, ...noStatus } = goodRow();
    await expect(listOnce({ result: [noStatus], totalCount: 1 })).rejects.toThrow(/status/i);
  });

  // billWasCreated is the idempotency flag. Guessing `false` for a missing
  // value is precisely how an already-filed bill gets filed again.
  it('rejects a row with no billWasCreated rather than defaulting it to false', async () => {
    const { billWasCreated: _drop, ...noFlag } = goodRow();
    await expect(listOnce({ result: [noFlag], totalCount: 1 })).rejects.toThrow(/billWasCreated/i);
  });

  it('rejects a row with no id or ocrResultId', async () => {
    const { id: _a, ...noId } = goodRow();
    await expect(listOnce({ result: [noId], totalCount: 1 })).rejects.toThrow(/id/i);
    const { ocrResultId: _b, ...noOcr } = goodRow();
    await expect(listOnce({ result: [noOcr], totalCount: 1 })).rejects.toThrow(/ocrResultId/i);
  });

  it('surfaces a missing totalAmount as null, never as 0', async () => {
    const { totalAmount: _drop, ...noTotal } = goodRow();
    const out: any = await listOnce({ result: [noTotal], totalCount: 1 });
    expect(out.documents[0].total_amount).toBeNull();
  });

  it('rejects a non-numeric totalAmount', async () => {
    const out: any = await listOnce({ result: [goodRow({ totalAmount: 'USD 100' })], totalCount: 1 });
    expect(out.documents[0].total_amount).toBeNull();
  });

  // THE CROSS-TOOL PROOF. Two rows whose totals never arrived must not be
  // reported as a confirmed $0.00 duplicate.
  it('list output with unknown totals cannot become a confirmed $0.00 duplicate', async () => {
    const { totalAmount: _a, ...t1 } = goodRow({ id: 1, ocrResultId: 11 });
    const { totalAmount: _b, ...t2 } = goodRow({ id: 2, ocrResultId: 22 });
    const out: any = await listOnce({ result: [t1, t2], totalCount: 2 });

    const [a, b] = out.documents;
    const verdict = dedupCheck({
      candidate: { ...a, vendor_invoice_number: 'X1' },
      created_bills: [{ ...b, vendor_invoice_number: 'X1' }],
      pending_bills: [],
    });
    expect(verdict.is_duplicate).toBe(false);
    expect(verdict.verdict).toBe('cannot_judge');
  });
});

// ── [P1-C] Pagination completeness under page drift ──────────────────────

describe('[P1-C] row COUNT is not proof of row COVERAGE', () => {
  // Offset pages over a date-desc list shift when rows are inserted, removed,
  // or change status mid-scan. rows.length can hit totalCount while a distinct
  // document was never seen at all.
  it('rejects the shifted-page sequence [1,2] then [2,3] claiming totalCount 4', async () => {
    const pages = [
      [{ id: 1, ocrResultId: 11 }, { id: 2, ocrResultId: 22 }],
      [{ id: 2, ocrResultId: 22 }, { id: 3, ocrResultId: 33 }],
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_u: any, init: any) => {
        const { pageIndex } = JSON.parse(init.body);
        const rows = (pages[pageIndex - 1] ?? []).map((r) => goodRow(r));
        return json({ result: rows, totalCount: 4 });
      }),
    );
    await expect(
      ap_inbox_list_documents.handler({} as any, { ...AUTH, statuses: [3], page_size: 2 }, ctx),
    ).rejects.toThrow(/duplicate|drift|distinct|unstable/i);
  });

  it('rejects a duplicate identity inside a single page', async () => {
    const dup = [goodRow({ id: 5, ocrResultId: 55 }), goodRow({ id: 5, ocrResultId: 55 })];
    await expect(listOnce({ result: dup, totalCount: 2 })).rejects.toThrow(
      /duplicate|drift|distinct|unstable/i,
    );
  });

  it('rejects a totalCount that changes between pages', async () => {
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        call++;
        return json({
          result: [goodRow({ id: call, ocrResultId: call * 10 })],
          totalCount: call === 1 ? 4 : 9,
        });
      }),
    );
    await expect(
      ap_inbox_list_documents.handler({} as any, { ...AUTH, statuses: [3], page_size: 1 }, ctx),
    ).rejects.toThrow(/totalCount|changed|unstable|drift/i);
  });
});

// ── [P1-D] Both comparison sets must actually be present ─────────────────

describe('[P1-D] a warning string is not a safety mechanism', () => {
  const candidate = {
    document_id: 1,
    ocr_result_id: 2,
    vendor_name: 'V',
    vendor_invoice_number: 'X1',
    total_amount: 10,
  };

  it('omitted pending_bills returns cannot_judge, not clear', () => {
    const r = dedupCheck({ candidate, created_bills: [] });
    expect(r.verdict).toBe('cannot_judge');
    expect(r.verdict).not.toBe('clear');
  });

  it('omitted created_bills returns cannot_judge, not clear', () => {
    const r = dedupCheck({ candidate, pending_bills: [] });
    expect(r.verdict).toBe('cannot_judge');
  });

  it('both omitted returns cannot_judge', () => {
    expect(dedupCheck({ candidate }).verdict).toBe('cannot_judge');
  });

  it('checks_run lists only checks that actually ran', () => {
    expect(dedupCheck({ candidate, created_bills: [] }).checks_run).toEqual(['created_bills']);
    expect(dedupCheck({ candidate, created_bills: [], pending_bills: [] }).checks_run).toEqual([
      'created_bills',
      'pending_self_join',
    ]);
  });

  it('still returns clear when BOTH sets are supplied and readable', () => {
    expect(dedupCheck({ candidate, created_bills: [], pending_bills: [] }).verdict).toBe('clear');
  });
});

// ── [P1-E] Unreadable tax / shipping must HOLD ───────────────────────────

describe('[P1-E] a populated-but-unreadable money field is not zero', () => {
  const items = [{ description: 'A', quantity: 1, unit_cost: 100 }];

  it('HOLDs on an unreadable tax instead of applying tax: 0', () => {
    const r = reconcileAmount({ header_total: 100, tax: 'USD 8', items });
    expect(r.reconciles).toBe(false);
    expect(r.reason).toMatch(/tax/i);
  });

  it('HOLDs on an unreadable shipping', () => {
    const r = reconcileAmount({ header_total: 100, shipping: 'USD 8', items });
    expect(r.reconciles).toBe(false);
    expect(r.reason).toMatch(/shipping/i);
  });

  it('HOLDs on a wrapped malformed value', () => {
    const r = reconcileAmount({ header_total: 100, tax: { value: 'abc', text: 'abc' }, items });
    expect(r.reconciles).toBe(false);
    expect(r.reason).toMatch(/tax/i);
  });

  it('still treats an ABSENT tax/shipping as a legitimate zero', () => {
    expect(reconcileAmount({ header_total: 100, items }).reconciles).toBe(true);
  });
});

// ── [P2-F] Dedup amounts compared in integer cents ───────────────────────

describe('[P2-F] "agree to the penny" must mean exactly that', () => {
  const mk = (amt: number) => ({
    document_id: 9,
    ocr_result_id: 99,
    vendor_name: 'V',
    vendor_invoice_number: 'X1',
    total_amount: amt,
  });

  it('does NOT call 100.02 vs 100.01 a duplicate', () => {
    // 100.02 - 100.01 === 0.009999999999990905 in binary float, which slipped
    // under a `< 0.01` tolerance.
    const r = dedupCheck({
      candidate: { ...mk(100.02), document_id: 1, ocr_result_id: 1 },
      created_bills: [mk(100.01)],
      pending_bills: [],
    });
    expect(r.is_duplicate).toBe(false);
  });

  it('does NOT call it a duplicate in the other direction either', () => {
    const r = dedupCheck({
      candidate: { ...mk(100.01), document_id: 1, ocr_result_id: 1 },
      created_bills: [mk(100.02)],
      pending_bills: [],
    });
    expect(r.is_duplicate).toBe(false);
  });

  it('still matches on exact cent equality', () => {
    const r = dedupCheck({
      candidate: { ...mk(100.02), document_id: 1, ocr_result_id: 1 },
      created_bills: [mk(100.02)],
      pending_bills: [],
    });
    expect(r.is_duplicate).toBe(true);
  });

  it('matches across float-hostile representations of the same cents', () => {
    const r = dedupCheck({
      candidate: { ...mk(0.1 + 0.2), document_id: 1, ocr_result_id: 1 }, // 0.30000000000000004
      created_bills: [mk(0.3)],
      pending_bills: [],
    });
    expect(r.is_duplicate).toBe(true);
  });
});

// ── [P2-G] Ambiguity is a PER-LINE property ──────────────────────────────

describe('[P2-G] equal aggregate sums do not prove equal allocations', () => {
  it('HOLDs when unit and extended agree on the total but differ per line', () => {
    // unit basis:     A = 2 x 10 = 20, B = 0.5 x 20 = 10  -> [20, 10]
    // extended basis: A = 10,          B = 20             -> [10, 20]
    // Both sum to 30. The header is right either way; the JOB the cost lands
    // on is not.
    const r = reconcileAmount({
      header_total: 30,
      items: [
        { description: 'A', quantity: 2, unit_cost: 10 },
        { description: 'B', quantity: 0.5, unit_cost: 20 },
      ],
    });
    expect(r.reconciles).toBe(false);
    expect(r.mode).toBeNull();
    expect(r.also_matched.length).toBeGreaterThan(0);
    expect(r.reason).toMatch(/ambiguous|per.line|allocation/i);
  });

  it('does NOT hold when every quantity is 1 — the bases are identical', () => {
    const r = reconcileAmount({
      header_total: 200,
      items: [
        { description: 'A', quantity: 1, unit_cost: 100 },
        { description: 'B', quantity: 1, unit_cost: 100 },
      ],
    });
    expect(r.reconciles).toBe(true);
    expect(r.also_matched).toEqual([]);
  });
});

// ── Adjacent search: contradictory classification fields ─────────────────

describe('[adjacent] status and billWasCreated must not contradict', () => {
  // The dedup check splits its comparison sets on bill_was_created. A status-3
  // ("created") row claiming billWasCreated:false — or the inverse — means one
  // of the two fields is lying, and whichever the caller trusts, the row lands
  // in the wrong comparison set.
  it('rejects a created-status row claiming billWasCreated false', async () => {
    await expect(listOnce({ result: [goodRow({ status: 3, billWasCreated: false })], totalCount: 1 })).rejects.toThrow(
      /contradict/i,
    );
  });

  it('rejects a pending-status row claiming billWasCreated true', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ result: [goodRow({ status: 2, billWasCreated: true })], totalCount: 1 })));
    await expect(
      ap_inbox_list_documents.handler({} as any, { ...AUTH, statuses: [2] }, ctx),
    ).rejects.toThrow(/contradict/i);
  });
});

// ── Adjacent search: encoded credential echoes ───────────────────────────

describe('[adjacent] a URL-encoded credential echo is still a credential', () => {
  it('scrubs a cookie value echoed back percent-encoded', async () => {
    const secret = 'SUPERSECRETVALUE/WITH+CHARS';
    const cookie = `.AspNetCore.AUTHC1=${secret}`;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(`blocked: ${encodeURIComponent(secret)}`, { status: 400 })),
    );
    const err: any = await ap_inbox_list_documents
      .handler({} as any, { session_cookie: cookie, csrf_token: 'tok12345', statuses: [2] }, ctx)
      .catch((e: unknown) => e);
    expect(String(err.message)).not.toContain('SUPERSECRETVALUE');
    expect(String(err.message)).not.toContain(encodeURIComponent(secret));
  });
});

// ── [P2-H] "Nothing is stored" vs the MCP result-offload layer ───────────

describe('[P2-H] the storage disclosure must match the transport', () => {
  it('a realistic AP-inbox list response exceeds the KV offload threshold', () => {
    // 690 rows is the real shape: ~99 pending + ~591 created.
    const doc = {
      document_id: 85468269,
      ocr_result_id: 85468404,
      original_filename: 'Inv3890320.pdf',
      vendor_name: "McCall's Supply Inc.",
      total_amount: 669.75,
      status: 2,
      scan_complete: true,
      bill_was_created: false,
      vendor_invoice_number: '396175 01',
      vendor_id: 288,
      is_bill_duplicate: false,
    };
    const payload = JSON.stringify({ documents: Array.from({ length: 690 }, () => doc) });
    expect(payload.length).toBeGreaterThan(RESULT_THRESHOLD);
  });

  it('the tool description does not claim data is never stored', () => {
    // It may claim CREDENTIALS are never stored — that remains true — but a
    // bare "Nothing is stored" is false for a default-sized response.
    expect(ap_inbox_list_documents.description).not.toMatch(/nothing is stored/i);
  });

  it('the description discloses the result-offload retention', () => {
    expect(ap_inbox_list_documents.description).toMatch(/offload|KV|retain|15 min/i);
  });
});
