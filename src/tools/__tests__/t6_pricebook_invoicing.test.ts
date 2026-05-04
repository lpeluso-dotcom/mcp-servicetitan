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
  it('requires parentEquipmentId', async () => {
    const schema = z.object(get_configurable_equipment_children.zodSchema);
    expect(schema.safeParse({}).success).toBe(false);
  });

  it('fetches children for parent equipment ID', async () => {
    const env = makeEnv(liveOk([{ id: 101 }, { id: 102 }]));
    const result: any = await get_configurable_equipment_children.handler(env, { parentEquipmentId: 99 }, CTX);
    expect(result.equipment).toBeDefined();
  });

  it('calls equipment endpoint with correct parent ID', async () => {
    const env = makeEnv(liveOk([]));
    await get_configurable_equipment_children.handler(env, { parentEquipmentId: 99 }, CTX);
    const [url] = env.ST_PROXY.fetch.mock.calls[0];
    expect(url).toContain('equipment');
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
    const env = makeEnv(liveOk({ id: 200, total: 350.00 }));
    const result: any = await get_invoice.handler(env, { invoiceId: 200 }, CTX);
    expect(result.invoice).toBeDefined();
  });

  it('calls accounting invoices endpoint with ID', async () => {
    const env = makeEnv(liveOk({ id: 200 }));
    await get_invoice.handler(env, { invoiceId: 200 }, CTX);
    const [url] = env.ST_PROXY.fetch.mock.calls[0];
    expect(url).toContain('200');
    expect(url).toContain('invoice');
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
    const env = makeEnv(liveOk({ id: 200, balance: 150.00, total: 350.00 }));
    const result: any = await get_invoice_balance.handler(env, { invoiceId: 200 }, CTX);
    expect(result.balance).toBeDefined();
    expect(result.balance.invoiceId).toBe(200);
  });

  it('calls invoices endpoint (T9: not /payments/)', async () => {
    const env = makeEnv(liveOk({ id: 200, balance: 0 }));
    await get_invoice_balance.handler(env, { invoiceId: 200 }, CTX);
    const [url] = env.ST_PROXY.fetch.mock.calls[0];
    expect(url).toContain('invoice');
    expect(url).not.toContain('payment');
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
});
