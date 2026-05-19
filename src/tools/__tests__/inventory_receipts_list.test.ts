import { describe, it, expect, vi } from 'vitest';
import { inventory_receipts_list } from '../inventory/inventory_receipts_list';

function fakeEnv() {
  const fetcher = vi.fn(async () =>
    new Response(
      JSON.stringify({
        data: [
          {
            id: 100,
            number: 'RCP-001',
            status: 'Received',
            vendorId: 5,
            warehouseId: 10,
            receivedOn: '2024-03-15T00:00:00Z',
            total: 1250.0,
          },
          {
            id: 101,
            // number, vendorId, warehouseId, receivedOn intentionally omitted
            status: 'Pending',
            total: 0,
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

describe('inventory_receipts_list', () => {
  it('returns slim receipt records and maps receivedOn to date', async () => {
    const env = fakeEnv();
    const out = (await inventory_receipts_list.handler(
      env,
      { vendorId: 5, pageSize: 10 },
      { actor: 'test', correlation: 'c1' },
    )) as any;
    expect(out.count).toBe(2);
    expect(out.receipts[0]).toEqual({
      id: 100,
      receipt_number: 'RCP-001',
      status: 'Received',
      vendor_id: 5,
      warehouse_id: 10,
      date: '2024-03-15T00:00:00Z',
      total: 1250.0,
    });
    // omitted fields fall back to null / defaults
    expect(out.receipts[1].receipt_number).toBe('');
    expect(out.receipts[1].vendor_id).toBeNull();
    expect(out.receipts[1].warehouse_id).toBeNull();
    expect(out.receipts[1].date).toBeNull();
    const calledUrl = (env.ST_PROXY.fetch as any).mock.calls[0][0];
    expect(calledUrl).toContain('%2Finventory%2Fv2%2Ftenant%2F000000000%2Freceipts');
    expect(calledUrl).toContain('vendorId%3D5');
    expect(out.has_more).toBe(false);
    expect(out._source).toBe('live');
  });

  it('forwards warehouseId filter into the URL', async () => {
    const env = fakeEnv();
    await inventory_receipts_list.handler(env, { warehouseId: 10 }, { actor: 'test', correlation: 'c1' });
    const calledUrl = (env.ST_PROXY.fetch as any).mock.calls[0][0];
    expect(calledUrl).toContain('warehouseId%3D10');
  });

  it('throws McpError on upstream failure', async () => {
    const env = {
      ST_TENANT_ID: '000000000',
      ST_PROXY: { fetch: vi.fn(async () => new Response('', { status: 500 })) },
      MCP_SYNC_KEY: 'k',
    } as any;
    await expect(
      inventory_receipts_list.handler(env, {}, { actor: 'test', correlation: 'c1' }),
    ).rejects.toThrow(/readST 500 on \/inventory\/v2\/tenant\/000000000\/receipts/);
  });

  it('returns count=0 and receipts=[] when ST returns empty data', async () => {
    const env = {
      ST_TENANT_ID: '000000000',
      ST_PROXY: {
        fetch: vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })),
      },
      MCP_SYNC_KEY: 'k',
    } as any;
    const out = (await inventory_receipts_list.handler(env, {}, { actor: 'test', correlation: 'c1' })) as any;
    expect(out.count).toBe(0);
    expect(out.receipts).toEqual([]);
  });
});
