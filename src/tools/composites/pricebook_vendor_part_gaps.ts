// ============================================================
// pricebook_vendor_part_gaps — vendor-linkage gap audit (QUA-739).
//
// Finds cost-bearing (cost>0) materials + equipment with vendor-linkage
// gaps that break auto-purchasing:
//   - gap_type 'no_vendor_link': no primary vendor at all. Materials use
//     primary_vendor_id (NULL/0 = no link); equipment has no
//     primary_vendor_id column, only primary_vendor_name (NULL/blank = no
//     link) (live-probed 2026-07-09).
//   - gap_type 'no_part_number' (when includeMissingPartNumber=true,
//     default): materials that DO have a primary vendor linked, but the
//     matching entry in vendors_json has a null/empty vendorPart. JSON
//     parsing is guarded — a malformed vendors_json blob is treated the
//     same as "can't verify a part number", i.e. flagged, not thrown.
//
// vendor_part_xref and st_cost_review_queue are both empty in D1
// (live-probed 2026-07-09), so this detects INTRINSIC ServiceTitan gaps
// (a null primary_vendor_id / a null vendorPart on the linked vendor),
// NOT a cross-reference against an external vendor part catalog.
//
// HARD RULE: services are 100% dynamically priced by QSC (use_static_prices=0
// fleet-wide) and carry no vendor-cost linkage of this kind — this
// composite is scoped to materials + equipment only and never queries
// pb_services.
//
// Source: D1 (pb_materials + pb_equipment) via servicetitan-proxy /api/sql/read.
// ============================================================
import { z } from 'zod';
import { defaultShaper } from '../../response-shape';
import { readD1 } from '../../d1';
import type { ToolDef } from '../index';

interface Args {
  includeMissingPartNumber?: boolean;
}

interface NoVendorLinkRow {
  id: number;
  code: string | null;
  name: string | null;
  cost: number;
}

interface VendorJsonRow {
  id: number;
  code: string | null;
  name: string | null;
  cost: number;
  primary_vendor_id: number | null;
  primary_vendor_name: string | null;
  vendors_json: string | null;
}

interface VendorEntry {
  id?: number;
  vendorId?: number;
  vendorName?: string;
  vendorPart?: string | null;
  cost?: number;
  active?: boolean;
}

interface NoVendorLinkOut {
  id: number;
  code: string | null;
  name: string | null;
  cost: number;
  kind: 'material' | 'equipment';
  gap_type: 'no_vendor_link';
}

interface NoPartNumberOut {
  id: number;
  code: string | null;
  name: string | null;
  cost: number;
  kind: 'material';
  vendor_name: string | null;
  gap_type: 'no_part_number';
}

const EXAMPLE_CAP = 100;

const MATERIALS_NO_VENDOR_SQL = `SELECT id, code, name, cost
   FROM pb_materials
   WHERE active = 1 AND cost > 0 AND (primary_vendor_id IS NULL OR primary_vendor_id = 0)`;

const EQUIPMENT_NO_VENDOR_SQL = `SELECT id, code, name, cost
   FROM pb_equipment
   WHERE active = 1 AND cost > 0 AND (primary_vendor_name IS NULL OR trim(primary_vendor_name) = '')`;

const VENDORED_MATERIALS_SQL = `SELECT id, code, name, cost, primary_vendor_id, primary_vendor_name, vendors_json
   FROM pb_materials
   WHERE active = 1 AND cost > 0 AND primary_vendor_id > 0`;

function parseVendors(json: string | null): VendorEntry[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as VendorEntry[]) : [];
  } catch {
    return [];
  }
}

export const pricebook_vendor_part_gaps: ToolDef<Args> = {
  name: 'pricebook_vendor_part_gaps',
  description:
    'Finds cost-bearing (cost>0) materials + equipment with vendor-linkage gaps that break auto-purchasing: ' +
    'no primary vendor linked at all (gap_type "no_vendor_link" — materials via primary_vendor_id NULL/0, ' +
    'equipment via primary_vendor_name NULL/blank), and — when includeMissingPartNumber=true (default) — ' +
    'materials that DO have a primary vendor but no vendorPart recorded against it in vendors_json ' +
    '(gap_type "no_part_number"). vendor_part_xref is empty in D1, so this detects INTRINSIC ServiceTitan ' +
    'gaps (a null primary_vendor_id / a null vendorPart on the linked vendor), not a cross-reference against ' +
    'an external vendor part catalog. Use before setting up auto-purchasing or PO automation on a category, ' +
    'or when auditing why a reorder rule silently skipped an item. Scope is materials + equipment only — ' +
    'QSC prices every active service dynamically at invoice time (use_static_prices=0 fleet-wide) and ' +
    'services carry no vendor-cost linkage of this kind, so services are excluded entirely. ' +
    'Source: D1 pb_materials + pb_equipment.',
  stEndpoint: { method: 'GET', path: 'd1://pb_materials+pb_equipment', source: 'd1' },
  annotations: { readOnlyHint: true },
  zodSchema: {
    includeMissingPartNumber: z
      .boolean()
      .optional()
      .describe('Also check materials that have a vendor linked but no vendorPart recorded against it. Default true.'),
  },
  async handler(env, args, { correlation: _correlation }) {
    const includeMissingPartNumber = args.includeMissingPartNumber ?? true;

    const [materialsNoVendor, equipmentNoVendor] = await Promise.all([
      readD1<NoVendorLinkRow>(env, MATERIALS_NO_VENDOR_SQL, []),
      readD1<NoVendorLinkRow>(env, EQUIPMENT_NO_VENDOR_SQL, []),
    ]);

    const noVendorLink: NoVendorLinkOut[] = [
      ...materialsNoVendor.rows.map((r) => ({ ...r, kind: 'material' as const, gap_type: 'no_vendor_link' as const })),
      ...equipmentNoVendor.rows.map((r) => ({ ...r, kind: 'equipment' as const, gap_type: 'no_vendor_link' as const })),
    ].sort((a, b) => b.cost - a.cost);

    let noPartNumber: NoPartNumberOut[] = [];

    if (includeMissingPartNumber) {
      const { rows: vendoredMaterials } = await readD1<VendorJsonRow>(env, VENDORED_MATERIALS_SQL, []);
      for (const m of vendoredMaterials) {
        const vendors = parseVendors(m.vendors_json);
        const primary = vendors.find((v) => v.vendorId === m.primary_vendor_id) ?? vendors[0];
        const part = primary?.vendorPart;
        if (!primary || part === null || part === undefined || part === '') {
          noPartNumber.push({
            id: m.id,
            code: m.code,
            name: m.name,
            cost: m.cost,
            kind: 'material',
            vendor_name: primary?.vendorName ?? m.primary_vendor_name ?? null,
            gap_type: 'no_part_number',
          });
        }
      }
      noPartNumber = noPartNumber.sort((a, b) => b.cost - a.cost);
    }

    return {
      filters: { includeMissingPartNumber },
      summary: {
        no_vendor_link_count: noVendorLink.length,
        no_part_number_count: includeMissingPartNumber ? noPartNumber.length : null,
      },
      gaps: {
        no_vendor_link: noVendorLink.slice(0, EXAMPLE_CAP),
        no_part_number: noPartNumber.slice(0, EXAMPLE_CAP),
      },
      _composite: 'pricebook_vendor_part_gaps',
      _source: 'd1',
      _note:
        'vendor_part_xref is empty in D1, so this detects INTRINSIC ServiceTitan gaps (null primary_vendor_id ' +
        '/ null vendorPart on the linked vendor), not a cross-reference against an external vendor catalog.',
    };
  },
  transformResult: defaultShaper,
};
