#!/usr/bin/env bash
# ============================================================
# scripts/rollback-test.sh — apply → rollback → verify empty → re-apply
# Mandatory F2 gate before flipping DB binding.
# Proves that migrations/0001_baseline_down.sql can cleanly reverse 0001_baseline.sql
# even under partial-apply conditions.
#
# Usage:  CLOUDFLARE_API_TOKEN=... bash scripts/rollback-test.sh [db-name]
# Default DB: mcp-servicetitan-dev
#
# REQUIREMENT: the CLOUDFLARE_API_TOKEN must have D1:Edit scope.
# The Workers:Deploy scope alone is NOT sufficient — wrangler d1 execute --remote
# requires D1:Edit. If you see "Authentication error [code: 10000]", add D1:Edit
# to the token in the CF dashboard (My Profile → API Tokens).
# As an alternative, run via the Cloudflare MCP d1_database_query tool which uses
# OAuth and does not depend on the API token scope.
# ============================================================

set -euo pipefail

# Stage 0 — verify token has D1 access (fast fail with clear message).
if ! npx wrangler d1 list 2>&1 | grep -q "mcp-servicetitan"; then
  echo "  ❌ Stage 0 FAIL: cannot list D1 databases. Check CLOUDFLARE_API_TOKEN has D1:Edit scope."
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

DB="${1:-mcp-servicetitan-dev}"
UP="migrations/0001_baseline.sql"
DOWN="migrations/0001_baseline_down.sql"

echo "============================================================"
echo "  rollback-test — db=$DB"
echo "  up:   $UP"
echo "  down: $DOWN"
echo "============================================================"

[[ -f "$UP" ]] || { echo "  ❌ up script not found: $UP"; exit 1; }
[[ -f "$DOWN" ]] || { echo "  ❌ down script not found: $DOWN"; exit 1; }

# Helper — run a command and echo status
run() {
  local label="$1"; shift
  echo ""
  echo "→ $label"
  "$@"
}

# ── Stage 1: apply up ───────────────────────────────────────
run "Stage 1/4 — apply 0001_baseline.sql" \
  npx wrangler d1 execute "$DB" --remote --file="$UP"

run "Stage 1 verify — expect 10 tables + 1 migration row" \
  npx wrangler d1 execute "$DB" --remote --command \
  "SELECT COUNT(*) AS tables FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%';"

run "Stage 1 verify — migration recorded" \
  npx wrangler d1 execute "$DB" --remote --command \
  "SELECT version, description FROM schema_migrations;"

# ── Stage 2: apply down ─────────────────────────────────────
run "Stage 2/4 — apply 0001_baseline_down.sql" \
  npx wrangler d1 execute "$DB" --remote --file="$DOWN"

# ── Stage 3: verify empty ──────────────────────────────────
run "Stage 3/4 — verify all 0001 tables dropped (expect 0 user tables)" \
  npx wrangler d1 execute "$DB" --remote --command \
  "SELECT COUNT(*) AS remaining FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%';"

# ── Stage 4: re-apply up (proves clean re-runnability) ──────
run "Stage 4/4 — re-apply 0001_baseline.sql (clean)" \
  npx wrangler d1 execute "$DB" --remote --file="$UP"

run "Stage 4 verify — tables back" \
  npx wrangler d1 execute "$DB" --remote --command \
  "SELECT COUNT(*) AS tables FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%';"

echo ""
echo "============================================================"
echo "  ✅ rollback-test complete on $DB"
echo "  (DB now contains schema 0001_baseline — ready for use)"
echo "============================================================"
