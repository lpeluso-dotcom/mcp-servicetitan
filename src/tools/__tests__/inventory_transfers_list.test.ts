import { describe, it, expect, vi } from 'vitest';
import { inventory_transfers_list } from '../inventory/inventory_transfers_list';

function fakeEnv() {
  const fetcher = vi.fn(async () =>
    new Response(
      JSON.stringify({
        data: [
          {
            id: 200,
            number: 'TRF-001',
            status: 'Completed',
            fromWarehouseId: 10,
            toWarehouseId: 11,
            transferredOn: '2024-04-01T00:00:00Z',
          },
          {
            id: 201,
            // number, fromWarehouseId, toWarehouseId, transferredOn intentionally omitted
            status: 'Pending',
          },
        ],
        hasMore: false,
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

describe('inventory_transfers_list', () => {
  it('returns slim transfer records and maps transferredOn to date', async () => {
    const env = fakeEnv();
    const out = (await inventory_transfers_list.handler(
      env,
      { fromWarehouseId: 10 },
      { actor: 'test', correlation: 'c1' },
    )) as any;
    expect(out.count).toBe(2);
    expect(out.transfers[0]).toEqual({
      id: 200,
      transfer_number: 'TRF-001',
      status: 'Completed',
      from_warehouse_id: 10,
      to_warehouse_id: 11,
      date: '2024-04-01T00:00:00Z',
    });
    // omitted fields fall back to null / defaults
    expect(out.transfers[1].transfer_number).toBe('');
    expect(out.transfers[1].from_warehouse_id).toBeNull();
    expect(out.transfers[1].to_warehouse_id).toBeNull();
    expect(out.transfers[1].date).toBeNull();
    const calledUrl = (env.ST_PROXY.fetch as any).mock.calls[0][0];
    expect(calledUrl).toContain('%2Finventory%2Fv2%2Ftenant%2F000000000%2Ftransfers');
    expect(calledUrl).toContain('fromWarehouseId%3D10');
    expect(out.has_more).toBe(false);
    expect(out._source).toBe('live');
  });

  it('forwards toWarehouseId filter into the URL', async () => {
    const env = fakeEnv();
    await inventory_transfers_list.handler(env, { toWarehouseId: 11 }, { actor: 'test', correlation: 'c1' });
    const calledUrl = (env.ST_PROXY.fetch as any).mock.calls[0][0];
    expect(calledUrl).toContain('toWarehouseId%3D11');
  });

  it('throws McpError on upstream failure', async () => {
    const env = {
      ST_TENANT_ID: '000000000',
      ST_PROXY: { fetch: vi.fn(async () => new Response('', { status: 502 })) },
      MCP_SYNC_KEY: 'k',
    } as any;
    await expect(
      inventory_transfers_list.handler(env, {}, { actor: 'test', correlation: 'c1' }),
    ).rejects.toThrow(/readST 502 on \/inventory\/v2\/tenant\/000000000\/transfers/);
  });
});
