-- ─── Phoenix tracing span queue (mcp-servicetitan's own D1) ──────────────────
-- One root span per MCP tool call (see src/observability/tracing.ts,
-- traceTool()). Same shape as the estate's other otel_span_queue tables
-- (taylor-ai migrations 0108+0110, qsc-hopper woz-0059) — mcp-servicetitan
-- does NOT share taylor-ai's queue; this is its own table, drained by its own
-- relay step later. service_name defaults to 'mcp-servicetitan' since this
-- worker is the only writer. Never populated with raw tool args/results —
-- attrs_json carries only correlation id, role, actor, and status flags.
CREATE TABLE IF NOT EXISTS otel_span_queue (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              INTEGER NOT NULL,
  trace_id        TEXT NOT NULL,
  span_id         TEXT NOT NULL,
  parent_span_id  TEXT,
  service_name    TEXT NOT NULL DEFAULT 'mcp-servicetitan',
  operation       TEXT NOT NULL,
  qsc_actor       TEXT NOT NULL DEFAULT 'luke',
  qsc_run_kind    TEXT NOT NULL,
  status          TEXT NOT NULL,
  latency_ms      INTEGER,
  input_redacted  TEXT,
  output_redacted TEXT,
  attrs_json      TEXT,
  shipped         INTEGER NOT NULL DEFAULT 0,
  shipped_at      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_otel_span_queue_unshipped ON otel_span_queue(shipped, ts);
