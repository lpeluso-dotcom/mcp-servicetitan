// src/observability/correlation.ts — W3C Trace Context mint/adopt.
// Ported verbatim from taylor-ai/src/guardrails/correlation.ts (Wave-0 §4 wire format):
// single 32-hex trace-id, 16-hex span-id per hop, adopt-not-remint on inbound.
export interface ResolvedTrace {
  traceId: string;
  spanId: string;
  adopted: boolean;
}
const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-(0[01])$/;
export function mintTraceId(): string {
  return crypto.randomUUID().replaceAll('-', '');
}
export function mintSpanId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}
export function resolveTrace(incomingTraceparent?: string): ResolvedTrace {
  if (incomingTraceparent) {
    const m = TRACEPARENT_RE.exec(incomingTraceparent.trim());
    if (m && m[1] !== '0'.repeat(32)) {
      return { traceId: m[1], spanId: mintSpanId(), adopted: true };
    }
  }
  return { traceId: mintTraceId(), spanId: mintSpanId(), adopted: false };
}
export function traceparent(traceId: string, spanId: string): string {
  return `00-${traceId}-${spanId}-01`;
}
