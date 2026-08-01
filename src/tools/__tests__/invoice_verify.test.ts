// ============================================================
// Unit tests for invoice-verify.ts — the post-write verification helpers.
//
// These helpers decode the REAL /api/st/write proxy envelope and ST's REAL
// read-side typing, both live-verified 2026-07-31:
//   - success envelope: {success:true, endpoint, method, response:<ST raw>}
//     where the adjustment create returns response as a BARE NUMBER
//     (84402274) and the items PATCH returns an empty body → {raw:""}.
//   - read-side numeric fields arrive as JSON STRINGS ("-13674.00",
//     "1.0000000000000000000", "0.0000000000").
// Every case here traces to an adversarial-review finding or a live incident.
// ============================================================

import { describe, it, expect } from 'vitest';
import {
  extractEntityId,
  intendedAmount,
  itemAmount,
  itemPrice,
  moneyEquals,
  proxyEnvelopeError,
  toMoney,
  verifyBackoffMs,
} from '../invoicing/invoice-verify';

describe('toMoney — read-side numeric coercion', () => {
  it('accepts numbers', () => {
    expect(toMoney(9771)).toBe(9771);
    expect(toMoney(-13674)).toBe(-13674);
    expect(toMoney(0)).toBe(0);
  });

  it('accepts ST string typing: money, high-precision quantity, negative money', () => {
    expect(toMoney('9771.00')).toBe(9771);
    expect(toMoney('-13674.00')).toBe(-13674);
    expect(toMoney('1.0000000000000000000')).toBe(1);
    expect(toMoney('0.0000000000')).toBe(0);
  });

  it('rejects junk: undefined, null, empty string, non-numeric, NaN/Infinity', () => {
    expect(toMoney(undefined)).toBeUndefined();
    expect(toMoney(null)).toBeUndefined();
    expect(toMoney('')).toBeUndefined();
    expect(toMoney('  ')).toBeUndefined();
    expect(toMoney('n/a')).toBeUndefined();
    expect(toMoney(NaN)).toBeUndefined();
    expect(toMoney(Infinity)).toBeUndefined();
    expect(toMoney({})).toBeUndefined();
    expect(toMoney(true)).toBeUndefined();
  });
});

describe('itemPrice / itemAmount — string-typed live reads', () => {
  it('reads a string price (the live shape that broke typeof-number verification)', () => {
    expect(itemPrice({ price: '-13674.00' })).toBe(-13674);
    expect(itemPrice({ price: '9771.00' })).toBe(9771);
  });

  it('falls back to unitPrice if a future read model uses the write-side name', () => {
    expect(itemPrice({ unitPrice: '42.00' })).toBe(42);
  });

  it('itemAmount multiplies string price × string quantity', () => {
    expect(itemAmount({ price: '9771.00', quantity: '1.0000000000000000000' })).toBe(9771);
    expect(itemAmount({ price: '-13674.00', quantity: '2.0000000000000000000' })).toBe(-27348);
  });

  it('absent price or quantity counts as 0, not a crash', () => {
    expect(itemAmount({ quantity: '1.00' })).toBe(0);
    expect(itemAmount({ price: '5.00' })).toBe(0);
  });

  it('intendedAmount over a write-side line', () => {
    expect(intendedAmount({ unitPrice: -9771, quantity: 1 })).toBe(-9771);
    expect(intendedAmount({ quantity: 3 })).toBe(0);
  });

  it('moneyEquals tolerates float noise at half a cent', () => {
    expect(moneyEquals(9771, 9771.004)).toBe(true);
    expect(moneyEquals(9771, 9771.006)).toBe(false);
  });
});

describe('extractEntityId — the REAL proxy envelope shapes', () => {
  it('adjustment create: bare-number response (the live shape: {response: 84402274})', () => {
    expect(extractEntityId({ success: true, endpoint: '/x', method: 'POST', response: 84402274 })).toBe(84402274);
  });

  it('numeric-string response', () => {
    expect(extractEntityId({ success: true, response: '84402274' })).toBe(84402274);
  });

  it('items PATCH empty body ({response:{raw:""}}) → undefined (verify goes by baseline diff)', () => {
    expect(extractEntityId({ success: true, response: { raw: '' } })).toBeUndefined();
  });

  it('object response with id', () => {
    expect(extractEntityId({ success: true, response: { id: 9001 } })).toBe(9001);
  });

  it('bare number / numeric string body', () => {
    expect(extractEntityId(84402274)).toBe(84402274);
    expect(extractEntityId('84402274')).toBe(84402274);
  });

  it('direct-ST/test shapes still work: {id}, {invoiceId}, {data:{id}}, {result:{id}}', () => {
    expect(extractEntityId({ id: 5 })).toBe(5);
    expect(extractEntityId({ invoiceId: 6 })).toBe(6);
    expect(extractEntityId({ data: { id: 7 } })).toBe(7);
    expect(extractEntityId({ result: { id: 8 } })).toBe(8);
  });

  it('junk yields undefined, never a fabricated id', () => {
    expect(extractEntityId(null)).toBeUndefined();
    expect(extractEntityId(true)).toBeUndefined();
    expect(extractEntityId({})).toBeUndefined();
    expect(extractEntityId({ response: 0 })).toBeUndefined();
    expect(extractEntityId({ response: -3 })).toBeUndefined();
    expect(extractEntityId('not-a-number')).toBeUndefined();
  });
});

describe('proxyEnvelopeError — failure signals a 200 can carry', () => {
  it('flags success:false, an error string, and the legacy ok:false', () => {
    expect(proxyEnvelopeError({ success: false, error: 'boom' })).toMatch(/failure envelope/);
    expect(proxyEnvelopeError({ error: 'ST API 409: conflict' })).toMatch(/ST API 409/);
    expect(proxyEnvelopeError({ ok: false, message: 'nope' })).toMatch(/nope/);
  });

  it('passes the real success envelope and non-object bodies', () => {
    expect(proxyEnvelopeError({ success: true, response: 84402274 })).toBeUndefined();
    expect(proxyEnvelopeError({ success: true, response: { raw: '' } })).toBeUndefined();
    expect(proxyEnvelopeError(84402274)).toBeUndefined();
    expect(proxyEnvelopeError(null)).toBeUndefined();
  });
});

describe('verifyBackoffMs — the read-after-write schedule seam', () => {
  it('honors a numeric-array override (the test seam)', () => {
    expect(verifyBackoffMs({ VERIFY_BACKOFF_MS: [0, 0] } as any)).toEqual([0, 0]);
  });

  it('falls back to the production 2s/10s default when unset or malformed', () => {
    expect(verifyBackoffMs({} as any)).toEqual([2000, 10000]);
    expect(verifyBackoffMs({ VERIFY_BACKOFF_MS: '2000,10000' } as any)).toEqual([2000, 10000]);
    expect(verifyBackoffMs({ VERIFY_BACKOFF_MS: ['2000'] } as any)).toEqual([2000, 10000]);
  });
});
