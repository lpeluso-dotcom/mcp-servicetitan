// ============================================================
// ap_inbox_list_documents.test.ts — QUA-1167.
//
// The row shape asserted here was verified live against tenant 431848990 on
// 2026-08-24 (Probe 0). GetBillDocuments returns exactly 13 keys, and
// `vendorName` is one of them — both reference docs say otherwise.
// ============================================================
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ap_inbox_list_documents } from '../ap_inbox/ap_inbox_list_documents';
import { redactPayload } from '../../tool-registry';

const ctx = { actor: 'test', correlation: 'c1' };
const AUTH = { session_cookie: '.AspNetCore.AUTH=chunks-2; X-CSRF-Token=abc', csrf_token: 'abc123' };

function row(over: Record<string, unknown> = {}) {
  return {
    id: 85468269,
    ocrResultId: 85468404,
    originalFilename: 'Inv3890320.pdf',
    filename: 'Temp/Inv3890320-f_clDjQ5.pdf',
    vendorName: "McCall's Supply Inc.",
    documentType: 0,
    date: '2026-08-24T08:06:00',
    status: 2,
    scanComplete: true,
    billWasCreated: false,
    totalAmount: 669.75,
    documentCount: 1,
    currentDocument: 1,
    ...over,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('ap_inbox_list_documents — spans the pending/created boundary', () => {
  it('defaults to BOTH pending (2) and created (3)', async () => {
    const fetchMock = vi.fn(async (_url: any, init: any) => {
      const st = JSON.parse(init.body).status;
      return jsonResponse({
        result: [row({ status: st[0], billWasCreated: st[0] === 3 })],
        totalCount: st[0] === 2 ? 99 : 591,
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const out: any = await ap_inbox_list_documents.handler({} as any, { ...AUTH }, ctx);

    expect(out.statuses_requested).toEqual([2, 3]);
    expect(out.total_by_status).toEqual({ '2': 99, '3': 591 });
    expect(out.documents.map((d: any) => d.status).sort()).toEqual([2, 3]);
  });

  // One request per status rather than status:[2,3] in a single call. ST
  // silently ignores params it does not understand and returns an unfiltered
  // page as HTTP 200 (QUA-1054/QUA-951); if it honoured only the first array
  // element we would silently get pending-only and reintroduce the exact
  // blindness QUA-1167 exists to fix.
  it('issues one request per status so a dropped filter cannot hide', async () => {
    const seen: number[][] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_u: any, init: any) => {
        const st = JSON.parse(init.body).status;
        seen.push(st);
        return jsonResponse({ result: [row({ status: st[0] })], totalCount: 1 });
      }),
    );
    await ap_inbox_list_documents.handler({} as any, { ...AUTH }, ctx);
    expect(seen).toEqual([[2], [3]]);
  });

  // The QUA-1054 discipline: a wrong answer is worse than no answer.
  it('THROWS if ServiceTitan returns rows of a status we did not ask for', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ result: [row({ status: 1 })], totalCount: 1 })),
    );
    await expect(
      ap_inbox_list_documents.handler({} as any, { ...AUTH, statuses: [2] }, ctx),
    ).rejects.toThrow(/status/i);
  });
});

describe('ap_inbox_list_documents — slim shape', () => {
  it('maps the live row field names, taking vendor_name from the list row', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ result: [row()], totalCount: 1 })));
    const out: any = await ap_inbox_list_documents.handler(
      { } as any, { ...AUTH, statuses: [2] }, ctx,
    );
    expect(out.documents[0]).toEqual({
      document_id: 85468269, // from row.id, NOT row.documentId
      ocr_result_id: 85468404,
      original_filename: 'Inv3890320.pdf',
      vendor_name: "McCall's Supply Inc.",
      total_amount: 669.75,
      status: 2,
      scan_complete: true,
      bill_was_created: false,
      vendor_invoice_number: null,
      vendor_id: null,
      is_bill_duplicate: null,
    });
  });

  // createdBillId does not exist on ANY ServiceTitan read surface. The row
  // carries only the boolean. Shipping an always-null field would imply the
  // question is answerable.
  it('does not invent a created_bill_id field', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ result: [row()], totalCount: 1 })));
    const out: any = await ap_inbox_list_documents.handler({} as any, { ...AUTH, statuses: [2] }, ctx);
    expect(out.documents[0]).not.toHaveProperty('created_bill_id');
    expect(out.documents[0]).not.toHaveProperty('createdBillId');
  });
});

describe('ap_inbox_list_documents — enrichment is opt-in and bounded', () => {
  // The created-bill sweep measured 516 ReadBillDocument calls / ~19 min at
  // ~0.45 rows/sec. That does not fit in a Worker request.
  it('makes no per-document call when enrich is false', async () => {
    const f = vi.fn(async () => jsonResponse({ result: [row(), row({ id: 2 })], totalCount: 2 }));
    vi.stubGlobal('fetch', f);
    const out: any = await ap_inbox_list_documents.handler({} as any, { ...AUTH, statuses: [2] }, ctx);
    expect(f).toHaveBeenCalledTimes(1); // list only
    expect(out.enriched).toBe(false);
    expect(out.documents[0].vendor_invoice_number).toBeNull();
  });

  it('fills vendor_invoice_number from ReadBillDocument when enriched', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: any) =>
        String(url).includes('ReadBillDocument')
          ? jsonResponse({
              isBillDuplicate: false,
              billData: {
                vendorDocumentNumber: { value: '396175 01', text: '396175 01' },
                purchasingVendor: { value: 288, text: "McCall's Supply Inc." },
              },
            })
          : jsonResponse({ result: [row()], totalCount: 1 }),
      ),
    );
    const out: any = await ap_inbox_list_documents.handler(
      { } as any, { ...AUTH, statuses: [2], enrich: true }, ctx,
    );
    expect(out.enriched).toBe(true);
    expect(out.documents[0].vendor_invoice_number).toBe('39617501'); // normalized, space kept as data
    expect(out.documents[0].vendor_id).toBe(288);
    expect(out.documents[0].is_bill_duplicate).toBe(false);
  });

  it('stops at enrich_limit and reports a resumable cursor', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => row({ id: 100 + i, ocrResultId: 200 + i }));
    let reads = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: any) => {
        if (String(url).includes('ReadBillDocument')) {
          reads++;
          return jsonResponse({ isBillDuplicate: false, billData: { vendorDocumentNumber: 'X1' } });
        }
        return jsonResponse({ result: rows, totalCount: 5 });
      }),
    );
    const out: any = await ap_inbox_list_documents.handler(
      { } as any, { ...AUTH, statuses: [2], enrich: true, enrich_limit: 2 }, ctx,
    );
    expect(reads).toBe(2);
    expect(out.next_cursor).toBe(2);
    expect(out.documents[0].vendor_invoice_number).toBe('X1');
    expect(out.documents[4].vendor_invoice_number).toBeNull(); // beyond the cap
  });

  it('resumes from enrich_cursor', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => row({ id: 100 + i, ocrResultId: 200 + i }));
    const readIds: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: any) => {
        if (String(url).includes('ReadBillDocument')) {
          readIds.push(new URL(String(url)).searchParams.get('documentId')!);
          return jsonResponse({ isBillDuplicate: false, billData: { vendorDocumentNumber: 'X' } });
        }
        return jsonResponse({ result: rows, totalCount: 5 });
      }),
    );
    const out: any = await ap_inbox_list_documents.handler(
      { } as any,
      { ...AUTH, statuses: [2], enrich: true, enrich_limit: 2, enrich_cursor: 3 },
      ctx,
    );
    expect(readIds).toEqual(['103', '104']);
    expect(out.next_cursor).toBeNull(); // exhausted
  });
});

describe('ap_inbox_list_documents — auth transport', () => {
  it('sends the headers ServiceTitan requires, including hand-set origin/referer', async () => {
    const f = vi.fn(async (_url: any, _init: any) => jsonResponse({ result: [], totalCount: 0 }));
    vi.stubGlobal('fetch', f);
    await ap_inbox_list_documents.handler({} as any, { ...AUTH, statuses: [2] }, ctx);
    const h = f.mock.calls[0]![1].headers;
    expect(h.cookie).toBe(AUTH.session_cookie);
    expect(h['x-csrf-token']).toBe(AUTH.csrf_token);
    expect(h['x-requested-with']).toBe('XMLHttpRequest');
    // A browser sets these automatically; a Worker must not omit them.
    expect(h.origin).toBe('https://go.servicetitan.com');
    expect(h.referer).toBe('https://go.servicetitan.com/');
  });

  it('sends the pageIndex/pageSize body, never skip/take', async () => {
    const f = vi.fn(async (_url: any, _init: any) => jsonResponse({ result: [], totalCount: 0 }));
    vi.stubGlobal('fetch', f);
    await ap_inbox_list_documents.handler({} as any, { ...AUTH, statuses: [2] }, ctx);
    const body = JSON.parse(f.mock.calls[0]![1].body);
    expect(body).toMatchObject({ pageIndex: 1, orderBy: 'date' });
    expect(body).not.toHaveProperty('skip');
    expect(body).not.toHaveProperty('take');
  });

  // __cf_bm (~30m) and cf_clearance are bot-management tokens. When they lapse
  // the response is a Cloudflare challenge PAGE, not JSON. Never retry into it
  // and never return a partial result.
  it('throws a typed error on a non-JSON challenge response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<!DOCTYPE html><title>Just a moment...</title>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })),
    );
    await expect(
      ap_inbox_list_documents.handler({} as any, { ...AUTH, statuses: [2] }, ctx),
    ).rejects.toThrow(/challenge|re-?capture|expired/i);
  });

  it('throws a re-capture instruction on 401', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })));
    await expect(
      ap_inbox_list_documents.handler({} as any, { ...AUTH, statuses: [2] }, ctx),
    ).rejects.toThrow(/re-?capture|session/i);
  });

  it('never leaks the cookie into an error message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    const err: any = await ap_inbox_list_documents
      .handler({} as any, { ...AUTH, statuses: [2] }, ctx)
      .catch((e: unknown) => e);
    expect(String(err.message)).not.toContain('AspNetCore');
    expect(String(err.message)).not.toContain(AUTH.csrf_token);
  });
});

describe('ap_inbox_list_documents — credentials are redacted in the audit log', () => {
  // src/tool-registry.ts redacts by KEY NAME against CREDENTIAL_FIELD_PATTERNS.
  // session_cookie hits /cookie/i and csrf_token hits /token/i. Naming these
  // args anything else puts a live ST session into D1 audit_log.payload
  // verbatim. This asserts the behaviour, not the convention.
  it('redactPayload strips session_cookie and csrf_token', () => {
    const out: any = redactPayload({ ...AUTH, statuses: [2], enrich: true });
    expect(out.session_cookie).not.toContain('AspNetCore');
    expect(String(out.session_cookie)).toMatch(/^\[redacted/);
    expect(String(out.csrf_token)).toMatch(/^\[redacted/);
    expect(out.enrich).toBe(true); // non-credential args survive
  });

  it('the tool actually uses those arg names', () => {
    expect(Object.keys(ap_inbox_list_documents.zodSchema)).toEqual(
      expect.arrayContaining(['session_cookie', 'csrf_token']),
    );
  });
});

describe('ap_inbox_list_documents — tool contract', () => {
  it('is read-only', () => {
    expect(ap_inbox_list_documents.isWrite).toBeFalsy();
  });

  it('describes every schema field', () => {
    for (const [name, field] of Object.entries(ap_inbox_list_documents.zodSchema)) {
      expect((field as any).description, `${name} needs .describe()`).toBeTruthy();
    }
  });
});
