// ============================================================
// no_d1_reads.test.ts — Design-correction invariant for the Phase 4
// estimate-template CRUD tools.
//
// The original plan called for "forcing a D1 estimate_templates refresh
// after write." That is not buildable (readD1 in src/d1.ts is SELECT/WITH-only
// by design) and not needed (no mcp-servicetitan tool reads a D1
// estimate_templates table — verified by grep across src/tools). All 5 tools
// read/write LIVE ServiceTitan only, via readST/readSTPaged/ST_PROXY's
// /api/st/write — never servicetitan-proxy's /api/sql/read (the D1 SQL gate).
// This test proves that invariant behaviorally, not just by code inspection.
// ============================================================
import { describe, it, expect } from 'vitest';
import { list_estimate_templates } from '../list_estimate_templates';
import { get_estimate_template } from '../get_estimate_template';
import { create_estimate_template } from '../create_estimate_template';
import { update_estimate_template } from '../update_estimate_template';
import { delete_estimate_template } from '../delete_estimate_template';
import { CTX, makeEnv } from './helpers';

function assertNoD1Calls(env: any) {
  const urls: string[] = env.ST_PROXY.fetch.mock.calls.map((c: unknown[]) => String(c[0]));
  expect(urls.length).toBeGreaterThan(0);
  expect(urls.some((u) => u.includes('/api/sql/read'))).toBe(false);
}

describe('estimate-template CRUD — live reads only, never D1', () => {
  it('list_estimate_templates never calls /api/sql/read', async () => {
    const env = makeEnv(async () => new Response(JSON.stringify({ data: [], hasMore: false }), { status: 200 }));
    await list_estimate_templates.handler(env, {}, CTX);
    assertNoD1Calls(env);
  });

  it('get_estimate_template never calls /api/sql/read', async () => {
    const env = makeEnv(async () => new Response(JSON.stringify({ id: 1 }), { status: 200 }));
    await get_estimate_template.handler(env, { templateId: 1 }, CTX);
    assertNoD1Calls(env);
  });

  it('create_estimate_template never calls /api/sql/read across dryRun + confirm', async () => {
    const env = makeEnv(async () => new Response(JSON.stringify({ id: 1 }), { status: 200 }));
    const args = { name: 'X', internalName: 'X-int', mode: 'Dynamic' as const, items: [{ skuId: 1, skuType: 'Service' as const, quantity: 1 }] };
    const dry: any = await create_estimate_template.handler(env, args, CTX);
    await create_estimate_template.handler(env, { ...args, dryRun: false, confirmation_token: dry.confirmation_token }, CTX);
    assertNoD1Calls(env);
  });

  it('update_estimate_template never calls /api/sql/read across dryRun + confirm', async () => {
    const env = makeEnv(async () => new Response(JSON.stringify({ id: 1 }), { status: 200 }));
    const args = { templateId: 1, name: 'Renamed' };
    const dry: any = await update_estimate_template.handler(env, args, CTX);
    await update_estimate_template.handler(env, { ...args, dryRun: false, confirmation_token: dry.confirmation_token }, CTX);
    assertNoD1Calls(env);
  });

  it('delete_estimate_template never calls /api/sql/read across dryRun + confirm', async () => {
    const env = makeEnv(async () => new Response(JSON.stringify({ id: 1, active: false }), { status: 200 }));
    const args = { templateId: 1 };
    const dry: any = await delete_estimate_template.handler(env, args, CTX);
    await delete_estimate_template.handler(env, { ...args, dryRun: false, confirmation_token: dry.confirmation_token }, CTX);
    assertNoD1Calls(env);
  });
});
