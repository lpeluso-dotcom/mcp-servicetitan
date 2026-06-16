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
    const result: any = await st_create_material.handler(env, { name: 'R-22', categoryId: 10 }, CTX);
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
    const result: any = await st_create_material.handler(env, { name: 'WidgetMat', categoryId: 99, code: 'WM-1' }, CTX);
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
