// ============================================================
// delete_estimate_template.test.ts — Phase 4 estimate-template CRUD.
// Live-verified 2026-07-09: DELETE /sales/v2/tenant/{tid}/estimate-templates/{id}
// is a SOFT-DEACTIVATE (sets active:false), reversible via
// update_estimate_template({active:true}). Unlike item-level PATCH (which
// freezes modifiedOn), DELETE *does* advance modifiedOn.
// ============================================================
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { delete_estimate_template } from '../delete_estimate_template';
import { CTX, makeEnv, noFetch } from './helpers';

describe('delete_estimate_template', () => {
  it('is a write tool', () => {
    expect(delete_estimate_template.isWrite).toBe(true);
  });

  it('declares the correct stEndpoint coverage descriptor', () => {
    expect(delete_estimate_template.stEndpoint).toEqual({
      method: 'DELETE',
      path: '/sales/v2/tenant/{tid}/estimate-templates/{templateId}',
      source: 'live',
    });
  });

  it('requires templateId', () => {
    const schema = z.object(delete_estimate_template.zodSchema);
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ templateId: 10 }).success).toBe(true);
  });

  it('documents the soft-deactivate + reversible behavior', () => {
    expect(delete_estimate_template.description).toMatch(/active\s*[:=]?\s*false|deactivat/i);
    expect(delete_estimate_template.description).toMatch(/update_estimate_template/);
    expect(delete_estimate_template.description).toMatch(/reversible/i);
  });

  it('defaults to dryRun=true and never calls ST_PROXY', async () => {
    const env = makeEnv(noFetch());
    const result: any = await delete_estimate_template.handler(env, { templateId: 10 }, CTX);
    expect(result.dryRun).toBe(true);
    expect(env.ST_PROXY.fetch).not.toHaveBeenCalled();
  });

  it('rejects dryRun=false without a confirmation_token', async () => {
    const env = makeEnv(async () => new Response('{}', { status: 200 }));
    await expect(
      delete_estimate_template.handler(env, { templateId: 10, dryRun: false }, CTX),
    ).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('dryRun -> confirm round-trip DELETEs /sales/v2/tenant/000000000/estimate-templates/{id}', async () => {
    const env = makeEnv(async () => new Response(JSON.stringify({ id: 10, active: false }), { status: 200 }));
    const dry: any = await delete_estimate_template.handler(env, { templateId: 10 }, CTX);
    expect(env.ST_PROXY.fetch).not.toHaveBeenCalled();

    const live: any = await delete_estimate_template.handler(
      env,
      { templateId: 10, dryRun: false, confirmation_token: dry.confirmation_token },
      CTX,
    );
    expect(live.dryRun).toBe(false);
    expect(env.ST_PROXY.fetch).toHaveBeenCalledTimes(1);

    const [url, init] = env.ST_PROXY.fetch.mock.calls[0];
    expect(url).toContain('/api/st/write');
    const body = JSON.parse(init.body);
    expect(body.endpoint).toBe('/sales/v2/tenant/000000000/estimate-templates/10');
    expect(body.method).toBe('DELETE');
  });
});
