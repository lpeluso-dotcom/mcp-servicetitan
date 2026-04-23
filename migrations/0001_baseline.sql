-- ============================================================
-- migrations/0001_baseline.sql
-- Baseline schema for qsc-mcp-st (own D1, split from taylor-ai shared DB).
-- F2 of the v1.0 super-MCP upgrade.
--
-- IMPORTANT: D1 does NOT wrap CREATE statements in a cross-statement
-- transaction. Each CREATE either succeeds or fails independently.
-- The paired 0001_baseline_down.sql must be idempotent so a partial
-- apply can be cleaned up with a single down-run.
-- ============================================================

-- ─── Self-tracking ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL,
  description TEXT
);

-- ─── Observability (ported from taylor-ai shared DB) ────────
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  actor TEXT NOT NULL,
  surface TEXT NOT NULL,
  operation TEXT NOT NULL,
  target_id TEXT,
  dry_run INTEGER DEFAULT 0,
  payload TEXT,
  result TEXT,
  status TEXT NOT NULL,
  latency_ms INTEGER,
  correlation TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_log_ts ON audit_log(ts);
CREATE INDEX IF NOT EXISTS idx_audit_log_correlation ON audit_log(correlation);
CREATE INDEX IF NOT EXISTS idx_audit_log_surface_op ON audit_log(surface, operation);

CREATE TABLE IF NOT EXISTS error_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  source TEXT NOT NULL,
  severity TEXT NOT NULL,
  message TEXT NOT NULL,
  stack TEXT,
  context TEXT,
  alerted INTEGER DEFAULT 0,
  correlation TEXT
);
CREATE INDEX IF NOT EXISTS idx_error_log_ts ON error_log(ts);
CREATE INDEX IF NOT EXISTS idx_error_log_source ON error_log(source);

-- ─── Read-through cache (ported) ────────────────────────────
CREATE TABLE IF NOT EXISTS mcp_cache (
  ns TEXT NOT NULL,
  k TEXT NOT NULL,
  value TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (ns, k)
);
CREATE INDEX IF NOT EXISTS idx_mcp_cache_expires ON mcp_cache(expires_at);

-- ─── Role gate (F2) ─────────────────────────────────────────
-- key_hash: SHA-256 of the X-Sync-Key value, hex-encoded.
-- Never store the raw sync key.
CREATE TABLE IF NOT EXISTS mcp_roles (
  key_hash TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('admin', 'default')),
  owner TEXT,
  created_at INTEGER NOT NULL,
  note TEXT
);

-- ─── Write-gate state (F3 populates; F2 creates schema) ─────
-- Short-lived HMAC tokens for two-step dryRun → confirm flow.
-- TTL enforced at query time (expires_at < now filter).
CREATE TABLE IF NOT EXISTS confirmation_tokens (
  token_hash TEXT PRIMARY KEY,
  tool TEXT NOT NULL,
  args_hash TEXT NOT NULL,
  actor TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  correlation TEXT
);
CREATE INDEX IF NOT EXISTS idx_confirm_tokens_expires ON confirmation_tokens(expires_at);

-- ─── L3 st_call endpoint allowlist (T9 populates; F2 creates schema) ─
-- Optional safety net derived from Titanpy source.
CREATE TABLE IF NOT EXISTS endpoint_registry (
  path_pattern TEXT PRIMARY KEY,
  methods TEXT NOT NULL,                -- CSV: GET,POST,PATCH,...
  domain TEXT NOT NULL,                 -- crm | jpm | pricebook | ...
  safe_for_anonymous INTEGER DEFAULT 0,
  requires_admin INTEGER DEFAULT 1,
  source TEXT,                          -- 'titanpy' | 'manual' | 'st-doc-2026-04'
  added_at INTEGER NOT NULL,
  note TEXT
);
CREATE INDEX IF NOT EXISTS idx_endpoint_registry_domain ON endpoint_registry(domain);

-- ─── Composite materialized views (C10–C12 populate; F2 creates schema) ─
CREATE TABLE IF NOT EXISTS mv_customer_snapshot (
  customer_id INTEGER PRIMARY KEY,
  snapshot TEXT NOT NULL,                -- JSON blob of the composite result
  computed_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  source_version TEXT                    -- schema version of the snapshot
);
CREATE INDEX IF NOT EXISTS idx_mv_customer_snapshot_expires ON mv_customer_snapshot(expires_at);

CREATE TABLE IF NOT EXISTS mv_pricebook_health_services (
  snapshot_id TEXT PRIMARY KEY,          -- typically ISO-date
  computed_at INTEGER NOT NULL,
  service_count INTEGER,
  issues TEXT,                           -- JSON array of per-service issues
  summary TEXT                           -- JSON rollup
);

CREATE TABLE IF NOT EXISTS mv_margin_audit (
  bu TEXT NOT NULL,
  from_date TEXT NOT NULL,
  to_date TEXT NOT NULL,
  computed_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  rollup TEXT NOT NULL,                  -- JSON: top-line margin + outliers + drill-down
  PRIMARY KEY (bu, from_date, to_date)
);
CREATE INDEX IF NOT EXISTS idx_mv_margin_audit_expires ON mv_margin_audit(expires_at);

-- ─── Record the migration ─────────────────────────────────
INSERT OR IGNORE INTO schema_migrations (version, applied_at, description)
  VALUES ('0001_baseline', strftime('%s','now') * 1000, 'mcp-servicetitan v1.0 baseline — own-D1 audit/error/cache/roles/tokens/registry/composite caches');
