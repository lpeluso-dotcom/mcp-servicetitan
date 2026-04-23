-- ============================================================
-- migrations/0001_baseline_down.sql
-- Rollback of 0001_baseline.sql.
-- Idempotent — safe to run multiple times, safe to run on partial apply.
-- ============================================================

DROP INDEX IF EXISTS idx_mv_margin_audit_expires;
DROP TABLE IF EXISTS mv_margin_audit;

DROP TABLE IF EXISTS mv_pricebook_health_services;

DROP INDEX IF EXISTS idx_mv_customer_snapshot_expires;
DROP TABLE IF EXISTS mv_customer_snapshot;

DROP INDEX IF EXISTS idx_endpoint_registry_domain;
DROP TABLE IF EXISTS endpoint_registry;

DROP INDEX IF EXISTS idx_confirm_tokens_expires;
DROP TABLE IF EXISTS confirmation_tokens;

DROP TABLE IF EXISTS mcp_roles;

DROP INDEX IF EXISTS idx_mcp_cache_expires;
DROP TABLE IF EXISTS mcp_cache;

DROP INDEX IF EXISTS idx_error_log_source;
DROP INDEX IF EXISTS idx_error_log_ts;
DROP TABLE IF EXISTS error_log;

DROP INDEX IF EXISTS idx_audit_log_surface_op;
DROP INDEX IF EXISTS idx_audit_log_correlation;
DROP INDEX IF EXISTS idx_audit_log_ts;
DROP TABLE IF EXISTS audit_log;

-- Last so the "migration applied" claim disappears only after data is gone.
DELETE FROM schema_migrations WHERE version = '0001_baseline';
DROP TABLE IF EXISTS schema_migrations;
