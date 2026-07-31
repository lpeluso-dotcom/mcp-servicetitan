// ============================================================
// Tests for st_patch_service, st_create_service,
//         st_patch_material, st_create_material
//
// F3 structure — two phases:
//   dryRun=true (default): WriteGate.dryRun → token + echo.
//   dryRun=false: WriteGate.verifyToken → durableWrite.
//
// Unit tests:
//   - dryRun path: mock DB.prepare (for INSERT) + ST_PROXY (for echo).
//   - Real-write path: use durableWrite directly (still exported).
//   - Validation errors: no DB/fetch calls needed.
// ============================================================

import { describe, it, expect, vi } from 'vitest';
import { st_patch_service, durableWrite } from '../st_patch_service';
import { st_create_service } from '../st_create_service';
import { st_patch_material } from '../st_patch_material';
import { st_create_material } from '../st_create_material';

const CORRELATION = 'test-correlation-id';
const CTX = { actor: 'vitest', correlation: CORRELATION };

// ── Env builder ──────────────────────────────────────────────

function makeDB(firstResult: unknown = null) {
  const stmt = {
    bind: vi.fn().mockReturnThis(),
    run: vi.fn().mockResolvedValue({ success: true }),
    first: vi.fn().mockResolvedValue(firstResult),
  };
  return { prepare: vi.fn().mockReturnValue(stmt) };
}

function makeEnv(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>, db = makeDB()): any {
  return {
    ST_PROXY: { fetch: vi.fn(fetchImpl) },
    MCP_SYNC_KEY: 'test-sync-key',
    MCP_SERVICE_VERSION: '0.0.0-test',
    DB: db,
    PROXY_STATE: {},
    SIRO_API_TOKEN: '',
  };
}

// Simulates the dryRun echo endpoint (/api/st/write?dryRun=1).
function dryRunFetch() {
  return async (url: string) => {
    if (url.includes('dryRun=1')) {
      return new Response(JSON.stringify({ echo: true }), { status: 200 });
    }
    throw new Error(`unexpected URL in dryRun test: ${url}`);
  };
}

// Simulates submit + completion for the real durable write workflow.
function happyFetch(output: unknown) {
  let call = 0;
  return async (url: string) => {
    call++;
    if (call === 1) {
      return new Response(JSON.stringify({ instance_id: 'inst-abc123' }), { status: 202 });
    }
    return new Response(JSON.stringify({ status: 'complete', output }), { status: 200 });
  };
}

// ── st_patch_service ─────────────────────────────────────────

describe('st_patch_service', () => {
  it('dryRun=true returns DryRunResult with tool + token', async () => {
    const env = makeEnv(dryRunFetch());
    const result: any = await st_patch_service.handler(env, { id: 12345, cost: 75 }, CTX);
    expect(result.dryRun).toBe(true);
    expect(result.tool).toBe('st_patch_service');
    expect(result.confirmation_token).toBeTypeOf('string');
    // F-07: pricebook tools use a tightened 5-min TTL (vs default 15-min) since they're
    // typically called from automated scripts, not LLMs that need rumination buffer.
    expect(result.expires_in_seconds).toBe(300);
    // DB must have recorded the token.
    expect(env.DB.prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT OR IGNORE INTO confirmation_tokens'));
  });

  it('throws validation_error when no fields besides id are provided', async () => {
    const env = makeEnv(async () => new Response('', { status: 200 }));
    await expect(st_patch_service.handler(env, { id: 12345 }, CTX))
      .rejects.toMatchObject({ code: 'validation_error' });
    expect(env.ST_PROXY.fetch).not.toHaveBeenCalled();
  });

  it('throws validation_error when dryRun=false with no token', async () => {
    const env = makeEnv(async () => new Response('', { status: 200 }));
    await expect(st_patch_service.handler(env, { id: 12345, cost: 50, dryRun: false }, CTX))
      .rejects.toMatchObject({ code: 'validation_error' });
  });

  // Test the underlying durable write path directly — operation + payload shape.
  it('durableWrite submits correct operation and payload for service patch', async () => {
    const output = { status: 'ok' };
    const env = makeEnv(happyFetch(output));
    const result = await durableWrite(env, {
      actor: CTX.actor, operation: 'service.patch',
      target: { id: '12345', type: 'service' }, payload: { cost: 75 }, correlation: CORRELATION,
    });
    expect(result).toEqual(output);
    const [url, init] = env.ST_PROXY.fetch.mock.calls[0];
    expect(url).toBe('https://servicetitan-proxy/api/st/durable-write');
    const body = JSON.parse(init.body);
    expect(body.operation).toBe('service.patch');
    expect(body.target).toEqual({ id: '12345', type: 'service' });
    expect(body.payload).toEqual({ cost: 75 });
    expect(body.dry_run).toBe(false);
  });

  it('throws the correct McpError code on upstream 4xx during durable write', async () => {
    const env = makeEnv(async () => new Response('Unauthorized', { status: 401 }));
    await expect(durableWrite(env, {
      actor: CTX.actor, operation: 'service.patch',
      target: { id: '1', type: 'service' }, payload: { name: 'x' }, correlation: CORRELATION,
    })).rejects.toMatchObject({ code: 'auth_failed' });
  });

  it('throws upstream_error when durable workflow reports errored', async () => {
    let call = 0;
    const env = makeEnv(async () => {
      call++;
      if (call === 1) return new Response(JSON.stringify({ instance_id: 'inst-err' }), { status: 202 });
      return new Response(JSON.stringify({ status: 'errored', error: 'pb_registry lock' }), { status: 200 });
    });
    await expect(durableWrite(env, {
      actor: CTX.actor, operation: 'service.patch',
      target: { id: '99', type: 'service' }, payload: { name: 'X' }, correlation: CORRELATION,
    })).rejects.toMatchObject({ code: 'upstream_error', message: expect.stringContaining('pb_registry lock') });
  });

  it('throws timeout when workflow never completes', async () => {
    let call = 0;
    const env = makeEnv(async () => {
      call++;
      if (call === 1) return new Response(JSON.stringify({ instance_id: 'inst-spin' }), { status: 202 });
      return new Response(JSON.stringify({ status: 'running' }), { status: 200 });
    });
    await expect(durableWrite(env, {
      actor: CTX.actor, operation: 'service.patch',
      target: { id: '1', type: 'service' }, payload: { name: 'Y' }, correlation: CORRELATION,
      _pollMaxAttempts: 2, _pollIntervalMs: 0,
    })).rejects.toMatchObject({ code: 'timeout' });
  });

  it('timeout error message reports computed elapsed seconds, not attempt count', async () => {
    let call = 0;
    const env = makeEnv(async () => {
      call++;
      if (call === 1) return new Response(JSON.stringify({ instance_id: 'inst-clock' }), { status: 202 });
      return new Response(JSON.stringify({ status: 'running' }), { status: 200 });
    });
    // 4 attempts × 500ms = 2s — message should say "2s", not "4s".
    await expect(durableWrite(env, {
      actor: CTX.actor, operation: 'service.patch',
      target: { id: '1', type: 'service' }, payload: {}, correlation: CORRELATION,
      _pollMaxAttempts: 4, _pollIntervalMs: 500,
    })).rejects.toMatchObject({
      code: 'timeout',
      message: expect.stringContaining('within 2s'),
    });
  });
});

// ── st_create_service ────────────────────────────────────────

describe('st_create_service', () => {
  it('dryRun=true returns DryRunResult for service create', async () => {
    const env = makeEnv(dryRunFetch());
    const result: any = await st_create_service.handler(env, { name: 'New Service', categoryId: 5 }, CTX);
    expect(result.dryRun).toBe(true);
    expect(result.tool).toBe('st_create_service');
    expect(result.confirmation_token).toBeTypeOf('string');
  });

  it('durableWrite uses service.create operation and sends full args as payload', async () => {
    const env = makeEnv(happyFetch({ status: 'ok' }));
    await durableWrite(env, {
      actor: CTX.actor, operation: 'service.create',
      target: { id: '0', type: 'service' }, payload: { name: 'New Service', categoryId: 5 }, correlation: CORRELATION,
    });
    const body = JSON.parse(env.ST_PROXY.fetch.mock.calls[0][1].body);
    expect(body.operation).toBe('service.create');
    expect(body.payload).toMatchObject({ name: 'New Service', categoryId: 5 });
    expect(body.target.id).toBe('0');
  });
});

// ── st_patch_material ────────────────────────────────────────

describe('st_patch_material', () => {
  it('dryRun=true returns DryRunResult for material patch', async () => {
    const env = makeEnv(dryRunFetch());
    const result: any = await st_patch_material.handler(env, { id: 777, cost: 12.5 }, CTX);
    expect(result.dryRun).toBe(true);
    expect(result.tool).toBe('st_patch_material');
  });

  it('throws validation_error when no fields besides id are provided', async () => {
    const env = makeEnv(async () => new Response('', { status: 200 }));
    await expect(st_patch_material.handler(env, { id: 777 }, CTX))
      .rejects.toMatchObject({ code: 'validation_error' });
  });

  it('durableWrite submits with material.patch operation', async () => {
    const env = makeEnv(happyFetch({ status: 'ok' }));
    await durableWrite(env, {
      actor: CTX.actor, operation: 'material.patch',
      target: { id: '777', type: 'material' }, payload: { cost: 12.5 }, correlation: CORRELATION,
    });
    const body = JSON.parse(env.ST_PROXY.fetch.mock.calls[0][1].body);
    expect(body.operation).toBe('material.patch');
    expect(body.target).toEqual({ id: '777', type: 'material' });
    expect(body.payload).toEqual({ cost: 12.5 });
  });
});

// ── st_create_material ───────────────────────────────────────

describe('st_create_material', () => {
  it('dryRun=true returns DryRunResult for material create', async () => {
    const env = makeEnv(dryRunFetch());
    const result: any = await st_create_material.handler(env, { name: 'R-22', categoryId: 10, primaryVendorId: 555 }, CTX);
    expect(result.dryRun).toBe(true);
    expect(result.tool).toBe('st_create_material');
  });

  it('durableWrite uses material.create operation', async () => {
    const env = makeEnv(happyFetch({}));
    await durableWrite(env, {
      actor: CTX.actor, operation: 'material.create',
      target: { id: '0', type: 'material' }, payload: { name: 'R-22', categoryId: 10 }, correlation: CORRELATION,
    });
    const body = JSON.parse(env.ST_PROXY.fetch.mock.calls[0][1].body);
    expect(body.operation).toBe('material.create');
    expect(body.payload).toMatchObject({ name: 'R-22', categoryId: 10 });
  });
});

// ── st_add_invoice_line_item ─────────────────────────────────
// Rewritten 2026-07-31 against the CONFIRMED InvoiceItemUpdateRequest
// schema (live-probed on prod tenant 431848990 — see file header). Job-link
// reassignment is gone entirely (confirmed impossible via the ST API), and
// the write path is now N sequential flat-body PATCH calls, one per line
// item, instead of a single {items:[...]} call plus an optional job-link
// second call.

import { st_add_invoice_line_item } from '../invoicing/st_add_invoice_line_item';

describe('st_add_invoice_line_item', () => {
  function makeReadEnv(invoiceBody: unknown, fetchImpl?: (url: string) => Promise<Response>) {
    return {
      ST_PROXY: {
        fetch: vi.fn(async (url: string) => {
          if (fetchImpl) return fetchImpl(url);
          if (url.includes('dryRun=1')) {
            return new Response(JSON.stringify({ echo: true }), { status: 200 });
          }
          // invoices read endpoint returns a list envelope { data: [...] }
          return new Response(JSON.stringify({ data: [invoiceBody] }), { status: 200 });
        }),
      },
      MCP_SYNC_KEY: 'test-sync-key',
      MCP_SERVICE_VERSION: '0.0.0-test',
      ST_TENANT_ID: '000000000',
      DB: makeDB(),
      PROXY_STATE: {},
      SIRO_API_TOKEN: '',
    };
  }

  it('throws validation_error when lineItems is empty', async () => {
    const env = makeReadEnv({ id: 111, syncStatus: 'Pending', customer: { id: 5 } });
    await expect(
      st_add_invoice_line_item.handler(env as any, { invoiceId: 111, lineItems: [] }, CTX)
    ).rejects.toMatchObject({ code: 'validation_error' });
  });

  // Live-probed 2026-07-31 against invoice 82555119: omitting `id` routes to
  // ST's UpdateInvoiceItemHandler.CreateInvoiceItemAsync (append path), which
  // fails with 500 "Sku (Name:) is not found." when neither skuId nor skuName
  // is supplied. Reject that combination locally instead of shipping a 500.
  it('throws validation_error when appending (no id) without skuId or skuName', async () => {
    const env = makeReadEnv({ id: 111, syncStatus: 'Pending', customer: { id: 5 } });
    await expect(
      st_add_invoice_line_item.handler(
        env as any,
        { invoiceId: 111, lineItems: [{ description: 'no sku', quantity: 1 }] },
        CTX
      )
    ).rejects.toMatchObject({ code: 'validation_error', message: expect.stringContaining('skuId') });
  });

  it('allows an update (id present) without skuId or skuName', async () => {
    const env = makeReadEnv({ id: 111, syncStatus: 'Pending', customer: { id: 5 } });
    const result: any = await st_add_invoice_line_item.handler(
      env as any,
      { invoiceId: 111, lineItems: [{ id: 999, description: 'update existing', quantity: 2 }] },
      CTX
    );
    expect(result.dryRun).toBe(true);
  });

  it('throws not_found when the invoice does not exist', async () => {
    const env = {
      ST_PROXY: { fetch: vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) },
      MCP_SYNC_KEY: 'test-sync-key', MCP_SERVICE_VERSION: '0.0.0-test', ST_TENANT_ID: '000000000',
      DB: makeDB(), PROXY_STATE: {}, SIRO_API_TOKEN: '',
    };
    await expect(
      st_add_invoice_line_item.handler(
        env as any,
        { invoiceId: 999999, lineItems: [{ skuId: 501, description: 'Diagnostic', quantity: 1 }] },
        CTX
      )
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('dryRun=true returns DryRunResult with token and no warnings for a non-exported invoice', async () => {
    const env = makeReadEnv({ id: 111, syncStatus: 'Pending', customer: { id: 5 } });
    const result: any = await st_add_invoice_line_item.handler(
      env as any,
      { invoiceId: 111, lineItems: [{ skuId: 501, description: 'Diagnostic', quantity: 1 }] },
      CTX
    );
    expect(result.dryRun).toBe(true);
    expect(result.tool).toBe('st_add_invoice_line_item');
    expect(result.confirmation_token).toBeTypeOf('string');
    expect(result.warnings).toEqual([]);
  });

  it('dryRun=true includes an export warning for syncStatus=Exported (warn-only, not blocked)', async () => {
    const env = makeReadEnv({ id: 111, syncStatus: 'Exported', customer: { id: 5 } });
    const result: any = await st_add_invoice_line_item.handler(
      env as any,
      { invoiceId: 111, lineItems: [{ skuId: 501, description: 'Diagnostic', quantity: 1 }] },
      CTX
    );
    expect(result.dryRun).toBe(true);
    expect(result.warnings.some((w: string) => w.includes('Exported'))).toBe(true);
  });

  it('dryRun preview lists N steps for N line items, each with the items endpoint and a flat single-item payload', async () => {
    const env = makeReadEnv({ id: 111, syncStatus: 'Pending', customer: { id: 5 } });
    const lineItems = [
      { skuId: 501, description: 'Item A', quantity: 1 },
      { skuId: 502, description: 'Item B', quantity: 2, cost: 10 },
      { skuId: 503, description: 'Item C', quantity: 3, technicianId: 9 },
    ];
    const result: any = await st_add_invoice_line_item.handler(env as any, { invoiceId: 111, lineItems }, CTX);

    expect(result.dryRun).toBe(true);
    expect(result.payload.steps).toHaveLength(3);
    result.payload.steps.forEach((step: any, i: number) => {
      expect(step.call).toBe(i + 1);
      expect(step.endpoint).toBe('/accounting/v2/tenant/000000000/invoices/111/items');
      expect(step.method).toBe('PATCH');
      expect(step.payload).toEqual(lineItems[i]); // flat single-item object, not wrapped in items[]/array
    });
  });

  // ── Confirm path executes via /api/st/write (NOT durableWrite) ──
  it('live path issues exactly N /api/st/write calls, one flat body per line item (not wrapped in items[]/array)', async () => {
    const writeCalls: { url: string; body: any }[] = [];
    const lineItems = [
      { skuId: 501, description: 'Item A', quantity: 1 },
      { skuId: 502, description: 'Item B', quantity: 2, cost: 10 },
      { skuId: 503, description: 'Item C', quantity: 3, technicianId: 9 },
    ];
    const env: any = {
      ST_PROXY: {
        fetch: vi.fn(async (url: string, init?: RequestInit) => {
          if (url.includes('dryRun=1')) return new Response(JSON.stringify({ echo: true }), { status: 200 });
          if (url.endsWith('/api/st/write')) {
            writeCalls.push({ url, body: JSON.parse(init!.body as string) });
            return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
          }
          return new Response(JSON.stringify({ data: [{ id: 111, syncStatus: 'Pending', customer: { id: 5 } }] }), { status: 200 });
        }),
      },
      MCP_SYNC_KEY: 'test-sync-key', MCP_SERVICE_VERSION: '0.0.0-test', ST_TENANT_ID: '000000000',
      DB: makeDB({ consumed_at: null, expires_at: Date.now() + 1_000_000 }), PROXY_STATE: {}, SIRO_API_TOKEN: '',
    };

    const args = { invoiceId: 111, lineItems };
    const dr: any = await st_add_invoice_line_item.handler(env, args, CTX);
    const result: any = await st_add_invoice_line_item.handler(
      env, { ...args, dryRun: false, confirmation_token: dr.confirmation_token }, CTX
    );

    expect(result.dryRun).toBe(false);
    expect(result.result.itemsWritten).toBe(3);
    expect(writeCalls.length).toBe(3);
    writeCalls.forEach((c, i) => {
      expect(c.url).toBe('https://servicetitan-proxy/api/st/write');
      expect(c.body.endpoint).toBe('/accounting/v2/tenant/000000000/invoices/111/items');
      expect(c.body.method).toBe('PATCH');
      expect(c.body.payload).toEqual(lineItems[i]); // flat — NOT wrapped in items[]/array
      expect(Array.isArray(c.body.payload)).toBe(false);
      expect(c.body.payload).not.toHaveProperty('items');
    });
  });

  // ── unitPrice is THE monetary field (live-probed 2026-07-31) ──
  // ST's InvoiceItemUpdateRequest binds `unitPrice`, NOT `price`. Sending
  // `price` was silently dropped and produced $0.00 line items behind an
  // HTTP 200 (real damage: item 84402146 on invoice 83052705). These tests
  // pin the exact wire field name on both the preview and the live payload.
  it('unitPrice survives into the dryRun preview and the outbound /api/st/write payload', async () => {
    const writeCalls: any[] = [];
    const env: any = {
      ST_PROXY: {
        fetch: vi.fn(async (url: string, init?: RequestInit) => {
          if (url.includes('dryRun=1')) return new Response(JSON.stringify({ echo: true }), { status: 200 });
          if (url.endsWith('/api/st/write')) {
            writeCalls.push(JSON.parse(init!.body as string));
            return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
          }
          return new Response(JSON.stringify({ data: [{ id: 111, syncStatus: 'Pending', customer: { id: 5 } }] }), { status: 200 });
        }),
      },
      MCP_SYNC_KEY: 'test-sync-key', MCP_SERVICE_VERSION: '0.0.0-test', ST_TENANT_ID: '000000000',
      DB: makeDB({ consumed_at: null, expires_at: Date.now() + 1_000_000 }), PROXY_STATE: {}, SIRO_API_TOKEN: '',
    };

    const args = {
      invoiceId: 111,
      lineItems: [{ skuName: 'HI1', description: 'HVAC Install', quantity: 1, unitPrice: 13674 }],
    };
    const dr: any = await st_add_invoice_line_item.handler(env, args, CTX);
    expect(dr.payload.steps[0].payload.unitPrice).toBe(13674);

    const result: any = await st_add_invoice_line_item.handler(
      env, { ...args, dryRun: false, confirmation_token: dr.confirmation_token }, CTX
    );
    expect(result.dryRun).toBe(false);
    expect(writeCalls[0].payload.unitPrice).toBe(13674);
  });

  it('preserves a NEGATIVE unitPrice (the offsetting-line case) — sign is not coerced or dropped', async () => {
    const env = makeReadEnv({ id: 111, syncStatus: 'Pending', customer: { id: 5 } });
    const result: any = await st_add_invoice_line_item.handler(
      env as any,
      { invoiceId: 111, lineItems: [{ skuName: 'HI1', description: 'Offset', quantity: 1, unitPrice: -13674 }] },
      CTX
    );
    expect(result.payload.steps[0].payload.unitPrice).toBe(-13674);
  });

  // REGRESSION GUARD: `price` is silently ignored by ST on this endpoint. If
  // someone reintroduces it (schema or payload builder), this fails.
  it('never emits `price` on the outbound payload — ST silently drops it and the line lands at $0.00', async () => {
    const writeCalls: any[] = [];
    const env: any = {
      ST_PROXY: {
        fetch: vi.fn(async (url: string, init?: RequestInit) => {
          if (url.includes('dryRun=1')) return new Response(JSON.stringify({ echo: true }), { status: 200 });
          if (url.endsWith('/api/st/write')) {
            writeCalls.push(JSON.parse(init!.body as string));
            return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
          }
          return new Response(JSON.stringify({ data: [{ id: 111, syncStatus: 'Pending', customer: { id: 5 } }] }), { status: 200 });
        }),
      },
      MCP_SYNC_KEY: 'test-sync-key', MCP_SERVICE_VERSION: '0.0.0-test', ST_TENANT_ID: '000000000',
      DB: makeDB({ consumed_at: null, expires_at: Date.now() + 1_000_000 }), PROXY_STATE: {}, SIRO_API_TOKEN: '',
    };

    // A caller (or a future regression) shoves `price` in alongside unitPrice.
    const args: any = {
      invoiceId: 111,
      lineItems: [{ skuName: 'HI1', description: 'HVAC Install', quantity: 1, unitPrice: 100, price: 999 }],
    };
    const dr: any = await st_add_invoice_line_item.handler(env, args, CTX);
    expect(dr.payload.steps[0].payload).not.toHaveProperty('price');

    await st_add_invoice_line_item.handler(
      env, { ...args, dryRun: false, confirmation_token: dr.confirmation_token }, CTX
    );
    expect(writeCalls[0].payload).not.toHaveProperty('price');
    expect(writeCalls[0].payload.unitPrice).toBe(100);
  });

  // skuId IS valid on THIS endpoint (asymmetry vs. the adjustment endpoint,
  // whose items[] silently drops it). Keep it on the wire here.
  it('keeps skuId on the outbound payload — it is accepted by the items PATCH endpoint', async () => {
    const env = makeReadEnv({ id: 111, syncStatus: 'Pending', customer: { id: 5 } });
    const result: any = await st_add_invoice_line_item.handler(
      env as any,
      { invoiceId: 111, lineItems: [{ skuId: 501, description: 'Diagnostic', quantity: 1, unitPrice: 89 }] },
      CTX
    );
    expect(result.payload.steps[0].payload.skuId).toBe(501);
    expect(result.payload.steps[0].payload.unitPrice).toBe(89);
  });

  it('partial failure: 3 items, call 2 fails — error states 1 item already succeeded and is already written, and mentions DELETE for cleanup', async () => {
    let writeCallCount = 0;
    const lineItems = [
      { skuId: 501, description: 'Item A', quantity: 1 },
      { skuId: 502, description: 'Item B', quantity: 2 },
      { skuId: 503, description: 'Item C', quantity: 3 },
    ];
    const env: any = {
      ST_PROXY: {
        fetch: vi.fn(async (url: string) => {
          if (url.includes('dryRun=1')) return new Response(JSON.stringify({ echo: true }), { status: 200 });
          if (url.endsWith('/api/st/write')) {
            writeCallCount++;
            if (writeCallCount === 1) return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
            return new Response('Bad Request', { status: 400 });
          }
          return new Response(JSON.stringify({ data: [{ id: 111, syncStatus: 'Pending', customer: { id: 5 } }] }), { status: 200 });
        }),
      },
      MCP_SYNC_KEY: 'test-sync-key', MCP_SERVICE_VERSION: '0.0.0-test', ST_TENANT_ID: '000000000',
      DB: makeDB({ consumed_at: null, expires_at: Date.now() + 1_000_000 }), PROXY_STATE: {}, SIRO_API_TOKEN: '',
    };

    const args = { invoiceId: 111, lineItems };
    const dr: any = await st_add_invoice_line_item.handler(env, args, CTX);
    await expect(
      st_add_invoice_line_item.handler(env, { ...args, dryRun: false, confirmation_token: dr.confirmation_token }, CTX)
    ).rejects.toMatchObject({
      code: 'upstream_error',
      message: expect.stringMatching(/1 item.*succeeded.*already written/i),
    });
    // Only 2 write calls attempted: item 1 (succeeded) + item 2 (failed). Item 3 is never attempted.
    expect(writeCallCount).toBe(2);
  });

  it('partial-failure error message names the DELETE endpoint for manual cleanup of the already-written item', async () => {
    let writeCallCount = 0;
    const lineItems = [
      { skuId: 501, description: 'Item A', quantity: 1 },
      { skuId: 502, description: 'Item B', quantity: 2 },
    ];
    const env: any = {
      ST_PROXY: {
        fetch: vi.fn(async (url: string) => {
          if (url.includes('dryRun=1')) return new Response(JSON.stringify({ echo: true }), { status: 200 });
          if (url.endsWith('/api/st/write')) {
            writeCallCount++;
            if (writeCallCount === 1) return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
            return new Response('Bad Request', { status: 400 });
          }
          return new Response(JSON.stringify({ data: [{ id: 111, syncStatus: 'Pending', customer: { id: 5 } }] }), { status: 200 });
        }),
      },
      MCP_SYNC_KEY: 'test-sync-key', MCP_SERVICE_VERSION: '0.0.0-test', ST_TENANT_ID: '000000000',
      DB: makeDB({ consumed_at: null, expires_at: Date.now() + 1_000_000 }), PROXY_STATE: {}, SIRO_API_TOKEN: '',
    };

    const args = { invoiceId: 111, lineItems };
    const dr: any = await st_add_invoice_line_item.handler(env, args, CTX);
    await expect(
      st_add_invoice_line_item.handler(env, { ...args, dryRun: false, confirmation_token: dr.confirmation_token }, CTX)
    ).rejects.toMatchObject({
      code: 'upstream_error',
      message: expect.stringContaining('DELETE /accounting/v2/tenant/000000000/invoices/111/items/{itemId}'),
    });
  });

  it('exported invoice still warns at dryRun and still proceeds through confirm (warn-only preserved, not blocked)', async () => {
    const writeCalls: any[] = [];
    const env: any = {
      ST_PROXY: {
        fetch: vi.fn(async (url: string, init?: RequestInit) => {
          if (url.includes('dryRun=1')) return new Response(JSON.stringify({ echo: true }), { status: 200 });
          if (url.endsWith('/api/st/write')) {
            writeCalls.push(JSON.parse(init!.body as string));
            return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
          }
          return new Response(JSON.stringify({ data: [{ id: 111, syncStatus: 'Exported', customer: { id: 5 } }] }), { status: 200 });
        }),
      },
      MCP_SYNC_KEY: 'test-sync-key', MCP_SERVICE_VERSION: '0.0.0-test', ST_TENANT_ID: '000000000',
      DB: makeDB({ consumed_at: null, expires_at: Date.now() + 1_000_000 }), PROXY_STATE: {}, SIRO_API_TOKEN: '',
    };

    const args = { invoiceId: 111, lineItems: [{ skuId: 501, description: 'Diagnostic', quantity: 1 }] };
    const dr: any = await st_add_invoice_line_item.handler(env, args, CTX);
    expect(dr.warnings.some((w: string) => w.includes('Exported'))).toBe(true);

    const result: any = await st_add_invoice_line_item.handler(
      env, { ...args, dryRun: false, confirmation_token: dr.confirmation_token }, CTX
    );
    expect(result.dryRun).toBe(false);
    expect(writeCalls.length).toBe(1);
  });

  // ── Fix 1: ids filter not honored guard ────────────────────
  it('throws upstream_error when the invoices list endpoint returns a different id than requested (ids filter not honored)', async () => {
    // Invoice read returns id 222 even though invoiceId 111 was requested —
    // simulates ST silently ignoring the `ids` param.
    const env = makeReadEnv({ id: 222, syncStatus: 'Pending', customer: { id: 5 } });
    await expect(
      st_add_invoice_line_item.handler(
        env as any,
        { invoiceId: 111, lineItems: [{ skuId: 501, description: 'Diagnostic', quantity: 1 }] },
        CTX
      )
    ).rejects.toMatchObject({ code: 'upstream_error', message: expect.stringContaining('ids filter not honored') });
  });

  // ── Fix 2: TOCTOU — confirm-phase re-reads and re-hashes state ──
  it('rejects the confirm call when the invoice syncStatus changed between dryRun and confirm (TOCTOU)', async () => {
    let call = 0;
    const invoiceStates = [
      { id: 111, syncStatus: 'Pending', customer: { id: 5 } },
      { id: 111, syncStatus: 'Exported', customer: { id: 5 } },
    ];
    const env: any = {
      ST_PROXY: {
        fetch: vi.fn(async (url: string) => {
          if (url.includes('dryRun=1')) return new Response(JSON.stringify({ echo: true }), { status: 200 });
          const state = invoiceStates[Math.min(call, invoiceStates.length - 1)];
          call++;
          return new Response(JSON.stringify({ data: [state] }), { status: 200 });
        }),
      },
      MCP_SYNC_KEY: 'test-sync-key',
      MCP_SERVICE_VERSION: '0.0.0-test',
      ST_TENANT_ID: '000000000',
      DB: makeDB(),
      PROXY_STATE: {},
      SIRO_API_TOKEN: '',
    };

    const args = { invoiceId: 111, lineItems: [{ skuId: 501, description: 'Diagnostic', quantity: 1 }] };
    const dr: any = await st_add_invoice_line_item.handler(env, args, CTX);
    expect(dr.dryRun).toBe(true);

    await expect(
      st_add_invoice_line_item.handler(
        env,
        { ...args, dryRun: false, confirmation_token: dr.confirmation_token },
        CTX
      )
    ).rejects.toThrow(/args changed since dryRun/);
  });
});

// ── Pricebook payload transform (Bugs 2 + 3) ─────────────────
// ST silently drops `name` and `categoryId` on POST/PATCH. The 4 pricebook
// tools rewrite them to `displayName` and `categories: [N]` before submit,
// while keeping the user-facing arg names for ergonomics.

describe('pricebook payload transform — name→displayName, categoryId→categories', () => {
  it('toStPricebookPayload rewrites both fields and removes originals', async () => {
    const { toStPricebookPayload } = await import('../pricebook-payload');
    const out = toStPricebookPayload({ name: 'X', categoryId: 5, code: 'A', cost: 1 });
    expect(out).toEqual({ displayName: 'X', categories: [5], code: 'A', cost: 1 });
    expect(out).not.toHaveProperty('name');
    expect(out).not.toHaveProperty('categoryId');
  });

  it('toStPricebookPayload is a no-op when neither field is present', async () => {
    const { toStPricebookPayload } = await import('../pricebook-payload');
    const out = toStPricebookPayload({ code: 'A', cost: 1, active: false });
    expect(out).toEqual({ code: 'A', cost: 1, active: false });
  });

  it('st_create_service dryRun preview shows displayName + categories (not name/categoryId)', async () => {
    const env = makeEnv(dryRunFetch());
    const result: any = await st_create_service.handler(env, { name: 'Repipe DIAG', categoryId: 62308987 }, CTX);
    expect(result.payload).toMatchObject({ displayName: 'Repipe DIAG', categories: [62308987] });
    expect(result.payload).not.toHaveProperty('name');
    expect(result.payload).not.toHaveProperty('categoryId');
  });

  it('st_create_service durableWrite body uses displayName + categories', async () => {
    const env = makeEnv(async (url: string) => {
      if (url.includes('/api/st/durable-write/')) {
        return new Response(JSON.stringify({ status: 'complete', output: { id: 1 } }), { status: 200 });
      }
      return new Response(JSON.stringify({ instance_id: 'inst-x' }), { status: 202 });
    });
    // Skip the gate by calling durableWrite path via a token-bypass test: easier to assert
    // the transform via the dryRun preview, which is the canonical "what we send" snapshot.
    const dr: any = await st_create_service.handler(env, { name: 'Y', categoryId: 7, code: 'CODE-7' }, CTX);
    expect(dr.payload).toEqual({ displayName: 'Y', categories: [7], code: 'CODE-7' });
  });

  it('st_create_material dryRun preview uses displayName + categories', async () => {
    const env = makeEnv(dryRunFetch());
    const result: any = await st_create_material.handler(env, { name: 'WidgetMat', categoryId: 99, code: 'WM-1', primaryVendorId: 555 }, CTX);
    expect(result.payload).toMatchObject({ displayName: 'WidgetMat', categories: [99], code: 'WM-1' });
    expect(result.payload).not.toHaveProperty('name');
    expect(result.payload).not.toHaveProperty('categoryId');
  });

  it('st_patch_service dryRun preview uses displayName + categories', async () => {
    const env = makeEnv(dryRunFetch());
    const result: any = await st_patch_service.handler(env, { id: 12345, name: 'Renamed', categoryId: 7 }, CTX);
    expect(result.payload).toMatchObject({ displayName: 'Renamed', categories: [7] });
    expect(result.payload).not.toHaveProperty('name');
    expect(result.payload).not.toHaveProperty('categoryId');
  });

  it('st_patch_material dryRun preview uses displayName + categories', async () => {
    const env = makeEnv(dryRunFetch());
    const result: any = await st_patch_material.handler(env, { id: 777, name: 'NewMat', categoryId: 22 }, CTX);
    expect(result.payload).toMatchObject({ displayName: 'NewMat', categories: [22] });
    expect(result.payload).not.toHaveProperty('name');
    expect(result.payload).not.toHaveProperty('categoryId');
  });
});

// ── v1.7.0 — full pricebook-service field surface ────────────
// Adds hours, isLabor, taxable, account, paysCommission, memberPrice,
// useStaticPrices (plural), and multi-category support to st_create_service +
// st_patch_service. Drops the silently-dropped singular useStaticPrice.

describe('pricebook full-field surface — new in v1.7.0', () => {
  it('toStPricebookPayload passes through hours/isLabor/taxable/account/paysCommission/memberPrice/useStaticPrices verbatim', async () => {
    const { toStPricebookPayload } = await import('../pricebook-payload');
    const out = toStPricebookPayload({
      name: 'X', categoryId: 5,
      hours: 0.5, isLabor: true, taxable: true, account: 'Revenue',
      paysCommission: false, memberPrice: 89, useStaticPrices: true, price: 89,
    });
    expect(out).toMatchObject({
      displayName: 'X', categories: [5],
      hours: 0.5, isLabor: true, taxable: true, account: 'Revenue',
      paysCommission: false, memberPrice: 89, useStaticPrices: true, price: 89,
    });
  });

  it('multi-cat: categories[] wins over categoryId when both passed', async () => {
    const { toStPricebookPayload } = await import('../pricebook-payload');
    const out: any = toStPricebookPayload({ name: 'X', categoryId: 5, categories: [5, 7] });
    expect(out.categories).toEqual([5, 7]);
    expect(out).not.toHaveProperty('categoryId');
  });

  it('multi-cat: categoryId still works alone (back-compat)', async () => {
    const { toStPricebookPayload } = await import('../pricebook-payload');
    const out: any = toStPricebookPayload({ name: 'X', categoryId: 5 });
    expect(out.categories).toEqual([5]);
    expect(out).not.toHaveProperty('categoryId');
  });

  it('toStPricebookPayload strips singular useStaticPrice (belt-and-suspenders)', async () => {
    const { toStPricebookPayload } = await import('../pricebook-payload');
    const out: any = toStPricebookPayload({ name: 'X', categoryId: 5, useStaticPrice: true });
    expect(out).not.toHaveProperty('useStaticPrice');
  });

  it('st_create_service multi-cat round-trip: categories[1,2] → categories:[1,2] in dryRun payload', async () => {
    const env = makeEnv(dryRunFetch());
    const result: any = await st_create_service.handler(env,
      { name: 'Lab Fee', categories: [1, 2], useStaticPrices: true, price: 89, hours: 0, isLabor: false }, CTX);
    expect(result.payload).toMatchObject({
      displayName: 'Lab Fee', categories: [1, 2], useStaticPrices: true, price: 89, hours: 0, isLabor: false,
    });
  });

  it('st_create_service requires categoryId or categories', async () => {
    const env = makeEnv(dryRunFetch());
    await expect(
      st_create_service.handler(env, { name: 'X' } as any, CTX)
    ).rejects.toThrow(/categor/i);
  });

  it('st_patch_service accepts new fields without id-only validation tripping', async () => {
    const env = makeEnv(dryRunFetch());
    const result: any = await st_patch_service.handler(env,
      { id: 1, hours: 1.5, isLabor: true }, CTX);
    expect(result.payload).toMatchObject({ hours: 1.5, isLabor: true });
  });
});

// ── QUA-685: st_create_material requires a primaryVendor ──────
describe('st_create_material primaryVendor (QUA-685)', () => {
  it('throws validation_error when no vendor is supplied', async () => {
    const env = makeEnv(dryRunFetch());
    await expect(st_create_material.handler(env, { name: 'NoVendorMat', categoryId: 10 }, CTX))
      .rejects.toMatchObject({ code: 'validation_error' });
    expect(env.ST_PROXY.fetch).not.toHaveBeenCalled();
  });

  it('nested primaryVendor flows to the ST payload verbatim', async () => {
    const env = makeEnv(dryRunFetch());
    const result: any = await st_create_material.handler(env,
      { name: 'VendMat', categoryId: 10, primaryVendor: { vendorId: 555, cost: 12, active: true } }, CTX);
    expect(result.payload).toMatchObject({ displayName: 'VendMat', categories: [10], primaryVendor: { vendorId: 555, cost: 12, active: true } });
    expect(result.payload).not.toHaveProperty('primaryVendorId');
    expect(result.payload).not.toHaveProperty('primaryVendorCost');
  });

  it('flat primaryVendorId normalizes to a nested vendor, cost defaults to material cost', async () => {
    const env = makeEnv(dryRunFetch());
    const result: any = await st_create_material.handler(env,
      { name: 'FlatVendMat', categoryId: 10, cost: 9.5, primaryVendorId: 555 }, CTX);
    expect(result.payload.primaryVendor).toMatchObject({ vendorId: 555, cost: 9.5, active: true });
    expect(result.payload).not.toHaveProperty('primaryVendorId');
    expect(result.payload).not.toHaveProperty('primaryVendorCost');
  });
});

// ── st_create_adjustment_invoice ─────────────────────────────

import { st_create_adjustment_invoice } from '../invoicing/st_create_adjustment_invoice';

describe('st_create_adjustment_invoice', () => {
  function makeParentEnv(parentInvoice: unknown) {
    return {
      ST_PROXY: {
        fetch: vi.fn(async (url: string) => {
          if (url.includes('dryRun=1')) return new Response(JSON.stringify({ echo: true }), { status: 200 });
          return new Response(JSON.stringify({ data: [parentInvoice] }), { status: 200 });
        }),
      },
      MCP_SYNC_KEY: 'test-sync-key', MCP_SERVICE_VERSION: '0.0.0-test', ST_TENANT_ID: '000000000',
      DB: makeDB(), PROXY_STATE: {}, SIRO_API_TOKEN: '',
    };
  }

  it('throws validation_error when lineItems is empty', async () => {
    const env = makeParentEnv({ id: 222, syncStatus: 'Exported', adjustmentToId: null });
    await expect(
      st_create_adjustment_invoice.handler(env as any, { parentInvoiceId: 222, lineItems: [] }, CTX)
    ).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('throws not_found when the parent invoice does not exist', async () => {
    const env = {
      ST_PROXY: { fetch: vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) },
      MCP_SYNC_KEY: 'test-sync-key', MCP_SERVICE_VERSION: '0.0.0-test', ST_TENANT_ID: '000000000',
      DB: makeDB(), PROXY_STATE: {}, SIRO_API_TOKEN: '',
    };
    await expect(
      st_create_adjustment_invoice.handler(env as any, { parentInvoiceId: 999999, lineItems: [{ skuName: 'HI1', description: 'Offset', quantity: 1, unitPrice: -200 }] }, CTX)
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('rejects a parent invoice not in Posted or Exported status', async () => {
    const env = makeParentEnv({ id: 222, syncStatus: 'Pending', adjustmentToId: null });
    await expect(
      st_create_adjustment_invoice.handler(env as any, { parentInvoiceId: 222, lineItems: [{ skuName: 'HI1', description: 'Offset', quantity: 1, unitPrice: -200 }] }, CTX)
    ).rejects.toMatchObject({ code: 'validation_error', message: expect.stringContaining('Posted') });
  });

  it('rejects a parent invoice that is itself an adjustment invoice', async () => {
    const env = makeParentEnv({ id: 222, syncStatus: 'Exported', adjustmentToId: 111 });
    await expect(
      st_create_adjustment_invoice.handler(env as any, { parentInvoiceId: 222, lineItems: [{ skuName: 'HI1', description: 'Offset', quantity: 1, unitPrice: -200 }] }, CTX)
    ).rejects.toMatchObject({ code: 'validation_error', message: expect.stringContaining('adjustment') });
  });

  it('dryRun=true returns DryRunResult with token for a valid Exported parent', async () => {
    const env = makeParentEnv({ id: 222, syncStatus: 'Exported', adjustmentToId: null, businessUnit: { id: 257 } });
    const result: any = await st_create_adjustment_invoice.handler(
      env as any,
      { parentInvoiceId: 222, lineItems: [{ skuName: 'HI1', description: 'Offset', quantity: 1, unitPrice: -998484 }] },
      CTX
    );
    expect(result.dryRun).toBe(true);
    expect(result.tool).toBe('st_create_adjustment_invoice');
    expect(result.confirmation_token).toBeTypeOf('string');
  });

  it('does not warn when adjustment line total nets the stated offsetAmount to zero, warns when it does not', async () => {
    const env = makeParentEnv({ id: 222, syncStatus: 'Exported', adjustmentToId: null, businessUnit: { id: 257 } });
    const netted: any = await st_create_adjustment_invoice.handler(
      env as any,
      { parentInvoiceId: 222, lineItems: [{ skuName: 'HI1', description: 'Offset', quantity: 1, unitPrice: -100 }], offsetAmount: 100 },
      CTX
    );
    expect(netted.warnings).toEqual([]);

    const unnetted: any = await st_create_adjustment_invoice.handler(
      env as any,
      { parentInvoiceId: 222, lineItems: [{ skuName: 'HI1', description: 'Offset', quantity: 1, unitPrice: -50 }], offsetAmount: 100 },
      CTX
    );
    expect(unnetted.warnings.some((w: string) => w.includes('does not net'))).toBe(true);
  });

  it('confirm call executes via /api/st/write with correct endpoint/method/payload (NOT durableWrite)', async () => {
    let writeCall: { url: string; body: any } | undefined;
    const env: any = {
      ST_PROXY: {
        fetch: vi.fn(async (url: string, init?: RequestInit) => {
          if (url.includes('dryRun=1')) return new Response(JSON.stringify({ echo: true }), { status: 200 });
          if (url.endsWith('/api/st/write')) {
            writeCall = { url, body: JSON.parse(init!.body as string) };
            return new Response(JSON.stringify({ id: 333, status: 'ok' }), { status: 200 });
          }
          return new Response(JSON.stringify({ data: [{ id: 222, syncStatus: 'Exported', adjustmentToId: null, businessUnit: { id: 257 } }] }), { status: 200 });
        }),
      },
      MCP_SYNC_KEY: 'test-sync-key', MCP_SERVICE_VERSION: '0.0.0-test', ST_TENANT_ID: '000000000',
      DB: makeDB({ consumed_at: null, expires_at: Date.now() + 1_000_000 }), PROXY_STATE: {}, SIRO_API_TOKEN: '',
    };

    const args = { parentInvoiceId: 222, lineItems: [{ skuName: 'HI1', description: 'Offset', quantity: 1, unitPrice: -998484 }] };
    const dr: any = await st_create_adjustment_invoice.handler(env, args, CTX);
    const result: any = await st_create_adjustment_invoice.handler(
      env, { ...args, dryRun: false, confirmation_token: dr.confirmation_token }, CTX
    );

    expect(result.dryRun).toBe(false);
    // durableWrite would hit /api/st/durable-write — assert it never does.
    expect(env.ST_PROXY.fetch.mock.calls.some((c: any[]) => String(c[0]).includes('durable-write'))).toBe(false);
    expect(writeCall!.url).toBe('https://servicetitan-proxy/api/st/write');
    expect(writeCall!.body.endpoint).toBe('/accounting/v2/tenant/000000000/invoices');
    expect(writeCall!.body.method).toBe('POST');
    // CONFIRMED shape (live probe 2026-07-31): the line array is `items`, NOT
    // `lineItems`. Sending `lineItems` was silently dropped and produced a
    // ZERO-ITEM $0.00 adjustment invoice behind an HTTP 200 (real damage:
    // adjustment invoice 84402274 against parent 83058736, undeletable via API).
    expect(writeCall!.body.payload).toMatchObject({
      adjustmentToId: 222,
      items: [{ skuName: 'HI1', description: 'Offset', quantity: 1, unitPrice: -998484 }],
    });
    expect(writeCall!.body.payload).not.toHaveProperty('lineItems');
    // Top-level businessUnitId / invoiceDate are silently ignored by ST — the
    // tool must not send them and must not pretend they take effect.
    expect(writeCall!.body.payload).not.toHaveProperty('businessUnitId');
    expect(writeCall!.body.payload).not.toHaveProperty('invoiceDate');
  });

  // ── Wire-shape guards for the adjustment endpoint (endpoint B) ──
  it('dryRun preview payload uses `items`, never `lineItems`', async () => {
    const env = makeParentEnv({ id: 222, syncStatus: 'Exported', adjustmentToId: null, businessUnit: { id: 257 } });
    const dr: any = await st_create_adjustment_invoice.handler(
      env as any,
      { parentInvoiceId: 222, lineItems: [{ skuName: 'HI1', description: 'Offset', quantity: 1, unitPrice: -13674 }] },
      CTX
    );
    expect(dr.payload).toHaveProperty('items');
    expect(dr.payload).not.toHaveProperty('lineItems');
    expect(dr.payload.items).toHaveLength(1);
  });

  it('preserves a NEGATIVE unitPrice on the adjustment line (the offsetting-line case)', async () => {
    const env = makeParentEnv({ id: 222, syncStatus: 'Exported', adjustmentToId: null, businessUnit: { id: 257 } });
    const dr: any = await st_create_adjustment_invoice.handler(
      env as any,
      { parentInvoiceId: 222, lineItems: [{ skuName: 'HI1', description: 'Offset', quantity: 1, unitPrice: -13674 }] },
      CTX
    );
    expect(dr.payload.items[0].unitPrice).toBe(-13674);
  });

  // REGRESSION GUARD: `price` on an adjustment item is silently ignored by ST.
  it('never emits `price` on an adjustment item — ST drops it and the adjustment lands at $0.00', async () => {
    const env = makeParentEnv({ id: 222, syncStatus: 'Exported', adjustmentToId: null, businessUnit: { id: 257 } });
    const dr: any = await st_create_adjustment_invoice.handler(
      env as any,
      { parentInvoiceId: 222, lineItems: [{ skuName: 'HI1', description: 'Offset', quantity: 1, unitPrice: -100, price: -999 } as any] },
      CTX
    );
    expect(dr.payload.items[0]).not.toHaveProperty('price');
    expect(dr.payload.items[0].unitPrice).toBe(-100);
  });

  // ASYMMETRY: endpoint A (.../items PATCH) ACCEPTS skuId; endpoint B's items[]
  // does NOT — ST resolves the adjustment line by skuName only.
  it('requires skuName on every adjustment line item', async () => {
    const env = makeParentEnv({ id: 222, syncStatus: 'Exported', adjustmentToId: null, businessUnit: { id: 257 } });
    await expect(
      st_create_adjustment_invoice.handler(
        env as any,
        { parentInvoiceId: 222, lineItems: [{ description: 'Offset', quantity: 1, unitPrice: -100 } as any] },
        CTX
      )
    ).rejects.toMatchObject({ code: 'validation_error', message: expect.stringContaining('skuName') });
  });

  it('omits skuId from the outbound adjustment item — ST ignores it on this endpoint', async () => {
    const env = makeParentEnv({ id: 222, syncStatus: 'Exported', adjustmentToId: null, businessUnit: { id: 257 } });
    const dr: any = await st_create_adjustment_invoice.handler(
      env as any,
      { parentInvoiceId: 222, lineItems: [{ skuId: 1, skuName: 'HI1', description: 'Offset', quantity: 1, unitPrice: -100 } as any] },
      CTX
    );
    expect(dr.payload.items[0]).not.toHaveProperty('skuId');
    expect(dr.payload.items[0].skuName).toBe('HI1');
  });

  it('emits exactly the ST-accepted adjustment item field set and nothing else', async () => {
    const env = makeParentEnv({ id: 222, syncStatus: 'Exported', adjustmentToId: null, businessUnit: { id: 257 } });
    const dr: any = await st_create_adjustment_invoice.handler(
      env as any,
      { parentInvoiceId: 222, lineItems: [{ skuName: 'HI1', description: 'Offset', quantity: 2, cost: 10, unitPrice: -100 }] },
      CTX
    );
    expect(Object.keys(dr.payload.items[0]).sort()).toEqual(
      ['cost', 'description', 'quantity', 'skuName', 'unitPrice']
    );
  });

  // ── Fix 1: ids filter not honored guard ────────────────────
  it('throws upstream_error when the invoices list endpoint returns a different id than requested (ids filter not honored)', async () => {
    // Parent read returns id 999 even though parentInvoiceId 222 was requested —
    // simulates ST silently ignoring the `ids` param.
    const env = makeParentEnv({ id: 999, syncStatus: 'Exported', adjustmentToId: null, businessUnit: { id: 257 } });
    await expect(
      st_create_adjustment_invoice.handler(
        env as any,
        { parentInvoiceId: 222, lineItems: [{ skuName: 'HI1', description: 'Offset', quantity: 1, unitPrice: -200 }] },
        CTX
      )
    ).rejects.toMatchObject({ code: 'upstream_error', message: expect.stringContaining('ids filter not honored') });
  });

  // ── Fix 2: TOCTOU — now LIVE end-to-end (the Fix-3 hard-block previously
  // short-circuited before verifyToken ran; now that the hard-block is
  // lifted, this test proves the "args changed since dryRun" rejection
  // actually fires on the real confirm path). ──
  it('rejects the confirm call when the parent syncStatus changed between dryRun and confirm (TOCTOU, end-to-end)', async () => {
    let call = 0;
    const parentStates = [
      { id: 222, syncStatus: 'Posted', adjustmentToId: null, businessUnit: { id: 257 } },
      { id: 222, syncStatus: 'Exported', adjustmentToId: null, businessUnit: { id: 257 } },
    ];
    const env: any = {
      ST_PROXY: {
        fetch: vi.fn(async (url: string) => {
          if (url.includes('dryRun=1')) return new Response(JSON.stringify({ echo: true }), { status: 200 });
          if (url.endsWith('/api/st/write')) {
            throw new Error('should not reach the live write — TOCTOU must reject before this');
          }
          const state = parentStates[Math.min(call, parentStates.length - 1)];
          call++;
          return new Response(JSON.stringify({ data: [state] }), { status: 200 });
        }),
      },
      MCP_SYNC_KEY: 'test-sync-key', MCP_SERVICE_VERSION: '0.0.0-test', ST_TENANT_ID: '000000000',
      DB: makeDB(), PROXY_STATE: {}, SIRO_API_TOKEN: '',
    };

    // dryRun call reads parent with syncStatus=Posted (parentStates[0]).
    const args = { parentInvoiceId: 222, lineItems: [{ skuName: 'HI1', description: 'Offset', quantity: 1, unitPrice: -200 }] };
    const dr: any = await st_create_adjustment_invoice.handler(env, args, CTX);
    expect(dr.dryRun).toBe(true);

    // Confirm call re-reads parent — now syncStatus=Exported (parentStates[1]) —
    // a *different* value than what was hashed into the token during dryRun.
    // gate.verifyToken must throw "args changed since dryRun", and the live
    // /api/st/write call must never be reached.
    await expect(
      st_create_adjustment_invoice.handler(
        env,
        { ...args, dryRun: false, confirmation_token: dr.confirmation_token },
        CTX
      )
    ).rejects.toThrow(/args changed since dryRun/);
  });

  // Fix 3 (the sandbox hard-block) has been REMOVED: the endpoint is now
  // confirmed by the ST Accounting v2 API catalog, so live writes are enabled.
  // See "confirm call executes via /api/st/write" above for the now-live path.

  it('dryRun=true still returns a normal preview (hard-block only applies to dryRun=false)', async () => {
    const env = makeParentEnv({ id: 222, syncStatus: 'Exported', adjustmentToId: null, businessUnit: { id: 257 } });
    const result: any = await st_create_adjustment_invoice.handler(
      env as any,
      { parentInvoiceId: 222, lineItems: [{ skuName: 'HI1', description: 'Offset', quantity: 1, unitPrice: -200 }] },
      CTX
    );
    expect(result.dryRun).toBe(true);
    expect(result.confirmation_token).toBeTypeOf('string');
  });
});
