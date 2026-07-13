import { describe, it, expect, vi, afterEach } from 'vitest';
import { get_service_breakout } from '../get_service_breakout';

const env = { SUPABASE_URL: 'https://p.supabase.co', SUPABASE_PB_KEY: 'k' } as any;
const ctx = { actor: 'test', correlation: 'c1' };
afterEach(() => vi.unstubAllGlobals());

describe('get_service_breakout', () => {
  it('reads the service row then resolves component items by st_id, shaping prices', async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (u: string) => {
      calls.push(String(u));
      if (String(u).includes('code=eq.SVC-1')) {
        return new Response(JSON.stringify([{
          st_id: 900, code: 'SVC-1', name: 'AC Install', item_type: 'service', st_price: 0, labor_hours: 4,
          service_materials: [{ skuId: 111 }], service_equipment: [{ skuId: 222 }],
          recommendations: [], upgrades: [],
        }]), { status: 200 });
      }
      // batch component resolve
      return new Response(JSON.stringify([
        { st_id: 111, code: 'MAT-1', name: 'Lineset', item_type: 'material', st_price: 40 },
        { st_id: 222, code: 'EQ-1', name: 'Condenser', item_type: 'equipment', st_price: 0 },
      ]), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const out: any = await get_service_breakout.handler(env, { code: 'SVC-1' }, ctx);

    expect(out.service.code).toBe('SVC-1');
    expect(out.service.st_price).toBeNull();          // $0 dynamic → null
    expect(out.service.labor_hours).toBe(4);
    expect(out.materials.map((m: any) => m.code)).toEqual(['MAT-1']);
    expect(out.equipment.map((e: any) => e.code)).toEqual(['EQ-1']);
    expect(out.equipment[0].st_price).toBeNull();
    expect(out.materials[0].st_price).toBe(40);
    // batch select used a single in.() call
    expect(calls.some((u) => u.includes('st_id=in.(111,222)'))).toBe(true);
  });

  it('returns empty component arrays when the service has no links', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([{
      st_id: 5, code: 'SVC-2', name: 'Diag', item_type: 'service', st_price: 89,
      service_materials: [], service_equipment: [], recommendations: [], upgrades: [],
    }]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const out: any = await get_service_breakout.handler(env, { code: 'SVC-2' }, ctx);
    expect(out.materials).toEqual([]);
    expect(out.equipment).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1); // no batch resolve needed
  });

  it('returns not_found when no service row matches', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([]), { status: 200 })));
    const out: any = await get_service_breakout.handler(env, { code: 'MISSING' }, ctx);
    expect(out.service).toBeNull();
    expect(out.not_found).toBe(true);
  });
});
