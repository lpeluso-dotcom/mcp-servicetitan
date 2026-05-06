// Fields stripped from any response that opts into the default shaper.
// These are ST-API noise that LLM callers never need.
// NOTE: never strip semantic fields like id/type/active/status — those
// drive caller branching. See RESERVED_KEYS.
export const DEFAULT_EXCLUDED_FIELDS: ReadonlySet<string> = new Set([
  'paginationToken',
  'requestId',
  'eTag',
  '_links',
  '_meta',
]);

// Keys that abbreviateKeys() refuses to rename, even if a caller asks.
export const RESERVED_KEYS: ReadonlySet<string> = new Set([
  'id',
  'type',
  'active',
  'status',
]);

export function excludeFields<T>(value: T, fields: ReadonlySet<string> = DEFAULT_EXCLUDED_FIELDS): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((v) => excludeFields(v, fields)) as unknown as T;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (fields.has(k)) continue;
    out[k] = excludeFields(v, fields);
  }
  return out as T;
}

export function limitArrays<T extends Record<string, unknown>>(
  value: T,
  limits: Record<string, number>,
): T {
  const out: Record<string, unknown> = { ...value };
  for (const [k, n] of Object.entries(limits)) {
    const v = out[k];
    if (Array.isArray(v) && v.length > n) {
      out[k] = v.slice(0, n);
      out[`${k}_truncated`] = { original_length: v.length, returned: n };
    }
  }
  return out as T;
}

export function abbreviateKeys<T extends Record<string, unknown>>(
  value: T,
  abbrev: Record<string, string>,
): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    const target = RESERVED_KEYS.has(k) ? k : (abbrev[k] ?? k);
    out[target] = v;
  }
  return out as T;
}

// Convenience: the most common shape a tool wants — strip ST noise, leave everything else.
export function defaultShaper<T>(value: T): T {
  return excludeFields(value);
}
