// ============================================================
// list_estimate_templates.test.ts — Phase 4 estimate-template CRUD.
// Live-verified 2026-07-09: GET /sales/v2/tenant/{tid}/estimate-templates
// -> { page, pageSize, hasMore, totalCount, data: Template[] }.
// ============================================================
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { list_estimate_templates } from '../list_estimate_templates';
import { CTX, makeEnv } from './helpers';

function pageOk(data: unknown[], extra: Record<string, unknown> = {}) {
  return async () => new Response(JSON.stringify({ data, hasMore: false, ...extra }), { status: 200 });
}

describe('list_estimate_templates', () => {
  it('accepts empty args', () => {
    const schema = z.object(list_estimate_templates.zodSchema);
    expect(schema.safeParse({}).success).toBe(true);
  });

  it('rejects an invalid active value', () => {
    const schema = z.object(list_estimate_templates.zodSchema);
    expect(schema.safeParse({ active: 'Bogus' }).success).toBe(false);
    expect(schema.safeParse({ active: 'True' }).success).toBe(true);
    expect(schema.safeParse({ active: 'False' }).success).toBe(true);
    expect(schema.safeParse({ active: 'Any' }).success).toBe(true);
  });

  it('declares the correct stEndpoint descriptor', () => {
    expect(list_estimate_templates.stEndpoint).toEqual({
      method: 'GET',
      path: '/sales/v2/tenant/{tid}/estimate-templates',
      source: 'live',
    });
  });

  it('defaults the active filter to Any (not active-only) and requests pageSize 200', async () => {
    let capturedUrl = '';
    const env = makeEnv(async (url: string) => {
      capturedUrl = url;
      return new Response(JSON.stringify({ data: [], hasMore: false }), { status: 200 });
    });
    await list_estimate_templates.handler(env, {}, CTX);
    const endpointParam = new URL(capturedUrl).searchParams.get('endpoint');
    expect(endpointParam).toContain('estimate-templates');
    expect(endpointParam).toContain('active=Any');
    expect(endpointParam).toContain('pageSize=200');
  });

  it('honors an explicit active filter override', async () => {
    let capturedUrl = '';
    const env = makeEnv(async (url: string) => {
      capturedUrl = url;
      return new Response(JSON.stringify({ data: [], hasMore: false }), { status: 200 });
    });
    await list_estimate_templates.handler(env, { active: 'True' }, CTX);
    const endpointParam = new URL(capturedUrl).searchParams.get('endpoint');
    expect(endpointParam).toContain('active=True');
  });

  it('passes businessUnitId filter when provided', async () => {
    let capturedUrl = '';
    const env = makeEnv(async (url: string) => {
      capturedUrl = url;
      return new Response(JSON.stringify({ data: [], hasMore: false }), { status: 200 });
    });
    await list_estimate_templates.handler(env, { businessUnitId: 42 }, CTX);
    const endpointParam = new URL(capturedUrl).searchParams.get('endpoint');
    expect(endpointParam).toContain('businessUnitId=42');
  });

  it('omits businessUnitId from the query when not provided', async () => {
    let capturedUrl = '';
    const env = makeEnv(async (url: string) => {
      capturedUrl = url;
      return new Response(JSON.stringify({ data: [], hasMore: false }), { status: 200 });
    });
    await list_estimate_templates.handler(env, {}, CTX);
    const endpointParam = new URL(capturedUrl).searchParams.get('endpoint');
    expect(endpointParam).not.toContain('businessUnitId');
  });

  it('returns templates array with count and _source live', async () => {
    const env = makeEnv(pageOk([{ id: 1, name: 'Std HVAC Diagnostic' }], { totalCount: 1 }));
    const result: any = await list_estimate_templates.handler(env, {}, CTX);
    expect(result.templates).toEqual([{ id: 1, name: 'Std HVAC Diagnostic' }]);
    expect(result.count).toBe(1);
    expect(result._source).toBe('live');
  });

  it('falls back to rows.length for count when ST omits totalCount', async () => {
    const env = makeEnv(pageOk([{ id: 1 }, { id: 2 }]));
    const result: any = await list_estimate_templates.handler(env, {}, CTX);
    expect(result.count).toBe(2);
  });
});
