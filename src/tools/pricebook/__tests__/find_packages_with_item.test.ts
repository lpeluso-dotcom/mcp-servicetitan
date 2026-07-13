import { describe, it, expect, vi, afterEach } from 'vitest';
import { find_packages_with_item } from '../find_packages_with_item';

const env = { SUPABASE_URL: 'https://p.supabase.co', SUPABASE_PB_KEY: 'k' } as any;
const ctx = { actor: 'test', correlation: 'c1' };
afterEach(() => vi.unstubAllGlobals());

function route(u: string) {
  if (u.includes('/rest/v1/pricebook_items')) return [{ st_id: 555 }];
  if (u.includes('/rpc/templates_with_item')) return [{ kind: 'template', id: 1, name: 'Pkg A' }];
  if (u.includes('/rpc/services_with_item')) return [{ st_id: 900, code: 'SVC-1', name: 'Install' }];
  return [];
}

describe('find_packages_with_item', () => {
  it('resolves st_id then queries templates + services reverse links', async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (u: string) => { calls.push(String(u)); return new Response(JSON.stringify(route(String(u))), { status: 200 }); });
    vi.stubGlobal('fetch', fetchMock);

    const out: any = await find_packages_with_item.handler(env, { code: 'CAP-240', itemType: 'material' }, ctx);

    expect(calls.some((u) => u.includes('pricebook_items?code=eq.CAP-240&item_type=eq.material&select=st_id'))).toBe(true);
    expect(calls.some((u) => u.includes('/rpc/templates_with_item'))).toBe(true);
    expect(calls.some((u) => u.includes('/rpc/services_with_item'))).toBe(true);
    expect(out.templates).toHaveLength(1);
    expect(out.services).toHaveLength(1);
  });

  it('skips services_with_item when st_id cannot be resolved', async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (u: string) => {
      calls.push(String(u));
      const body = String(u).includes('/rest/v1/pricebook_items') ? [] : route(String(u));
      return new Response(JSON.stringify(body), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const out: any = await find_packages_with_item.handler(env, { code: 'NOPE', itemType: 'material' }, ctx);
    expect(calls.some((u) => u.includes('/rpc/services_with_item'))).toBe(false);
    expect(out.services).toEqual([]);
    expect(out.templates).toHaveLength(1); // templates_with_item keys on code, still runs
  });
});
