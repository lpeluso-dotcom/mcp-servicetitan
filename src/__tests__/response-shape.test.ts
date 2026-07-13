import { describe, it, expect } from 'vitest';
import {
  excludeFields,
  limitArrays,
  abbreviateKeys,
  defaultShaper,
  DEFAULT_EXCLUDED_FIELDS,
  RESERVED_KEYS,
} from '../response-shape';

describe('excludeFields', () => {
  it('strips default excluded fields recursively', () => {
    const input = {
      data: [{ id: 1, paginationToken: 'abc' }],
      requestId: 'req-1',
      _meta: { foo: 1 },
      keep: 'me',
    };
    expect(excludeFields(input)).toEqual({
      data: [{ id: 1 }],
      keep: 'me',
    });
  });

  it('respects custom field set', () => {
    const input = { a: 1, b: 2, c: 3 };
    expect(excludeFields(input, new Set(['b']))).toEqual({ a: 1, c: 3 });
  });

  it('passes through primitives and null', () => {
    expect(excludeFields(null)).toBe(null);
    expect(excludeFields(42)).toBe(42);
    expect(excludeFields('s')).toBe('s');
  });

  it('handles arrays of primitives', () => {
    expect(excludeFields([1, 2, 3])).toEqual([1, 2, 3]);
  });

  it('preserves a Date instance instead of corrupting it into {}', () => {
    const d = new Date('2026-01-01');
    const result = excludeFields(d);
    expect(result).toBeInstanceOf(Date);
    expect((result as Date).getTime()).toBe(d.getTime());
  });

  it('preserves a nested Date instance inside an object', () => {
    const d = new Date('2026-01-01');
    const input = { createdAt: d, keep: 'me' };
    const result = excludeFields(input) as { createdAt: Date; keep: string };
    expect(result.createdAt).toBeInstanceOf(Date);
    expect(result.createdAt.getTime()).toBe(d.getTime());
    expect(result.keep).toBe('me');
  });

  it('does not let a literal __proto__ data key pollute Object.prototype', () => {
    const input = JSON.parse('{"a":1,"__proto__":{"polluted":true}}');
    const result = excludeFields(input) as Record<string, unknown>;
    // The output itself must not have inherited the polluted property.
    expect((result as any).polluted).toBeUndefined();
    // Object.prototype must remain clean for every other object too.
    expect(({} as any).polluted).toBeUndefined();
    expect(result.a).toBe(1);
  });
});

describe('limitArrays', () => {
  it('caps a top-level array and adds a truncation marker', () => {
    const input = { items: [1, 2, 3, 4, 5], other: 'x' };
    expect(limitArrays(input, { items: 2 })).toEqual({
      items: [1, 2],
      items_truncated: { original_length: 5, returned: 2 },
      other: 'x',
    });
  });

  it('leaves arrays under the cap untouched', () => {
    const input = { items: [1, 2] };
    expect(limitArrays(input, { items: 5 })).toEqual({ items: [1, 2] });
  });

  it('ignores non-array values', () => {
    const input = { items: 'not-an-array' };
    expect(limitArrays(input, { items: 5 })).toEqual({ items: 'not-an-array' });
  });
});

describe('abbreviateKeys', () => {
  it('renames keys per map but never abbreviates reserved keys', () => {
    const input = { businessUnit: 'BU1', averageTicket: 100, id: 7, status: 'ok' };
    expect(abbreviateKeys(input, { businessUnit: 'bu', averageTicket: 'avgTicket', id: 'X', status: 'Y' }))
      .toEqual({ bu: 'BU1', avgTicket: 100, id: 7, status: 'ok' });
  });

  it('leaves keys without a mapping untouched', () => {
    const input = { foo: 1, bar: 2 };
    expect(abbreviateKeys(input, { foo: 'f' })).toEqual({ f: 1, bar: 2 });
  });
});

describe('defaultShaper', () => {
  it('strips DEFAULT_EXCLUDED_FIELDS by default', () => {
    expect(defaultShaper({ paginationToken: 'x', id: 1 })).toEqual({ id: 1 });
  });
});

describe('module constants', () => {
  it('DEFAULT_EXCLUDED_FIELDS includes ST pagination noise', () => {
    expect(DEFAULT_EXCLUDED_FIELDS.has('paginationToken')).toBe(true);
    expect(DEFAULT_EXCLUDED_FIELDS.has('requestId')).toBe(true);
    expect(DEFAULT_EXCLUDED_FIELDS.has('_meta')).toBe(true);
  });

  it('RESERVED_KEYS protects semantic fields', () => {
    expect(RESERVED_KEYS.has('id')).toBe(true);
    expect(RESERVED_KEYS.has('type')).toBe(true);
    expect(RESERVED_KEYS.has('active')).toBe(true);
    expect(RESERVED_KEYS.has('status')).toBe(true);
  });
});
