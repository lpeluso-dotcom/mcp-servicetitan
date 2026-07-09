// ============================================================
// create_estimate_template.test.ts — Phase 4 estimate-template CRUD.
// Live-verified 2026-07-09: POST /sales/v2/tenant/{tid}/estimate-templates.
// Create-time item input excludes ST-computed fields (unitPrice/totalPrice/
// unitCost/description/skuName) — those come from the sku, not the caller.
// allowDiscounts defaults to true when the caller omits it (QSC convention).
// ============================================================
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { create_estimate_template } from '../create_estimate_template';
import { CTX, makeEnv, noFetch } from './helpers';

const MINIMAL_ITEM = { skuId: 100, skuType: 'Service' as const, quantity: 1 };
const MINIMAL_ARGS = { name: 'Std HVAC Diagnostic', mode: 'Dynamic' as const, items: [MINIMAL_ITEM] };

describe('create_estimate_template', () => {
  it('is a write tool', () => {
    expect(create_estimate_template.isWrite).toBe(true);
  });

  it('declares the correct stEndpoint coverage descriptor', () => {
    expect(create_estimate_template.stEndpoint).toEqual({
      method: 'POST',
      path: '/sales/v2/tenant/{tid}/estimate-templates',
      source: 'live',
    });
  });

  it('requires name, mode, and items', () => {
    const schema = z.object(create_estimate_template.zodSchema);
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ name: 'X' }).success).toBe(false);
    expect(schema.safeParse({ name: 'X', mode: 'Dynamic' }).success).toBe(false);
    expect(schema.safeParse(MINIMAL_ARGS).success).toBe(true);
  });

  it('rejects an invalid mode', () => {
    const schema = z.object(create_estimate_template.zodSchema);
    expect(schema.safeParse({ ...MINIMAL_ARGS, mode: 'Bogus' }).success).toBe(false);
  });

  it('rejects an invalid item skuType', () => {
    const schema = z.object(create_estimate_template.zodSchema);
    const r = schema.safeParse({
      name: 'X', mode: 'Dynamic', items: [{ skuId: 1, skuType: 'Bogus', quantity: 1 }],
    });
    expect(r.success).toBe(false);
  });

  it('requires skuId and quantity on each item', () => {
    const schema = z.object(create_estimate_template.zodSchema);
    expect(schema.safeParse({ name: 'X', mode: 'Dynamic', items: [{ skuType: 'Service', quantity: 1 }] }).success).toBe(false);
    expect(schema.safeParse({ name: 'X', mode: 'Dynamic', items: [{ skuId: 1, skuType: 'Service' }] }).success).toBe(false);
  });

  it('strips ST-computed create-time-invalid fields from items (unitPrice/totalPrice/unitCost/description/skuName)', () => {
    const schema = z.object(create_estimate_template.zodSchema);
    const parsed = schema.safeParse({
      name: 'X',
      mode: 'Dynamic',
      items: [{
        skuId: 1, skuType: 'Service', quantity: 1,
        unitPrice: 999, totalPrice: 999, unitCost: 400, description: 'hand-written', skuName: 'hand-written',
      }],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      const items = (parsed.data as { items: unknown[] }).items;
      const item = items[0] as Record<string, unknown>;
      expect(item.unitPrice).toBeUndefined();
      expect(item.totalPrice).toBeUndefined();
      expect(item.unitCost).toBeUndefined();
      expect(item.description).toBeUndefined();
      expect(item.skuName).toBeUndefined();
    }
  });

  it('defaults to dryRun=true and never calls ST_PROXY', async () => {
    const env = makeEnv(noFetch());
    const result: any = await create_estimate_template.handler(env, MINIMAL_ARGS, CTX);
    expect(result.dryRun).toBe(true);
    expect(env.ST_PROXY.fetch).not.toHaveBeenCalled();
  });

  it('defaults allowDiscounts to true when omitted from an item (QSC convention)', async () => {
    const env = makeEnv(noFetch());
    const dry: any = await create_estimate_template.handler(env, MINIMAL_ARGS, CTX);
    expect(dry.payload.items[0].allowDiscounts).toBe(true);
  });

  it('preserves an explicit allowDiscounts:false rather than overriding it', async () => {
    const env = makeEnv(noFetch());
    const dry: any = await create_estimate_template.handler(env, {
      ...MINIMAL_ARGS,
      items: [{ ...MINIMAL_ITEM, allowDiscounts: false }],
    }, CTX);
    expect(dry.payload.items[0].allowDiscounts).toBe(false);
  });

  it('defaults isAddOn to false and chargeable to true when omitted', async () => {
    const env = makeEnv(noFetch());
    const dry: any = await create_estimate_template.handler(env, MINIMAL_ARGS, CTX);
    expect(dry.payload.items[0].isAddOn).toBe(false);
    expect(dry.payload.items[0].chargeable).toBe(true);
  });

  it('rejects dryRun=false without a confirmation_token', async () => {
    const env = makeEnv(async () => new Response('{}', { status: 200 }));
    await expect(
      create_estimate_template.handler(env, { ...MINIMAL_ARGS, dryRun: false }, CTX),
    ).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('dryRun -> confirm round-trip POSTs to /sales/v2/tenant/000000000/estimate-templates', async () => {
    const env = makeEnv(async () => new Response(JSON.stringify({ id: 555, name: MINIMAL_ARGS.name }), { status: 200 }));
    const dry: any = await create_estimate_template.handler(env, MINIMAL_ARGS, CTX);
    expect(env.ST_PROXY.fetch).not.toHaveBeenCalled();

    const live: any = await create_estimate_template.handler(
      env,
      { ...MINIMAL_ARGS, dryRun: false, confirmation_token: dry.confirmation_token },
      CTX,
    );
    expect(live.dryRun).toBe(false);
    expect(live.result).toEqual({ id: 555, name: MINIMAL_ARGS.name });
    expect(env.ST_PROXY.fetch).toHaveBeenCalledTimes(1);

    const [url, init] = env.ST_PROXY.fetch.mock.calls[0];
    expect(url).toContain('/api/st/write');
    const body = JSON.parse(init.body);
    expect(body.endpoint).toBe('/sales/v2/tenant/000000000/estimate-templates');
    expect(body.method).toBe('POST');
    expect(body.payload.name).toBe('Std HVAC Diagnostic');
    expect(body.payload.mode).toBe('Dynamic');
    expect(body.payload.items[0].allowDiscounts).toBe(true);
  });

  it('includes optional top-level fields (internalName, summary, businessUnitId) in the payload when provided', async () => {
    const env = makeEnv(noFetch());
    const dry: any = await create_estimate_template.handler(env, {
      ...MINIMAL_ARGS,
      internalName: 'INT-STD-HVAC',
      summary: 'Standard diagnostic bundle',
      businessUnitId: 7,
    }, CTX);
    expect(dry.payload.internalName).toBe('INT-STD-HVAC');
    expect(dry.payload.summary).toBe('Standard diagnostic bundle');
    expect(dry.payload.businessUnitId).toBe(7);
  });

  it('omits optional top-level fields from the payload when not provided', async () => {
    const env = makeEnv(noFetch());
    const dry: any = await create_estimate_template.handler(env, MINIMAL_ARGS, CTX);
    expect(dry.payload).not.toHaveProperty('internalName');
    expect(dry.payload).not.toHaveProperty('summary');
    expect(dry.payload).not.toHaveProperty('businessUnitId');
  });
});
