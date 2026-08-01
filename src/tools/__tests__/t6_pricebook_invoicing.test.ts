// ============================================================
// T6 tests — Pricebook (5) + Invoicing (4)
// Strategy: mock env.ST_PROXY.fetch + env.DB.
// Tests cover: schema validation, correct ST endpoint, dryRun
// for writes, and T8/T9 catalog corrections.
// ============================================================

import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { search_pricebook_services } from '../pricebook/search_pricebook_services';
import { get_service_details } from '../pricebook/get_service_details';
import { search_materials } from '../pricebook/search_materials';
import { get_configurable_equipment_children } from '../pricebook/get_configurable_equipment_children';
import { list_service_categories } from '../pricebook/list_service_categories';
import { get_invoice } from '../invoicing/get_invoice';
import { list_invoices_job } from '../invoicing/list_invoices_job';
import { get_invoice_balance } from '../invoicing/get_invoice_balance';
import { list_unpaid_invoices } from '../invoicing/list_unpaid_invoices';

const CORRELATION = 'test-corr';
const CTX = { actor: 'vitest', correlation: CORRELATION };

function makeDB(firstResult: unknown = null) {
  const stmt = {
    bind: vi.fn().mockReturnThis(),
    run: vi.fn().mockResolvedValue({ success: true }),
    first: vi.fn().mockResolvedValue(firstResult),
  };
  return { prepare: vi.fn().mockReturnValue(stmt) };
}

function makeEnv(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>): any {
  return {
    ST_PROXY: { fetch: vi.fn(fetchImpl) },
    MCP_SYNC_KEY: 'test-key',
    MCP_SERVICE_VERSION: '0.0.0-test',
    DB: makeDB(),
    PROXY_STATE: {},
    SIRO_API_TOKEN: '',
  };
}

function liveOk(data: unknown) {
  return async () => new Response(JSON.stringify({ data }), { status: 200 });
}

function dryRunFetch() {
  return async (url: string) => {
    if (url.includes('dryRun=1')) return new Response(JSON.stringify({ echo: true }), { status: 200 });
    throw new Error(`unexpected URL: ${url}`);
  };
}

// ── Pricebook ────────────────────────────────────────────────

describe('search_pricebook_services', () => {
  it('accepts empty args', async () => {
    const env = makeEnv(liveOk([{ id: 1, name: 'AC Tune-Up' }]));
    const result: any = await search_pricebook_services.handler(env, {}, CTX);
    expect(result.services).toBeDefined();
    expect(Array.isArray(result.services)).toBe(true);
  });

  it('passes name filter to endpoint', async () => {
    const env = makeEnv(liveOk([{ id: 1, name: 'AC Tune-Up' }]));
    await search_pricebook_services.handler(env, { name: 'AC' }, CTX);
    const [url] = env.ST_PROXY.fetch.mock.calls[0];
    expect(url).toContain('AC');
  });

  it('passes categoryId filter', async () => {
    const env = makeEnv(liveOk([]));
    await search_pricebook_services.handler(env, { categoryId: 42 }, CTX);
    const [url] = env.ST_PROXY.fetch.mock.calls[0];
    expect(url).toContain('42');
  });

  it('rejects pageSize over 200', async () => {
    const env = makeEnv(liveOk([]));
    const schema = z.object(search_pricebook_services.zodSchema);
    expect(schema.safeParse({ pageSize: 201 }).success).toBe(false);
  });

  it('result includes _source annotation', async () => {
    const env = makeEnv(liveOk([{ id: 1 }]));
    const result: any = await search_pricebook_services.handler(env, {}, CTX);
    expect(result._source).toBeDefined();
  });
});

describe('get_service_details', () => {
  it('requires serviceId', async () => {
    const schema = z.object(get_service_details.zodSchema);
    expect(schema.safeParse({}).success).toBe(false);
  });

  it('fetches service by ID from D1', async () => {
    const env = makeEnv(liveOk({ id: 55, name: 'Diagnostic' }));
    const result: any = await get_service_details.handler(env, { serviceId: 55 }, CTX);
    expect(result.service).toBeDefined();
  });

  it('calls pricebook services endpoint with correct ID', async () => {
    const env = makeEnv(liveOk({ id: 55 }));
    await get_service_details.handler(env, { serviceId: 55 }, CTX);
    const [url] = env.ST_PROXY.fetch.mock.calls[0];
    expect(url).toContain('55');
  });
});

describe('search_materials', () => {
  it('accepts empty args', async () => {
    const env = makeEnv(liveOk([]));
    const result: any = await search_materials.handler(env, {}, CTX);
    expect(result.materials).toBeDefined();
  });

  it('passes name filter', async () => {
    const env = makeEnv(liveOk([]));
    await search_materials.handler(env, { name: 'R-22' }, CTX);
    const [url] = env.ST_PROXY.fetch.mock.calls[0];
    expect(url).toContain('R-22');
  });

  it('result includes _source annotation', async () => {
    const env = makeEnv(liveOk([]));
    const result: any = await search_materials.handler(env, {}, CTX);
    expect(result._source).toBeDefined();
  });
});

describe('get_configurable_equipment_children', () => {
  // Single-record GET returns the resource directly — no { data } envelope.
  const singleOk = (record: unknown) => async () =>
    new Response(JSON.stringify(record), { status: 200 });

  it('requires parentEquipmentId', async () => {
    const schema = z.object(get_configurable_equipment_children.zodSchema);
    expect(schema.safeParse({}).success).toBe(false);
  });

  it('GETs the parent record by id — never the list endpoint with a parentEquipmentId param', async () => {
    // ST's /equipment list endpoint has no parentEquipmentId filter; it silently
    // ignores unknown query params and returns the unfiltered first page.
    const env = makeEnv(singleOk({ id: 99, isConfigurableEquipment: true, variationsOrConfigurableEquipment: [] }));
    await get_configurable_equipment_children.handler(env, { parentEquipmentId: 99 }, CTX);
    const [url] = env.ST_PROXY.fetch.mock.calls[0];
    const endpoint = decodeURIComponent(url.split('endpoint=')[1]);
    expect(endpoint).toContain('/equipment/99');
    expect(endpoint).not.toContain('parentEquipmentId');
  });

  it('hydrates variationsOrConfigurableEquipment ids into equipment records', async () => {
    // ST returns the variants as bare integer ids (verified live 2026-07-18 on
    // parent 77672766 → [76332415]); each is fetched to keep the tool's
    // equipment-records contract.
    const records: Record<string, unknown> = {
      '/equipment/77672766': { id: 77672766, isConfigurableEquipment: true, variationsOrConfigurableEquipment: [76332415] },
      '/equipment/76332415': { id: 76332415, displayName: 'Variant WH', active: true },
    };
    const env = makeEnv(async (url: string) => {
      const endpoint = decodeURIComponent(url.split('endpoint=')[1]);
      const match = Object.entries(records).find(([suffix]) => endpoint.endsWith(suffix));
      if (!match) throw new Error(`unexpected URL: ${endpoint}`);
      return new Response(JSON.stringify(match[1]), { status: 200 });
    });
    const result: any = await get_configurable_equipment_children.handler(env, { parentEquipmentId: 77672766 }, CTX);
    expect(result.equipment).toEqual([{ id: 76332415, displayName: 'Variant WH', active: true }]);
    expect(result.parentEquipmentId).toBe(77672766);
    expect(result.isConfigurableEquipment).toBe(true);
  });

  it('returns empty equipment for a non-configurable parent with no variations field', async () => {
    const env = makeEnv(singleOk({ id: 99, isConfigurableEquipment: false }));
    const result: any = await get_configurable_equipment_children.handler(env, { parentEquipmentId: 99 }, CTX);
    expect(result.equipment).toEqual([]);
    expect(result.isConfigurableEquipment).toBe(false);
  });

  // The defect this tool is being fixed for (2026-07-18) was that a nonexistent
  // parent id still returned 50 unrelated equipment rows. Pin the replacement
  // behaviour: the by-id GET 404s and that must surface as not_found, never as
  // an empty-but-successful result that reads like "this parent has no variants".
  it('surfaces a nonexistent parent as not_found, not an empty success', async () => {
    const env = makeEnv(async () => new Response('{"message":"Not Found"}', { status: 404 }));
    await expect(
      get_configurable_equipment_children.handler(env, { parentEquipmentId: 999999999 }, CTX),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('discloses truncation when a parent carries more variants than the hydration cap', async () => {
    const variantIds = Array.from({ length: 30 }, (_, i) => 900000 + i);
    const env = makeEnv(async (url: string) => {
      const endpoint = decodeURIComponent(url.split('endpoint=')[1]);
      const id = Number(endpoint.split('/equipment/')[1]);
      if (id === 5150) {
        return new Response(
          JSON.stringify({ id: 5150, isConfigurableEquipment: true, variationsOrConfigurableEquipment: variantIds }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ id, displayName: `Variant ${id}` }), { status: 200 });
    });
    const result: any = await get_configurable_equipment_children.handler(env, { parentEquipmentId: 5150 }, CTX);
    // Capping is fine; capping SILENTLY is the audit's P-2 anti-pattern — a
    // caller must be able to tell 25-of-30 from a complete list of 25.
    expect(result.equipment).toHaveLength(25);
    expect(result.truncated).toBe(true);
    expect(result.variant_count).toBe(30);
  });
});

describe('list_service_categories', () => {
  it('accepts empty args', async () => {
    const env = makeEnv(liveOk([{ id: 1, name: 'HVAC' }]));
    const result: any = await list_service_categories.handler(env, {}, CTX);
    expect(result.categories).toBeDefined();
  });

  it('calls pricebook service categories endpoint (not materials categories)', async () => {
    const env = makeEnv(liveOk([]));
    await list_service_categories.handler(env, {}, CTX);
    const [url] = env.ST_PROXY.fetch.mock.calls[0];
    expect(url).toContain('pricebook');
    expect(url).toContain('categor');
    expect(url).not.toContain('materials');
  });
});

// ── Invoicing ────────────────────────────────────────────────

describe('get_invoice', () => {
  it('requires invoiceId', async () => {
    const schema = z.object(get_invoice.zodSchema);
    expect(schema.safeParse({}).success).toBe(false);
  });

  it('fetches invoice by ID', async () => {
    const env = makeEnv(liveOk([{ id: 200, total: 350.00 }]));
    const result: any = await get_invoice.handler(env, { invoiceId: 200 }, CTX);
    expect(result.invoice).toBeDefined();
  });

  it('calls accounting invoices endpoint with ID', async () => {
    const env = makeEnv(liveOk([{ id: 200 }]));
    await get_invoice.handler(env, { invoiceId: 200 }, CTX);
    const [url] = env.ST_PROXY.fetch.mock.calls[0];
    expect(url).toContain('200');
    expect(url).toContain('invoice');
  });

  it('get_invoice fetches via ?ids= and unwraps data[0]', async () => {
    let captured = '';
    const env = makeEnv(async (url: string) => {
      captured = url;
      return new Response(JSON.stringify({ data: [{ id: 279340, total: '150.00' }] }), { status: 200 });
    });
    const result: any = await get_invoice.handler(env, { invoiceId: 279340 }, CTX);
    const endpoint = new URL(captured).searchParams.get('endpoint')!;
    expect(endpoint).toBe('/accounting/v2/tenant/000000000/invoices?ids=279340');
    expect(result.invoice).toEqual({ id: 279340, total: '150.00' });
  });

  it('get_invoice throws not_found when ids filter returns empty', async () => {
    const env = makeEnv(liveOk([]));
    await expect(get_invoice.handler(env, { invoiceId: 999 }, CTX)).rejects.toThrow(/not found/i);
    await expect(get_invoice.handler(env, { invoiceId: 999 }, CTX)).rejects.toMatchObject({ code: 'not_found' });
  });

  // Guard against ST silently ignoring the ids param (documented history of
  // silently-ignored params on this endpoint — see balanceExcludeZero in
  // list_unpaid_invoices). data[0] must actually BE the requested invoice.
  it('get_invoice rejects when ids filter is not honored (wrong invoice in data[0])', async () => {
    const env = makeEnv(liveOk([{ id: 999, total: '1.00' }]));
    await expect(get_invoice.handler(env, { invoiceId: 279340 }, CTX)).rejects.toThrow(/ids filter not honored/);
  });
});

describe('list_invoices_job', () => {
  it('requires jobId', async () => {
    const schema = z.object(list_invoices_job.zodSchema);
    expect(schema.safeParse({}).success).toBe(false);
  });

  it('fetches invoices for a job', async () => {
    const env = makeEnv(liveOk([{ id: 300, jobId: 123 }]));
    const result: any = await list_invoices_job.handler(env, { jobId: 123 }, CTX);
    expect(result.invoices).toBeDefined();
    expect(Array.isArray(result.invoices)).toBe(true);
  });

  it('calls invoices endpoint with jobId filter', async () => {
    const env = makeEnv(liveOk([]));
    await list_invoices_job.handler(env, { jobId: 123 }, CTX);
    const [url] = env.ST_PROXY.fetch.mock.calls[0];
    expect(url).toContain('123');
  });
});

describe('get_invoice_balance', () => {
  // T9 catalog correction: renamed from get_payment_status
  // /payments/{id} returns a payment object, NOT a status;
  // balance is on the invoice itself.
  it('requires invoiceId', async () => {
    const schema = z.object(get_invoice_balance.zodSchema);
    expect(schema.safeParse({}).success).toBe(false);
  });

  it('fetches invoice balance (not /payments/ endpoint)', async () => {
    const env = makeEnv(liveOk([{ id: 200, balance: 150.00, total: 350.00 }]));
    const result: any = await get_invoice_balance.handler(env, { invoiceId: 200 }, CTX);
    expect(result.balance).toBeDefined();
    expect(result.balance.invoiceId).toBe(200);
  });

  it('calls invoices endpoint (T9: not /payments/)', async () => {
    const env = makeEnv(liveOk([{ id: 200, balance: 0 }]));
    await get_invoice_balance.handler(env, { invoiceId: 200 }, CTX);
    const [url] = env.ST_PROXY.fetch.mock.calls[0];
    expect(url).toContain('invoice');
    expect(url).not.toContain('payment');
  });

  it('get_invoice_balance fetches via ?ids= and reads balance off data[0]', async () => {
    let captured = '';
    const env = makeEnv(async (url: string) => {
      captured = url;
      return new Response(JSON.stringify({ data: [{ id: 279340, total: '150.00', balance: '25.00', payments: [] }] }), { status: 200 });
    });
    const result: any = await get_invoice_balance.handler(env, { invoiceId: 279340 }, CTX);
    const endpoint = new URL(captured).searchParams.get('endpoint')!;
    expect(endpoint).toBe('/accounting/v2/tenant/000000000/invoices?ids=279340');
    expect(result.balance).toMatchObject({ invoiceId: 279340, total: '150.00', balance: '25.00' });
  });

  it('get_invoice_balance throws not_found when ids filter returns empty', async () => {
    const env = makeEnv(liveOk([]));
    await expect(get_invoice_balance.handler(env, { invoiceId: 999 }, CTX)).rejects.toThrow(/not found/i);
    await expect(get_invoice_balance.handler(env, { invoiceId: 999 }, CTX)).rejects.toMatchObject({ code: 'not_found' });
  });

  // Same ids-honored guard as get_invoice — silently returning an arbitrary
  // invoice's balance would be silently wrong financial data.
  it('get_invoice_balance rejects when ids filter is not honored (wrong invoice in data[0])', async () => {
    const env = makeEnv(liveOk([{ id: 999, total: '1.00', balance: '1.00', payments: [] }]));
    await expect(get_invoice_balance.handler(env, { invoiceId: 279340 }, CTX)).rejects.toThrow(/ids filter not honored/);
  });
});

describe('list_unpaid_invoices', () => {
  it('accepts empty args', async () => {
    const env = makeEnv(liveOk([{ id: 1, balance: 50.00 }]));
    const result: any = await list_unpaid_invoices.handler(env, {}, CTX);
    expect(result.invoices).toBeDefined();
  });

  it('accepts businessUnitId filter', async () => {
    const env = makeEnv(liveOk([]));
    const result: any = await list_unpaid_invoices.handler(env, { businessUnitId: 7 }, CTX);
    expect(result.invoices).toBeDefined();
  });

  it('filters to unpaid invoices only', async () => {
    const env = makeEnv(liveOk([]));
    await list_unpaid_invoices.handler(env, {}, CTX);
    const [url] = env.ST_PROXY.fetch.mock.calls[0];
    // ST uses "outstanding" balance filter — endpoint must filter non-zero balance
    expect(url).toContain('invoice');
  });

  // QUA-649: ST's /accounting/v2/tenant/{tid}/invoices endpoint silently
  // ignores balanceExcludeZero — it isn't a real filter param there (confirmed
  // against the D1 mirror: ~1,060 real unpaid invoices exist vs. this tool
  // returning legacy $0-balance rows). The endpoint returns everything
  // regardless of what we ask it to filter, so the tool must filter client-side
  // the same way list_jobs_today's ET-appointments fix (PR #41) does for its
  // own silently-ignored params.
  it('drops $0-balance invoices client-side even though ST returns them anyway', async () => {
    const env = makeEnv(
      liveOk([
        { id: 1, balance: 0 },
        { id: 2, balance: 128.5 },
        { id: 3, balance: 0 },
        { id: 4, balance: 42 },
      ]),
    );

    const result: any = await list_unpaid_invoices.handler(env, {}, CTX);

    expect(result.invoices.map((i: any) => i.id)).toEqual([2, 4]);
  });

  it('excludes string "0.00" balances', async () => {
    const env = makeEnv(liveOk([
      { id: 1, balance: '0.00' },
      { id: 2, balance: '150.00' },
      { id: 3, balance: '0' },
    ]));
    const result: any = await list_unpaid_invoices.handler(env, {}, CTX);
    expect(result.invoices.map((i: any) => i.id)).toEqual([2]);
  });

  // NaN fail-open: a malformed balance must stay VISIBLE rather than be
  // silently hidden — hiding a possibly-unpaid invoice is the worse failure.
  it('keeps rows with malformed (non-numeric) balance visible', async () => {
    const env = makeEnv(liveOk([
      { id: 1, balance: 'abc' },
      { id: 2, balance: '0.00' },
      { id: 3, balance: '75.00' },
    ]));
    const result: any = await list_unpaid_invoices.handler(env, {}, CTX);
    expect(result.invoices.map((i: any) => i.id)).toEqual([1, 3]);
  });
});
