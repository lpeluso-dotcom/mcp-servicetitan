#!/usr/bin/env bash
# ============================================================
# scripts/preflight.sh — pre-deploy integrity gate for mcp-servicetitan
# Pre-deploy integrity gate for a configured ServiceTitan proxy deployment.
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

# ── 0. Git alignment ─────────────────────────────────────────────
echo ""
echo "[0] Git alignment"

# Shim: shared script uses `ok`, this script uses `pass`
ok() { pass "$1"; }

GIT_PREFLIGHT="${GIT_PREFLIGHT:-}"
if [[ "${GITHUB_ACTIONS:-}" == "true" || "${CI:-}" == "true" ]]; then
  pass "git-alignment skipped (CI: post-merge commit is aligned with origin by definition)"
elif [[ -n "$GIT_PREFLIGHT" && -f "$GIT_PREFLIGHT" ]]; then
  # shellcheck source=/dev/null
  source "$GIT_PREFLIGHT"
  check_git_aligned "$ROOT"
else
  pass "git-alignment skipped (set GIT_PREFLIGHT to a local alignment script if desired)"
fi

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

# ── 2b. Smoke-sweep denylist integrity (QUA-1044) ───────────
# all-tools-smoke.sh invokes each selected tool with EMPTY ARGS against a live
# deploy target (prod included), so its selection is a safety boundary. It used
# to subtract a hand-maintained WRITES name list and sweep the remainder, which
# meant every write tool added after that list was written became CI-invocable
# on prod by default — it rotted twice (9 uncovered write tools, incl. two
# invoice money-writes and save_tech_debrief which bypasses the write gate;
# plus a phantom entry that was a filename). Pin the wire-derived,
# deny-by-default replacement so nobody reintroduces the pattern.
echo ""
echo "[2b] Smoke-sweep denylist (deny-by-default)"
SMOKE="scripts/all-tools-smoke.sh"
grep -qE 'annotations\.readOnlyHint\s*==\s*true' "$SMOKE" \
  && pass "sweep selects only readOnlyHint:true tools (wire-derived)" \
  || fail "$SMOKE no longer derives its read set from .annotations.readOnlyHint == true"
grep -qE '^WRITES=' "$SMOKE" \
  && fail "$SMOKE reintroduced a hand-maintained WRITES name list — derive from the registry annotation instead" \
  || pass "no hand-maintained WRITES list"
grep -q 'update_estimate_status' "$SMOKE" \
  && fail "$SMOKE references update_estimate_status — that is a FILENAME, not a tool name; it never matched anything" \
  || pass "no phantom update_estimate_status entry"

# ── 3. wrangler.toml config ─────────────────────────────────
echo ""
echo "[3] wrangler.toml config"

# audit S-8 (2026-08-01): the committed wrangler.toml published 8 real employee
# addresses in BOTH the prod and dev vars blocks, and src/oauth.ts carried 2 more
# as a hardcoded fallback. This repository is PUBLIC, and audit S-1 (open dynamic
# client registration) made that list a directly actionable phishing target.
# Real values now arrive at deploy time from GH secrets. Pin the invariant so a
# future edit cannot quietly put them back. gitleaks does not catch this: its
# rules match credential SHAPES, not PII lists.
echo ""
echo "[3b] No real employee PII committed (audit S-8)"
# IMPORTANT: this checks the COMMITTED content via `git show`, not the working
# file. In deploy.yml this step runs AFTER inject-deploy-config.py has rewritten
# the on-disk wrangler.toml with the real addresses from GH secrets — reading
# the working copy here would fail on every deploy by design. The invariant is
# "no real PII is committed", which is exactly what git records.
if git rev-parse --git-dir >/dev/null 2>&1; then
  COMMITTED_TOML="$(git show HEAD:wrangler.toml 2>/dev/null || echo '')"
  COMMITTED_OAUTH="$(git show HEAD:src/oauth.ts 2>/dev/null || echo '')"
  if [ -z "$COMMITTED_TOML" ] || [ -z "$COMMITTED_OAUTH" ]; then
    fail "could not read committed wrangler.toml / src/oauth.ts from git — cannot verify the S-8 invariant"
  else
    printf '%s' "$COMMITTED_TOML" | grep -q '@qualityservicecompany\.net' \
      && fail "committed wrangler.toml contains a real @qualityservicecompany.net address — this repo is PUBLIC; use the ALLOWED_EMAILS_PROD/DEV GitHub secrets" \
      || pass "committed wrangler.toml carries no real employee address"
    printf '%s' "$COMMITTED_OAUTH" | grep -q '@qualityservicecompany\.net' \
      && fail "committed src/oauth.ts contains a real @qualityservicecompany.net address — remove the hardcoded fallback" \
      || pass "committed src/oauth.ts carries no real employee address"
    printf '%s' "$COMMITTED_OAUTH" | grep -q 'DEFAULT_ALLOWED' \
      && fail "src/oauth.ts reintroduced DEFAULT_ALLOWED — the allow-list must fail CLOSED, not fall back to a committed list" \
      || pass "no DEFAULT_ALLOWED fallback"
    [ "$(printf '%s' "$COMMITTED_TOML" | grep -cE '^ALLOWED_EMAILS = "allowed@example\.com"$')" = "2" ] \
      && pass "ALLOWED_EMAILS placeholder committed in both prod and dev sections" \
      || fail "expected exactly 2 committed ALLOWED_EMAILS placeholder lines in wrangler.toml (prod + dev)"
  fi
else
  fail "not a git repository — cannot verify the S-8 committed-PII invariant"
fi
grep -q 'compatibility_flags = \["nodejs_compat"\]' wrangler.toml && pass "nodejs_compat flag set" || fail "nodejs_compat missing"
grep -q '\[observability\]' wrangler.toml && pass "observability block present" || fail "observability missing"
grep -q 'binding = "MCP_METRICS"' wrangler.toml && pass "MCP_METRICS AE binding" || fail "MCP_METRICS AE binding missing"
grep -q 'binding = "DB"' wrangler.toml && pass "D1 binding DB" || fail "D1 binding missing"
grep -q 'binding = "ST_PROXY"' wrangler.toml && pass "service binding ST_PROXY" || fail "ST_PROXY service binding missing"
grep -q 'binding = "PROXY_STATE"' wrangler.toml && pass "KV binding PROXY_STATE" || fail "PROXY_STATE KV binding missing"
grep -q 'placement = { mode = "smart" }' wrangler.toml && pass "smart placement" || fail "smart placement missing"

# F2: own D1 required
grep -q 'database_name = "mcp-servicetitan"' wrangler.toml && pass "own D1 mcp-servicetitan bound (prod)" || fail "own D1 mcp-servicetitan not bound in wrangler.toml"
grep -q 'database_name = "mcp-servicetitan-dev"' wrangler.toml && pass "own D1 mcp-servicetitan-dev bound (dev)" || fail "own D1 mcp-servicetitan-dev not bound in wrangler.toml"
if grep -q '00000000-0000-0000-0000-000000000000' wrangler.toml; then
  if [[ "$ENV" == "prod" ]]; then
    fail "prod D1 database_id is a placeholder - create and configure your D1 database before deploying to prod"
  else
    echo "  i  D1 database_id placeholder present (expected until you configure Cloudflare resources)"
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
SECRETS_REQUIRED=("MCP_SYNC_KEY" "SIRO_API_TOKEN" "ST_WEBHOOK_SECRET" "JWT_SECRET")
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
# Use vitest's real exit code (PIPESTATUS[0]) — NOT a substring grep. A grep for
# " failed" over the verbose log false-positives on any test that legitimately
# logs or names a failure path (e.g. a KV-fallback console.error, or a test named
# "...a sub-fetch failed to null"). Vitest exits non-zero iff a test actually fails.
npx vitest run --reporter=verbose 2>&1 | tee /tmp/mcp-st-vitest.log | tail -5
VITEST_RC=${PIPESTATUS[0]}
if [[ $VITEST_RC -eq 0 ]]; then
  pass "Vitest green"
else
  fail "Vitest failures (exit $VITEST_RC)"
fi

# ── 7. Secret scan (gitleaks) ─────────────────────────────
echo ""
echo "[7] Secret scan (gitleaks)"
if ! command -v gitleaks >/dev/null 2>&1; then
  fail "gitleaks not installed — install from https://github.com/gitleaks/gitleaks/releases and re-run. Secret scanning is mandatory before deploy."
else
  if gitleaks detect --no-git --source . -v 2>&1 | grep -q "no leaks found"; then
    pass "gitleaks: no secrets detected"
  else
    fail "gitleaks: potential secret leak detected — run 'gitleaks detect --no-git --source . -v' to review findings and update .gitleaksignore if they are test vectors"
  fi
fi

# ── 9. Inspector smoke (optional, gated REMOTE=1) ─────────
# Skipped by default so offline preflights don't hit the network.
# Pre-deploy: REMOTE=1 bash scripts/preflight.sh --env $ENV
echo ""
echo "[8] Inspector smoke"
if [[ "${REMOTE:-0}" == "1" ]]; then
  if bash scripts/inspector-smoke.sh "$ENV" >/tmp/mcp-st-smoke.log 2>&1; then
    pass "Inspector smoke 3/3 (see /tmp/mcp-st-smoke.log)"
  else
    fail "Inspector smoke failed (see /tmp/mcp-st-smoke.log)"
  fi
else
  echo "  ℹ  Skipped (set REMOTE=1 to run live smoke against $ENV)"
fi

# ── 10. Summary ────────────────────────────────────────────
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
