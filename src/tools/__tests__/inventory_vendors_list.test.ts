import { describe, it, expect, vi } from 'vitest';
import { inventory_vendors_list } from '../inventory/inventory_vendors_list';

function fakeEnv() {
  const fetcher = vi.fn(async () =>
    new Response(
      JSON.stringify({
        data: [
          {
            id: 1,
            name: 'Acme Supply',
            active: true,
            phone: '555-0100',
            email: 'sales@acme.example',
            paginationToken: 'noise',
          },
          {
            id: 2,
            name: 'Bolt Co',
            active: false,
            phone: null,
            email: null,
          },
        ],
        hasMore: false,
      }),
      { status: 200 },
    ),
  );
  return {
    ST_TENANT_ID: '431848990',
    ST_PROXY: { fetch: fetcher },
    MCP_SYNC_KEY: 'k',
  } as any;
}

describe('inventory_vendors_list', () => {
  it('returns slim vendor records and forwards filters', async () => {
    const env = fakeEnv();
    const out = (await inventory_vendors_list.handler(env, { active: true, pageSize: 2 }, { actor: 'test', correlation: 'c1' })) as any;
    expect(out.count).toBe(2);
    expect(out.vendors[0]).toEqual({
      id: 1,
      name: 'Acme Supply',
      active: true,
      phone: '555-0100',
      email: 'sales@acme.example',
    });
    expect(out.vendors[1]).toEqual({
      id: 2,
      name: 'Bolt Co',
      active: false,
      phone: null,
      email: null,
    });
    const calledUrl = (env.ST_PROXY.fetch as any).mock.calls[0][0];
    expect(calledUrl).toContain('%2Finventory%2Fv2%2Ftenant%2F431848990%2Fvendors');
    expect(calledUrl).toContain('active%3Dtrue');
    expect(calledUrl).toContain('pageSize%3D2');
    expect(out.has_more).toBe(false);
    expect(out._source).toBe('live');
  });

  it('omits active filter when not provided', async () => {
    const env = fakeEnv();
    await inventory_vendors_list.handler(env, {}, { actor: 'test', correlation: 'c1' });
    const calledUrl = (env.ST_PROXY.fetch as any).mock.calls[0][0];
    expect(calledUrl).not.toContain('active%3D');
  });

  it('throws McpError on upstream failure', async () => {
    const env = {
      ST_TENANT_ID: '431848990',
      ST_PROXY: { fetch: vi.fn(async () => new Response('', { status: 502 })) },
      MCP_SYNC_KEY: 'k',
    } as any;
    await expect(
      inventory_vendors_list.handler(env, {}, { actor: 'test', correlation: 'c1' }),
    ).rejects.toThrow(/inventory_vendors_list failed: 502/);
  });
});
