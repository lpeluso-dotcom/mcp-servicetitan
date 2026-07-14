// src/observability/correlation.test.ts
// Ported verbatim from qsc-hopper-phoenix/src/observability/correlation.test.ts —
// correlation.ts itself is a verbatim port (Wave-0 §4 wire format), so its test
// travels with it unchanged.
import { describe, it, expect } from 'vitest';
import { mintTraceId, mintSpanId, resolveTrace, traceparent } from './correlation';

describe('correlation', () => {
  it('mints a 32-hex trace id and 16-hex span id', () => {
    expect(mintTraceId()).toMatch(/^[0-9a-f]{32}$/);
    expect(mintSpanId()).toMatch(/^[0-9a-f]{16}$/);
  });
  it('adopts a well-formed inbound traceparent trace id, mints a fresh span id', () => {
    const tp = '00-1234567890abcdef1234567890abcdef-1122334455667788-01';
    const r = resolveTrace(tp);
    expect(r.traceId).toBe('1234567890abcdef1234567890abcdef');
    expect(r.adopted).toBe(true);
    expect(r.spanId).toMatch(/^[0-9a-f]{16}$/);
  });
  it('mints fresh on missing/malformed/all-zero traceparent', () => {
    expect(resolveTrace(undefined).adopted).toBe(false);
    expect(resolveTrace('garbage').adopted).toBe(false);
    expect(resolveTrace('00-' + '0'.repeat(32) + '-1122334455667788-01').adopted).toBe(false);
  });
  it('formats a traceparent header', () => {
    expect(traceparent('a'.repeat(32), 'b'.repeat(16))).toBe(`00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`);
  });
});
