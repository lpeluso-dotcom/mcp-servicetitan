// ============================================================
// errors.ts — Standardized MCP error shapes
// Shared error shape used by all MCP tool handlers.
// ============================================================

export type McpErrorCode =
  | 'auth_failed'
  | 'rate_limited'
  | 'validation_error'
  | 'not_found'
  | 'upstream_error'
  | 'timeout'
  | 'internal_error'
  // ── Post-write verification codes (2026-07-31) ──────────────
  // ServiceTitan's ASP.NET model binding silently drops unknown body fields
  // and still returns HTTP 200, so "the write returned 200" is NOT evidence
  // that anything was persisted. Every ST write whose whole point is a
  // monetary effect must re-read and assert the effect landed; these three
  // codes carry the distinction between the ways that assertion can fail.
  //   silent_noop       — the write reported success but the re-read shows the
  //                       effect is absent (items missing, item id not found).
  //   amount_mismatch   — the effect exists but the money is wrong (submitted
  //                       unitPrice not honored, e.g. recomputed or zeroed).
  //   verify_unavailable— the write may well have landed, but we could not
  //                       observe it (read-after-write lag, read error, ids
  //                       filter not honored, response carried no id). NEVER
  //                       auto-retry the write on this code.
  | 'silent_noop'
  | 'field_mismatch' // non-monetary invoice identity/description changed or dropped
  | 'amount_mismatch'
  | 'verify_unavailable';

export interface McpErrorResponse {
  ok: false;
  code: McpErrorCode;
  message: string;
  details?: unknown;
  retry_after_ms?: number;
  correlation?: string;
}

export class McpError extends Error {
  code: McpErrorCode;
  details?: unknown;
  retry_after_ms?: number;
  correlation?: string;

  constructor(
    code: McpErrorCode,
    message: string,
    opts: { details?: unknown; retry_after_ms?: number; correlation?: string } = {}
  ) {
    super(message);
    this.name = 'McpError';
    this.code = code;
    this.details = opts.details;
    this.retry_after_ms = opts.retry_after_ms;
    this.correlation = opts.correlation;
  }

  toResponse(): McpErrorResponse {
    return {
      ok: false,
      code: this.code,
      message: this.message,
      details: this.details,
      retry_after_ms: this.retry_after_ms,
      correlation: this.correlation,
    };
  }
}

/**
 * Map an HTTP status code from an upstream call into an MCP error code.
 * Used by tools when calling servicetitan-proxy's /api/st/read.
 */
export function mapUpstreamStatus(status: number): McpErrorCode {
  if (status === 401 || status === 403) return 'auth_failed';
  if (status === 404) return 'not_found';
  if (status === 422) return 'validation_error';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'upstream_error';
  return 'internal_error';
}
