// ============================================================
// qua1054_951_silent_filter_drop.test.ts
//
// QUA-1054 (Urgent) + QUA-951 — one defect, two tickets: a filter arg is
// accepted, forwarded to an ST list endpoint under a name ST does not
// recognize, silently discarded upstream, and the caller gets unfiltered
// page 1 as HTTP 200 with no warning.
//
// Param support below was VERIFIED AGAINST LIVE ST on 2026-08-04
// (tenant 431848990, via taylor-ai /api/st/read). totalCount is the tell:
// an ignored filter leaves it at the unfiltered total.
//
//   GET /crm/v2/tenant/{tid}/customers          (unfiltered totalCount 11783)
//     phone=8432609814        -> 1      HONORED  (also accepts formatted
//                                        "(843) 260-9814" / "843-260-9814")
//     phone=8439072345        -> 0      HONORED (no match, correctly empty)
//     phoneNumber=8439072345  -> 11783  IGNORED  <- what the code shipped
//     name=Ramsey             -> 5      HONORED
//     active=false            -> 577    HONORED
//     ids=261837              -> 1      HONORED
//     email=HEIDI@EBCSC.COM   -> 11783  IGNORED  <- real, matching address
//
//   GET /pricebook/v2/tenant/{tid}/services     (unfiltered totalCount 2834)
//     active=false            -> 43414  HONORED
//     ids=98                  -> 1      HONORED
//     search=generator        -> 2834   IGNORED
//     name=generator          -> 2834   IGNORED
//     categoryId=62298116     -> 2834   IGNORED
//
// ST has NO text-search or category filter on the pricebook list endpoints,
// and NO email filter on customers. Those args cannot be honored server-side
// at all, so per Luke's ruling (2026-08-04) they must be REJECTED LOUDLY
// rather than silently degraded to an unfiltered page.
// ============================================================

import { describe, it, expect, vi } from 'vitest';
import { find_customer } from '../crm/find_customer';
import { st_get_pricebook } from '../st_get_pricebook';
import { search_pricebook_services } from '../pricebook/search_pricebook_services';
import { assertFilterPreservation } from './filter_preservation_helper';

interface Captured {
  url: string;
  body: unknown;
}

/** Env whose ST proxy records every outbound call and returns an unfiltered-looking page. */
function spyEnv(captured: Captured[], d1Rows: unknown[] = []) {
  return {
    ST_TENANT_ID: '000000000',
    MCP_SYNC_KEY: 'test',
    ST_PROXY: {
      fetch: vi.fn(async (url: string | URL, init?: RequestInit) => {
        const u = typeof url === 'string' ? url : url.toString();
        captured.push({ url: u, body: init?.body ?? null });
        if (u.includes('/api/sql/read')) {
          return new Response(JSON.stringify({ success: true, results: d1Rows }), { status: 200 });
        }
        // Simulate ST's real behaviour: unknown filters are ignored and it
        // happily returns page 1 of everything.
        return new Response(
          JSON.stringify({
            data: [
              { id: 261837, name: 'Ebenezer Baptist Church' },
              { id: 261838, name: '1507 Langley' },
            ],
            hasMore: true,
            totalCount: 11783,
          }),
          { status: 200 },
        );
      }),
    },
  } as never;
}

const stCalls = (c: Captured[]) => c.filter((x) => x.url.includes('/api/st/read'));

describe('QUA-1054 — find_customer filters must reach ST or be rejected', () => {
  it('sends the phone filter as ST-supported `phone`, never `phoneNumber`', async () => {
    const captured: Captured[] = [];
    await find_customer.handler(spyEnv(captured), { phone: '8432609814' }, {
      actor: 'test',
      correlation: 'qua1054-phone',
    });

    const urls = stCalls(captured).map((c) => decodeURIComponent(c.url));
    expect(urls.length, 'expected a live ST call').toBeGreaterThan(0);
    expect(urls.some((u) => /[?&]phone=8432609814/.test(u)), `phone filter missing. URLs: ${urls.join('\n')}`).toBe(true);
    expect(
      urls.some((u) => /phoneNumber=/.test(u)),
      'phoneNumber is silently ignored by ST — it must never be sent',
    ).toBe(false);
  });

  it('rejects `email` rather than returning an unfiltered page (ST has no email filter)', async () => {
    const captured: Captured[] = [];
    await expect(
      find_customer.handler(spyEnv(captured), { email: 'HEIDI@EBCSC.COM' }, {
        actor: 'test',
        correlation: 'qua1054-email',
      }),
    ).rejects.toThrow(/email/i);

    expect(
      stCalls(captured).length,
      'must not call ST at all when the only filter given cannot be honored',
    ).toBe(0);
  });

  it('still forwards `name`, which ST does honor (regression guard)', async () => {
    const captured: Captured[] = [];
    await find_customer.handler(spyEnv(captured), { name: 'Ramsey' }, {
      actor: 'test',
      correlation: 'qua1054-name',
    });
    const urls = stCalls(captured).map((c) => decodeURIComponent(c.url));
    expect(urls.some((u) => /[?&]name=Ramsey/.test(u))).toBe(true);
  });

  it('passes the shared filter-preservation harness', async () => {
    await assertFilterPreservation(find_customer, {
      name: { value: 'Ramsey', expect: 'forwarded_query', key: 'name' },
      phone: { value: '8432609814', expect: 'forwarded_query', key: 'phone' },
      email: { value: 'a@b.com', expect: 'rejected_or_skipped' },
    });
  });
});

describe('QUA-951 — pricebook filters must reach ST or be rejected', () => {
  it('rejects st_get_pricebook `search` (ST ignores it) instead of returning page 1', async () => {
    const captured: Captured[] = [];
    await expect(
      st_get_pricebook.handler(spyEnv(captured), { assetType: 'services', search: 'generator' }, {
        actor: 'test',
        correlation: 'qua951-search',
      }),
    ).rejects.toThrow(/search/i);

    expect(stCalls(captured).length, 'must not hit ST with a filter it will discard').toBe(0);
  });

  it('still forwards st_get_pricebook `active`, which ST does honor (regression guard)', async () => {
    const captured: Captured[] = [];
    await st_get_pricebook.handler(spyEnv(captured), { assetType: 'services', active: true }, {
      actor: 'test',
      correlation: 'qua951-active',
    });
    const urls = stCalls(captured).map((c) => decodeURIComponent(c.url));
    expect(urls.some((u) => /[?&]active=true/.test(u))).toBe(true);
  });

  it('rejects search_pricebook_services `name` and `categoryId` (both ignored by ST)', async () => {
    for (const args of [{ name: 'generator' }, { categoryId: 62298116 }]) {
      const captured: Captured[] = [];
      await expect(
        search_pricebook_services.handler(spyEnv(captured), args, {
          actor: 'test',
          correlation: 'qua951-fuzzy',
        }),
        `expected rejection for ${JSON.stringify(args)}`,
      ).rejects.toThrow(/name|categoryId|search_pricebook_all/i);
      expect(stCalls(captured).length).toBe(0);
    }
  });

  it('does NOT fall through to an unfiltered live call when an exact code misses in D1', async () => {
    // Pre-fix this path sent name=<code> to ST, which ignores `name` — so a
    // code that does not exist returned 50 arbitrary services as if they matched.
    const captured: Captured[] = [];
    const res = (await search_pricebook_services.handler(
      spyEnv(captured, []),
      { code: 'NO-SUCH-CODE-XYZ' },
      { actor: 'test', correlation: 'qua951-miss' },
    )) as { services?: unknown[] };

    expect(stCalls(captured).length, 'a D1 miss must not degrade into an unfiltered ST page').toBe(0);
    expect(res.services ?? []).toHaveLength(0);
  });
});
