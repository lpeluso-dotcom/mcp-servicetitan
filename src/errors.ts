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
  | 'internal_error';

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
