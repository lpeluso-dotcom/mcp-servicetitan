// ============================================================
// get_estimate_template.test.ts — Phase 4 estimate-template CRUD.
// Live-verified 2026-07-09: GET /sales/v2/tenant/{tid}/estimate-templates/{id}
// WORKS (200, full object) — unlike invoices/calls this is NOT in the
// no-by-id-route class. Mirrors get_estimate.ts's pattern exactly.
// ============================================================
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { get_estimate_template } from '../get_estimate_template';
import { CTX, makeEnv, liveOkDirect } from './helpers';

describe('get_estimate_template', () => {
  it('requires templateId', () => {
    const schema = z.object(get_estimate_template.zodSchema);
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ templateId: 10 }).success).toBe(true);
  });

  it('declares the correct stEndpoint descriptor', () => {
    expect(get_estimate_template.stEndpoint).toEqual({
      method: 'GET',
      path: '/sales/v2/tenant/{tid}/estimate-templates/{templateId}',
      source: 'live',
    });
  });

  it('fetches a single template by ID', async () => {
    const env = makeEnv(liveOkDirect({ id: 10, name: 'Std HVAC', mode: 'Dynamic' }));
    const result: any = await get_estimate_template.handler(env, { templateId: 10 }, CTX);
    expect(result.template).toEqual({ id: 10, name: 'Std HVAC', mode: 'Dynamic' });
    expect(result._source).toBe('live');
  });

  it('calls the estimate-templates endpoint with the ID in the path', async () => {
    const env = makeEnv(liveOkDirect({ id: 10 }));
    await get_estimate_template.handler(env, { templateId: 10 }, CTX);
    const [url] = env.ST_PROXY.fetch.mock.calls[0];
    const endpointParam = new URL(url).searchParams.get('endpoint');
    expect(endpointParam).toContain('estimate-templates/10');
  });

  it('propagates not_found on a genuine ST 404 (no redundant wrapper needed)', async () => {
    const env = makeEnv(async () => new Response('{"message":"Estimate Template ID = 999 was not found"}', { status: 404 }));
    await expect(get_estimate_template.handler(env, { templateId: 999 }, CTX)).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});
