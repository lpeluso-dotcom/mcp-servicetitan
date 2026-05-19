import { describe, it, expect, vi } from 'vitest';
import { inventory_warehouses_list } from '../inventory/inventory_warehouses_list';

function fakeEnv() {
  const fetcher = vi.fn(async () =>
    new Response(
      JSON.stringify({
        data: [
          {
            id: 10,
            name: 'Main Warehouse',
            active: true,
            address: { street: '123 Main St', unit: null, city: 'Florence', state: 'SC', zip: '29501' },
          },
          {
            id: 11,
            name: 'Overflow',
            // active intentionally omitted — exercises the `?? null` default
            address: { street: '456 Oak Ave', city: 'Florence', state: 'SC', zip: '29502' },
          },
        ],
        hasMore: true,
      }),
      { status: 200 },
    ),
  );
  return {
    ST_TENANT_ID: '000000000',
    ST_PROXY: { fetch: fetcher },
    MCP_SYNC_KEY: 'k',
  } as any;
}

describe('inventory_warehouses_list', () => {
  it('returns slim warehouse records with address and forwards filters', async () => {
    const env = fakeEnv();
    const out = (await inventory_warehouses_list.handler(
      env,
      { active: true, pageSize: 2 },
      { actor: 'test', correlation: 'c1' },
    )) as any;
    expect(out.count).toBe(2);
    expect(out.warehouses[0]).toEqual({
      id: 10,
      name: 'Main Warehouse',
      active: true,
      address: '123 Main St, Florence, SC, 29501',
    });
    // active omitted in raw → null
    expect(out.warehouses[1].active).toBeNull();
    // unit omitted → not in address string
    expect(out.warehouses[1].address).toBe('456 Oak Ave, Florence, SC, 29502');
    const calledUrl = (env.ST_PROXY.fetch as any).mock.calls[0][0];
    expect(calledUrl).toContain('%2Finventory%2Fv2%2Ftenant%2F000000000%2Fwarehouses');
    expect(calledUrl).toContain('active%3Dtrue');
    expect(calledUrl).toContain('pageSize%3D2');
    expect(out.has_more).toBe(true);
    expect(out._source).toBe('live');
  });

  it('omits active filter when not provided', async () => {
    const env = fakeEnv();
    await inventory_warehouses_list.handler(env, {}, { actor: 'test', correlation: 'c1' });
    const calledUrl = (env.ST_PROXY.fetch as any).mock.calls[0][0];
    expect(calledUrl).not.toContain('active%3D');
  });

  it('returns empty address string when address field is absent', async () => {
    const env = {
      ST_TENANT_ID: '000000000',
      ST_PROXY: {
        fetch: vi.fn(async () =>
          new Response(
            JSON.stringify({ data: [{ id: 99, name: 'No-Address', active: false }], hasMore: false }),
            { status: 200 },
          ),
        ),
      },
      MCP_SYNC_KEY: 'k',
    } as any;
    const out = (await inventory_warehouses_list.handler(env, {}, { actor: 'test', correlation: 'c1' })) as any;
    expect(out.warehouses[0].address).toBe('');
  });

  it('throws McpError on upstream failure', async () => {
    const env = {
      ST_TENANT_ID: '000000000',
      ST_PROXY: { fetch: vi.fn(async () => new Response('', { status: 503 })) },
      MCP_SYNC_KEY: 'k',
    } as any;
    await expect(
      inventory_warehouses_list.handler(env, {}, { actor: 'test', correlation: 'c1' }),
    ).rejects.toThrow(/readST 503 on \/inventory\/v2\/tenant\/000000000\/warehouses/);
  });

  it('forwards page and pageSize args into the URL', async () => {
    const env = fakeEnv();
    await inventory_warehouses_list.handler(env, { page: 3, pageSize: 50 }, { actor: 'test', correlation: 'c1' });
    const calledUrl = (env.ST_PROXY.fetch as any).mock.calls[0][0];
    expect(calledUrl).toContain('page%3D3');
    expect(calledUrl).toContain('pageSize%3D50');
  });
});
