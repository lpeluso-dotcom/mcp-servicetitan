// ============================================================
// pricebook_vendor_part_gaps — tests
// ============================================================
import { describe, it, expect, vi, beforeEach } from 'vitest';

const readD1Mock = vi.fn();
vi.mock('../../../d1', () => ({
  readD1: (...args: unknown[]) => readD1Mock(...args),
}));

import { pricebook_vendor_part_gaps } from '../pricebook_vendor_part_gaps';

const CTX = { actor: 'test', correlation: 'c1' };

function makeEnv(): any {
  return { ST_PROXY: { fetch: vi.fn() }, MCP_SYNC_KEY: 'k' };
}

beforeEach(() => {
  readD1Mock.mockReset();
});

describe('pricebook_vendor_part_gaps', () => {
  it('issues SELECT-only queries scoped to pb_materials + pb_equipment only (no pb_services)', async () => {
    readD1Mock.mockResolvedValueOnce({ rows: [] }); // materials no-vendor
    readD1Mock.mockResolvedValueOnce({ rows: [] }); // equipment no-vendor
    readD1Mock.mockResolvedValueOnce({ rows: [] }); // vendored materials (part-number check)

    await pricebook_vendor_part_gaps.handler(makeEnv(), {}, CTX);

    for (const call of readD1Mock.mock.calls) {
      const [, sql] = call;
      expect(sql.trim().toUpperCase().startsWith('SELECT')).toBe(true);
      expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER)\b/i);
      expect(sql).not.toContain('pb_services');
    }
    const tablesTouched = readD1Mock.mock.calls.map((c) => c[1]).join(' ');
    expect(tablesTouched).toContain('pb_materials');
    expect(tablesTouched).toContain('pb_equipment');
  });

  it('skips the part-number sub-query entirely when includeMissingPartNumber=false', async () => {
    readD1Mock.mockResolvedValueOnce({ rows: [] });
    readD1Mock.mockResolvedValueOnce({ rows: [] });

    const out: any = await pricebook_vendor_part_gaps.handler(makeEnv(), { includeMissingPartNumber: false }, CTX);

    expect(readD1Mock).toHaveBeenCalledTimes(2);
    expect(out.gaps.no_part_number).toEqual([]);
    expect(out.summary.no_part_number_count).toBeNull();
  });

  it('flags materials with no primary_vendor_id and equipment with no primary_vendor_name as no_vendor_link', async () => {
    readD1Mock.mockResolvedValueOnce({
      rows: [
        { id: 1, code: 'M1', name: 'Widget', cost: 40 },
        { id: 2, code: 'M2', name: 'Gadget', cost: 90 },
      ],
    }); // materials no-vendor
    readD1Mock.mockResolvedValueOnce({
      rows: [{ id: 3, code: 'E1', name: 'Condenser', cost: 500 }],
    }); // equipment no-vendor
    readD1Mock.mockResolvedValueOnce({ rows: [] }); // vendored materials

    const out: any = await pricebook_vendor_part_gaps.handler(makeEnv(), {}, CTX);

    expect(out.summary.no_vendor_link_count).toBe(3);
    expect(out.gaps.no_vendor_link).toHaveLength(3);
    // Sorted by cost desc: 500, 90, 40.
    expect(out.gaps.no_vendor_link.map((g: any) => g.id)).toEqual([3, 2, 1]);
    expect(out.gaps.no_vendor_link.find((g: any) => g.id === 3).kind).toBe('equipment');
    expect(out.gaps.no_vendor_link.find((g: any) => g.id === 1).kind).toBe('material');
    expect(out.gaps.no_vendor_link.every((g: any) => g.gap_type === 'no_vendor_link')).toBe(true);
  });

  it('parses vendors_json to find no_part_number gaps, guarding malformed JSON', async () => {
    readD1Mock.mockResolvedValueOnce({ rows: [] }); // materials no-vendor
    readD1Mock.mockResolvedValueOnce({ rows: [] }); // equipment no-vendor
    readD1Mock.mockResolvedValueOnce({
      rows: [
        // Has a vendor + a real vendorPart → NOT flagged.
        {
          id: 100, code: 'P1', name: 'Priced Part', cost: 30,
          primary_vendor_id: 55, primary_vendor_name: 'Acme Supply',
          vendors_json: JSON.stringify([{ id: 1, vendorId: 55, vendorName: 'Acme Supply', vendorPart: 'ACM-30' }]),
        },
        // Has a vendor but vendorPart is null → flagged no_part_number.
        {
          id: 101, code: 'P2', name: 'Unlabeled Part', cost: 60,
          primary_vendor_id: 56, primary_vendor_name: 'Beta Supply',
          vendors_json: JSON.stringify([{ id: 2, vendorId: 56, vendorName: 'Beta Supply', vendorPart: null }]),
        },
        // Malformed JSON — guarded, still flagged (can't verify a part number that can't be read).
        {
          id: 102, code: 'P3', name: 'Broken JSON Part', cost: 15,
          primary_vendor_id: 57, primary_vendor_name: 'Gamma Supply',
          vendors_json: '{not valid json',
        },
      ],
    });

    const out: any = await pricebook_vendor_part_gaps.handler(makeEnv(), {}, CTX);

    const ids = out.gaps.no_part_number.map((g: any) => g.id);
    expect(ids).toEqual(expect.arrayContaining([101, 102]));
    expect(ids).not.toContain(100);
    expect(out.summary.no_part_number_count).toBe(2);
    const flagged101 = out.gaps.no_part_number.find((g: any) => g.id === 101);
    expect(flagged101.vendor_name).toBe('Beta Supply');
    expect(flagged101.gap_type).toBe('no_part_number');
    expect(flagged101.kind).toBe('material');
    // Malformed JSON must not throw — it resolves via the guard, not a crash.
    const flagged102 = out.gaps.no_part_number.find((g: any) => g.id === 102);
    expect(flagged102).toBeDefined();
  });

  it('carries the honest "intrinsic gaps, not cross-referenced against an external catalog" _note', async () => {
    readD1Mock.mockResolvedValueOnce({ rows: [] });
    readD1Mock.mockResolvedValueOnce({ rows: [] });
    readD1Mock.mockResolvedValueOnce({ rows: [] });

    const out: any = await pricebook_vendor_part_gaps.handler(makeEnv(), {}, CTX);

    expect(out._composite).toBe('pricebook_vendor_part_gaps');
    expect(out._source).toBe('d1');
    expect(out._note).toMatch(/vendor_part_xref is empty/i);
    expect(out._note).toMatch(/intrinsic/i);
  });

  it('description states D1 source, when-to-use, and dynamic-pricing services exclusion', () => {
    expect(pricebook_vendor_part_gaps.description).toMatch(/D1/);
    expect(pricebook_vendor_part_gaps.description).toMatch(/pb_materials/);
    expect(pricebook_vendor_part_gaps.description).toMatch(/dynamic/i);
    expect(pricebook_vendor_part_gaps.description).toMatch(/pric/i);
  });

  it('declares stEndpoint as a d1:// source and readOnlyHint', () => {
    expect(pricebook_vendor_part_gaps.stEndpoint?.source).toBe('d1');
    expect(pricebook_vendor_part_gaps.annotations?.readOnlyHint).toBe(true);
  });
});
