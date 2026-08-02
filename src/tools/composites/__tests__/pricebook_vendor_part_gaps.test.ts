// ============================================================
// pricebook_vendor_part_gaps — tests
//
// The handler issues up to four queries per call (materials no-vendor,
// equipment no-vendor, the fetchTableMax probe, vendored materials) — the
// mock routes by SQL shape rather than call order.
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

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

interface WireOpts {
  materialsNoVendor?: Array<Record<string, unknown>>;
  equipmentNoVendor?: Array<Record<string, unknown>>;
  vendored?: Array<Record<string, unknown>>;
  tableMax?: { pb_materials?: string | null; pb_equipment?: string | null };
}

/** Route all four query shapes; tableMax defaults to fresh (1h) per table. */
function wire(opts: WireOpts = {}) {
  readD1Mock.mockImplementation(async (_e: unknown, sql: string) => {
    if (/ AS t,/.test(sql)) {
      return {
        rows: [
          { t: 'pb_materials', m: opts.tableMax?.pb_materials !== undefined ? opts.tableMax.pb_materials : hoursAgo(1) },
          { t: 'pb_equipment', m: opts.tableMax?.pb_equipment !== undefined ? opts.tableMax.pb_equipment : hoursAgo(1) },
        ],
      };
    }
    if (/primary_vendor_id > 0/.test(sql)) return { rows: opts.vendored ?? [] };
    if (/FROM pb_equipment/.test(sql)) return { rows: opts.equipmentNoVendor ?? [] };
    return { rows: opts.materialsNoVendor ?? [] };
  });
}

/** The non-probe calls — what the pre-redesign tests reasoned about. */
function dataCalls() {
  return readD1Mock.mock.calls.filter(([, sql]) => !/ AS t,/.test(sql as string));
}

beforeEach(() => {
  readD1Mock.mockReset();
});

describe('pricebook_vendor_part_gaps', () => {
  it('issues SELECT-only queries scoped to pb_materials + pb_equipment only (no pb_services)', async () => {
    wire();

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
    wire();

    const out: any = await pricebook_vendor_part_gaps.handler(makeEnv(), { includeMissingPartNumber: false }, CTX);

    // Two gap queries; the fetchTableMax probe rides alongside.
    expect(dataCalls()).toHaveLength(2);
    expect(out.gaps.no_part_number).toEqual([]);
    expect(out.summary.no_part_number_count).toBeNull();
  });

  it('flags materials with no primary_vendor_id and equipment with no primary_vendor_name as no_vendor_link', async () => {
    wire({
      materialsNoVendor: [
        { id: 1, code: 'M1', name: 'Widget', cost: 40 },
        { id: 2, code: 'M2', name: 'Gadget', cost: 90 },
      ],
      equipmentNoVendor: [{ id: 3, code: 'E1', name: 'Condenser', cost: 500 }],
    });

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
    wire({
      vendored: [
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
    wire();

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

// ── Mirror-freshness disclosure (MB-1 / QUA-1141, v2 table-level) ────
// "Zero gaps" from an empty or frozen mirror is the most believable wrong
// answer this audit can give. This tool only ever SELECTs gap rows, so
// table-level liveness (the fetchTableMax probe) is the ONLY way emptiness
// can be vouched for: live tables → an honest clean audit; unprovable or
// frozen tables → unknown/stale.

describe('pricebook_vendor_part_gaps freshness disclosure (MB-1 / QUA-1141)', () => {
  it('every gap SELECT carries synced_at, and the probe covers both tables', async () => {
    wire();

    await pricebook_vendor_part_gaps.handler(makeEnv(), {}, CTX);

    for (const [, sql] of readD1Mock.mock.calls) {
      expect(sql).toContain('synced_at');
    }
    const probeSql = readD1Mock.mock.calls.map((c) => c[1] as string).find((s) => / AS t,/.test(s));
    expect(probeSql).toBeDefined();
    expect(probeSql!).toMatch(/MAX\(synced_at\)/);
    expect(probeSql!).toMatch(/FROM pb_materials/);
    expect(probeSql!).toMatch(/FROM pb_equipment/);
  });

  it('marks gap findings on live tables authoritative', async () => {
    wire({ materialsNoVendor: [{ id: 1, code: 'M1', name: 'Widget', cost: 40, synced_at: hoursAgo(2) }] });

    const out: any = await pricebook_vendor_part_gaps.handler(makeEnv(), {}, CTX);

    expect(out._mirror_table).toBe('pb_materials+pb_equipment');
    expect(out._freshness).toBe('fresh');
    expect(out.summary.metrics_are_authoritative).toBe(true);
    expect(out._warning).toBeUndefined();
  });

  it('an all-empty read on LIVE tables is an honest clean audit (F5)', async () => {
    wire();

    const out: any = await pricebook_vendor_part_gaps.handler(makeEnv(), {}, CTX);

    expect(out.summary.no_vendor_link_count).toBe(0);
    expect(out.summary.metrics_are_authoritative).toBe(true);
    expect(out._freshness).toBe('fresh');
    expect(out._empty).toBe(true);
    expect(out._warning).toBeUndefined();
  });

  it('an all-empty read on an UNPROVABLE mirror stays unknown — zero gaps is not proof of zero gaps', async () => {
    wire({ tableMax: { pb_materials: null, pb_equipment: null } });

    const out: any = await pricebook_vendor_part_gaps.handler(makeEnv(), {}, CTX);

    expect(out.summary.no_vendor_link_count).toBe(0);
    expect(out.summary.metrics_are_authoritative).toBe(false);
    expect(out._freshness).toBe('unknown');
    expect(out._empty).toBe(true);
    expect(out._warning).toMatch(/not proof/i);
  });

  it('a frozen table is flagged unknown (quiet-or-frozen) by name even when its sibling is fresh (F2)', async () => {
    wire({
      materialsNoVendor: [{ id: 1, code: 'M1', name: 'Widget', cost: 40, synced_at: hoursAgo(24 * 20) }],
      tableMax: { pb_equipment: hoursAgo(24 * 20) },
    });

    const out: any = await pricebook_vendor_part_gaps.handler(makeEnv(), {}, CTX);

    expect(out._freshness).toBe('unknown');
    expect(out.summary.metrics_are_authoritative).toBe(false);
    expect(out._warning).toMatch(/no row change in|indistinguishable/);
    expect(out._warning).toMatch(/pb_equipment/);
    expect(out._tables.pb_materials.freshness).toBe('fresh');
  });

  it('gap rows do not leak synced_at — it feeds the stamp, not the payload', async () => {
    wire({ materialsNoVendor: [{ id: 1, code: 'M1', name: 'Widget', cost: 40, synced_at: hoursAgo(1) }] });

    const out: any = await pricebook_vendor_part_gaps.handler(makeEnv(), {}, CTX);

    expect(out.gaps.no_vendor_link[0]).not.toHaveProperty('synced_at');
  });
});
