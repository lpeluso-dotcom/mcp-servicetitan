// ============================================================
// sku-resolve.ts — resolve a pricebook SKU NAME against the D1 pricebook
// mirror before a write that resolves lines by name.
//
// WHY (asymmetry, not paranoia): on the invoice-items PATCH endpoint an
// unresolvable SKU fails LOUDLY — HTTP 500 "Sku (Name:) is not found." — so
// presence-validation is enough there. On POST /invoices (adjustment create)
// the failure mode is the opposite: a bad `skuName` is indistinguishable from
// a missing one, the line is dropped, and ST returns HTTP 200 with a ZERO-ITEM
// $0.00 adjustment invoice (real damage: 84402274). Adjustment invoices are
// NOT deletable via the ST API — cleanup needs the ServiceTitan UI. So the
// name has to be checked BEFORE the write, not diagnosed after it.
//
// FAIL-OPEN ON INFRASTRUCTURE, FAIL-CLOSED ON A REAL MISS. The mirror is a
// nightly D1 copy owned by another worker; if it is unreachable, erroring, or
// empty we must not block a legitimate write — we return `unavailable` and the
// caller surfaces that as an unverified-SKU note (the post-write verify-read
// is the backstop). Only a working mirror that definitively has no such SKU
// produces `not_found`, which the caller turns into a validation_error.
// ============================================================

import { queryD1 } from '../../d1-proxy';
import { codeVariants } from '../pricebook/search_pricebook_all';
import type { Env } from '../../env';

const SQL_FIND_SKU = `SELECT 'service' AS kind, code, name FROM pb_services WHERE code = ? OR name = ?
UNION ALL SELECT 'material' AS kind, code, name FROM pb_materials WHERE code = ? OR name = ?
UNION ALL SELECT 'equipment' AS kind, code, name FROM pb_equipment WHERE code = ? OR name = ?
LIMIT 1`;

// Only used on the miss path: distinguishes "mirror says this SKU does not
// exist" from "mirror is empty/broken, so it says that about everything".
const SQL_MIRROR_ALIVE = `SELECT COUNT(*) AS n FROM pb_services`;

export type SkuResolution =
  | { status: 'resolved'; skuName: string; matched: string; kind: string }
  | { status: 'not_found'; skuName: string }
  | { status: 'unavailable'; skuName: string; reason: string };

interface SkuRow {
  kind?: string;
  code?: string;
  name?: string;
}

export async function resolveSkuName(
  env: Env,
  skuName: string,
  correlation?: string,
): Promise<SkuResolution> {
  const opts = { correlation, tag: 'invoice:sku_resolve' };
  for (const variant of codeVariants(skuName)) {
    let rows: SkuRow[];
    try {
      rows = await queryD1<SkuRow>(env, SQL_FIND_SKU, [variant, variant, variant, variant, variant, variant], opts);
    } catch (err) {
      return { status: 'unavailable', skuName, reason: (err as Error).message };
    }
    if (rows.length > 0) {
      return { status: 'resolved', skuName, matched: rows[0].code ?? rows[0].name ?? variant, kind: rows[0].kind ?? 'unknown' };
    }
  }

  // No hit on any variant — confirm the mirror is actually populated before
  // calling that a miss, so an empty/stale mirror can't block every write.
  try {
    const alive = await queryD1<{ n?: number }>(env, SQL_MIRROR_ALIVE, [], opts);
    const n = Number(alive[0]?.n ?? 0);
    if (!Number.isFinite(n) || n <= 0) {
      return { status: 'unavailable', skuName, reason: 'D1 pricebook mirror is empty (pb_services has no rows)' };
    }
  } catch (err) {
    return { status: 'unavailable', skuName, reason: (err as Error).message };
  }

  return { status: 'not_found', skuName };
}
