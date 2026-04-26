#!/usr/bin/env bash
# ============================================================
# scripts/preflight.sh — pre-deploy integrity gate for mcp-servicetitan
# Mirrors taylor-ai's preflight pattern (27-check gate).
# F1: minimal — covers build + test + binding presence.
# F2/F3/H13 each add checks.
#
# Usage:  CLOUDFLARE_API_TOKEN=... bash scripts/preflight.sh [--env dev|prod]
# Returns 0 if all checks pass; non-zero on any failure.
# ============================================================

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ENV="dev"
if [[ "${1-}" == "--env" && -n "${2-}" ]]; then
  ENV="$2"
fi

PASS=0
FAIL=0
fail() { echo "  ❌ $1"; FAIL=$((FAIL+1)); }
pass() { echo "  ✅ $1"; PASS=$((PASS+1)); }

echo "============================================================"
echo "  mcp-servicetitan preflight — env=$ENV"
echo "============================================================"

# ── 1. Deps + lockfile ──────────────────────────────────────
echo ""
echo "[1] Dependencies"
[[ -f package.json ]] && pass "package.json present" || fail "package.json missing"
[[ -f package-lock.json ]] && pass "package-lock.json present" || fail "lockfile missing"
[[ -d node_modules/agents ]] && pass "agents SDK installed" || fail "agents SDK missing (npm install)"
[[ -d node_modules/@modelcontextprotocol/sdk ]] && pass "@modelcontextprotocol/sdk installed" || fail "MCP SDK missing"
[[ -d node_modules/zod ]] && pass "zod installed" || fail "zod missing"

# ── 2. Source integrity (protected modules) ─────────────────
echo ""
echo "[2] Protected source files"
for f in src/index.ts src/tool-registry.ts src/tools/index.ts src/obs.ts src/env.ts src/auth.ts src/errors.ts src/cache.ts src/siro.ts; do
  [[ -f "$f" ]] && pass "$f present" || fail "$f missing"
done

# ── 3. wrangler.toml config ─────────────────────────────────
echo ""
echo "[3] wrangler.toml config"
grep -q 'compatibility_flags = \["nodejs_compat"\]' wrangler.toml && pass "nodejs_compat flag set" || fail "nodejs_compat missing"
grep -q '\[observability\]' wrangler.toml && pass "observability block present" || fail "observability missing"
grep -q 'binding = "MCP_METRICS"' wrangler.toml && pass "MCP_METRICS AE binding" || fail "MCP_METRICS AE binding missing"
grep -q 'binding = "DB"' wrangler.toml && pass "D1 binding DB" || fail "D1 binding missing"
grep -q 'binding = "TAYLOR_AI"' wrangler.toml && pass "service binding TAYLOR_AI" || fail "TAYLOR_AI service binding missing"
grep -q 'binding = "TAI_STATE"' wrangler.toml && pass "KV binding TAI_STATE" || fail "TAI_STATE KV binding missing"
grep -q 'placement = { mode = "smart" }' wrangler.toml && pass "smart placement" || fail "smart placement missing"

# F2: own D1 required
grep -q 'database_name = "qsc-mcp-st"' wrangler.toml && pass "F2: own D1 qsc-mcp-st bound (prod)" || fail "own D1 qsc-mcp-st not bound in wrangler.toml"
grep -q 'database_name = "qsc-mcp-st-dev"' wrangler.toml && pass "F2: own D1 qsc-mcp-st-dev bound (dev)" || fail "own D1 qsc-mcp-st-dev not bound in wrangler.toml"
if grep -q 'PROD_DB_ID_PLACEHOLDER' wrangler.toml; then
  if [[ "$ENV" == "prod" ]]; then
    fail "prod D1 database_id is PROD_DB_ID_PLACEHOLDER — create qsc-mcp-st before deploying to prod"
  else
    echo "  ℹ  prod D1 database_id placeholder present (expected — qsc-mcp-st not yet created)"
  fi
else
  pass "prod D1 database_id is set"
fi

# F3 additions — check for actual binding declaration, not just mention in comments.
if grep -q 'class_name = "StRateLimiter"' wrangler.toml; then
  pass "F3: StRateLimiter DO bound"
else
  echo "  ℹ  F3 pending: StRateLimiter DO not yet bound"
fi
if grep -q 'class_name = "CustomerSnapshotSingleflight"' wrangler.toml; then
  pass "F3: CustomerSnapshotSingleflight DO bound"
else
  echo "  ℹ  F3 pending: CustomerSnapshotSingleflight DO not yet bound"
fi

# ── 4. Required secrets (names only; secret values are never echoed) ─
echo ""
echo "[4] Required secrets (via wrangler secret put --env $ENV)"
SECRETS_REQUIRED=("MCP_SYNC_KEY" "SIRO_API_TOKEN")
for s in "${SECRETS_REQUIRED[@]}"; do
  echo "  ℹ  Expect: $s (verify manually via 'wrangler secret list --env $ENV')"
done

# ── 5. TypeScript build ────────────────────────────────────
echo ""
echo "[5] TypeScript typecheck"
if npx tsc --noEmit 2>&1 | tee /tmp/mcp-st-tsc.log | tail -5; then
  if grep -q "error TS" /tmp/mcp-st-tsc.log; then
    fail "TypeScript errors detected"
  else
    pass "tsc --noEmit clean"
  fi
else
  fail "tsc --noEmit failed"
fi

# ── 6. Tests ───────────────────────────────────────────────
echo ""
echo "[6] Vitest"
if npx vitest run 2>&1 | tee /tmp/mcp-st-vitest.log | tail -5; then
  if grep -q "failed" /tmp/mcp-st-vitest.log; then
    fail "Vitest failures"
  else
    pass "Vitest green"
  fi
else
  fail "Vitest run failed"
fi

# ── 7. Inspector smoke (optional, gated REMOTE=1) ─────────
# Skipped by default so offline preflights don't hit the network.
# Pre-deploy: REMOTE=1 bash scripts/preflight.sh --env $ENV
echo ""
echo "[7] Inspector smoke"
if [[ "${REMOTE:-0}" == "1" ]]; then
  if bash scripts/inspector-smoke.sh "$ENV" >/tmp/mcp-st-smoke.log 2>&1; then
    pass "Inspector smoke 3/3 (see /tmp/mcp-st-smoke.log)"
  else
    fail "Inspector smoke failed (see /tmp/mcp-st-smoke.log)"
  fi
else
  echo "  ℹ  Skipped (set REMOTE=1 to run live smoke against $ENV)"
fi

# ── 8. Summary ─────────────────────────────────────────────
echo ""
echo "============================================================"
echo "  $PASS passed, $FAIL failed"
echo "============================================================"
if [[ $FAIL -gt 0 ]]; then
  echo "  ⛔ Preflight FAILED — do not deploy."
  exit 1
fi
echo "  ✅ Preflight green for $ENV. Safe to: npx wrangler deploy --env $ENV"
exit 0
