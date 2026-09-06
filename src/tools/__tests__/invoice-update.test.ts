import { describe, it, expect, vi, afterEach } from 'vitest';
vi.mock('../../st', () => ({ readST: vi.fn() }));
import { readST } from '../../st';
import { WriteGate } from '../../write-gate';
import { st_add_invoice_line_item } from '../invoicing/st_add_invoice_line_item';

afterEach(() => vi.restoreAllMocks());
describe('QUA-1185 invoice update verification', () => {
  it.each([
    ['quantity drop', { quantity: '1' }, 'amount_mismatch'],
    ['SKU id wipe', { skuId: null }, 'field_mismatch'],
    ['SKU name wipe', { skuName: '' }, 'field_mismatch'],
    ['description drop', { description: 'old' }, 'field_mismatch'],
  ])('rejects %s after a successful mocked PATCH', async (_name, change, code) => {
    const before = { id: 7, skuId: 8, skuName: 'SVC', description: 'old', quantity: '1', price: '10', cost: '2' };
    const after = { ...before, quantity: '2', description: 'new', ...(change as object) };
    vi.mocked(readST).mockReset().mockResolvedValueOnce({ data: [{ id: 1, items: [before] }] })
      .mockResolvedValue({ data: [{ id: 1, items: [after] }] });
    vi.spyOn(WriteGate.prototype, 'verifyToken').mockResolvedValue();
    const proxy = vi.fn(async () => new Response(JSON.stringify({ success: true, response: { raw: '' } })));
    const env = { ST_TENANT_ID: '123', MCP_SYNC_KEY: 'test', ST_PROXY: { fetch: proxy }, VERIFY_BACKOFF_MS: [0] } as never;
    await expect(st_add_invoice_line_item.handler(env, { invoiceId: 1, dryRun: false,
      confirmation_token: 'mocked', lineItems: [{ id: 7, quantity: 2, description: 'new' }] },
      { actor: 'test', correlation: 'test' } as never)).rejects.toMatchObject({ code });
    expect(proxy).toHaveBeenCalledTimes(1);
  });
});
