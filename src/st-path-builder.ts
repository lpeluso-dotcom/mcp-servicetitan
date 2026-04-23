// ============================================================
// st-path-builder.ts — Central ST API path + body normalizer.
//
// Applies all four memory-known corrections before any call reaches
// taylor-ai. Used by BOTH L4 tool handlers and the st_call escape hatch.
//
// Corrections:
//   1. /task-management/ → /taskmanagement/  (ST uses no hyphen)
//   2. Auto-inject /tenant/431848990/        (callers don't have to memorize the tenant ID)
//   3. On equipment PATCH bodies: isConfigurable → isConfigurableEquipment
//   4. On pricebook write bodies: useStaticPrice → useStaticPrices (plural)
// ============================================================

const TENANT_ID = '431848990';

// Pattern matching the various ST API prefixes that precede the tenant segment.
// Examples: /crm/v2/tenant/..., /jpm/v2/tenant/..., /pricebook/v2/tenant/...
const TENANT_RE = /^(\/[a-z]+\/v\d+\/)tenant\/[^/]+\//;

export interface NormalizedRequest {
  path: string;
  body: Record<string, unknown> | null;
}

export function normalizePath(rawPath: string): string {
  if (!rawPath.startsWith('/')) {
    throw new Error(`ST path must start with '/': ${rawPath}`);
  }

  // Correction 1: hyphenated task-management → taskmanagement
  let path = rawPath.replace(/\/task-management\//g, '/taskmanagement/');

  // Correction 2: inject tenant ID if missing.
  // Matches paths like /jpm/v2/ that are missing the tenant segment.
  if (!TENANT_RE.test(path)) {
    // Find the API prefix (e.g. /jpm/v2/) and insert /tenant/431848990/ after it.
    path = path.replace(/^(\/[a-z]+\/v\d+\/)/, `$1tenant/${TENANT_ID}/`);
  }

  // Strip trailing slash on non-ODATA paths (ST inconsistently 404s with trailing slash).
  if (!path.includes('/$query') && path.endsWith('/')) {
    path = path.slice(0, -1);
  }

  return path;
}

export function normalizeBody(body: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!body) return null;
  const out = { ...body };

  // Correction 3: isConfigurable → isConfigurableEquipment (equipment PATCH bodies)
  if ('isConfigurable' in out) {
    out['isConfigurableEquipment'] = out['isConfigurable'];
    delete out['isConfigurable'];
  }

  // Correction 4: useStaticPrice → useStaticPrices (pricebook write bodies)
  if ('useStaticPrice' in out) {
    out['useStaticPrices'] = out['useStaticPrice'];
    delete out['useStaticPrice'];
  }

  return out;
}

export function normalizeRequest(rawPath: string, body: Record<string, unknown> | null): NormalizedRequest {
  return {
    path: normalizePath(rawPath),
    body: normalizeBody(body),
  };
}
