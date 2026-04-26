#!/usr/bin/env bash
# ============================================================
# scripts/inspector-smoke.sh — F1.5 MCP Inspector smoke harness
#
# Drives @modelcontextprotocol/inspector --cli against a deployed
# mcp-servicetitan worker (dev or prod). Three checks:
#   1. tools/list returns >= 60 tools (62 default-role baseline,
#      63 admin-role; we skip role-aware count and use a floor)
#   2. read tool round-trip: st_list_customers pageSize=1
#   3. write tool dryRun envelope: add_customer_note returns a
#      confirmation_token without touching ServiceTitan
#
# Usage:  bash scripts/inspector-smoke.sh [dev|prod]
# Returns 0 if all checks pass; 1 on any failure.
#
# Requires: MCP_SYNC_KEY in env (or ~/.env). Reads jq.
# ============================================================

set -uo pipefail

# Source ~/.env so MCP_SYNC_KEY is available without manual export.
# `|| true` because line-1 garbage in ~/.env (saw "cid.xxx#" in
# Luke's setup) shouldn't abort us — we only need the K=V pairs.
if [[ -f "$HOME/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$HOME/.env" 2>/dev/null || true
  set +a
fi

ENV_NAME="${1:-dev}"
case "$ENV_NAME" in
  dev)  URL="https://mcp-servicetitan-dev.lpeluso.workers.dev/mcp" ;;
  prod) URL="https://mcp-servicetitan.lpeluso.workers.dev/mcp" ;;
  *) echo "usage: $0 [dev|prod]"; exit 2 ;;
esac

if [[ -z "${MCP_SYNC_KEY:-}" ]]; then
  echo "❌ MCP_SYNC_KEY not set (export it or add to ~/.env)"
  exit 2
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "❌ jq is required"
  exit 2
fi

PASS=0; FAIL=0
fail() { echo "  ❌ $1"; FAIL=$((FAIL+1)); }
pass() { echo "  ✅ $1"; PASS=$((PASS+1)); }

inspect() {
  # Inspector CLI silently emits stderr noise when ~/.env has a bad line;
  # we capture stdout only. --cli + positional URL is the working invocation.
  npx @modelcontextprotocol/inspector --cli "$URL" \
    --transport http \
    --header "X-Sync-Key: $MCP_SYNC_KEY" \
    --method "$@" 2>/dev/null
}

echo "============================================================"
echo "  Inspector smoke — env=$ENV_NAME"
echo "  $URL"
echo "============================================================"

# ── 1. tools/list ──────────────────────────────────────────
echo ""
echo "[1] tools/list"
TOOLS_JSON="$(inspect tools/list)"
COUNT="$(echo "$TOOLS_JSON" | jq '.tools | length' 2>/dev/null || echo 0)"
EXPECTED_FLOOR=60
if [[ "$COUNT" -ge "$EXPECTED_FLOOR" ]]; then
  pass "tools/list returned $COUNT tools (>= $EXPECTED_FLOOR floor)"
else
  fail "tools/list returned $COUNT, expected >= $EXPECTED_FLOOR"
  echo "    payload: $(echo "$TOOLS_JSON" | head -c 300)"
fi

# ── 2. Read round-trip — st_list_customers pageSize=1 ──────
echo ""
echo "[2] tools/call st_list_customers (pageSize=1)"
READ_RESULT="$(inspect tools/call --tool-name st_list_customers --tool-arg pageSize=1)"
READ_TEXT="$(echo "$READ_RESULT" | jq -r '.content[0].text // empty' 2>/dev/null)"
if [[ -n "$READ_TEXT" ]] && echo "$READ_TEXT" | jq -e '.data | length >= 1' >/dev/null 2>&1; then
  CUST_NAME="$(echo "$READ_TEXT" | jq -r '.data[0].name')"
  pass "st_list_customers returned data (first row: $CUST_NAME)"
else
  fail "st_list_customers did not return parsable data"
  echo "    payload: $(echo "$READ_RESULT" | head -c 300)"
fi

# ── 3. Write dryRun envelope — add_customer_note ───────────
# The default behavior on write tools is dryRun=true. The envelope must
# include a confirmation_token and expires_in_seconds so a confirm-call
# can actually execute.
echo ""
echo "[3] tools/call add_customer_note (default dryRun)"
WRITE_RESULT="$(inspect tools/call --tool-name add_customer_note --tool-arg customerId=261837 --tool-arg note=smoke)"
WRITE_TEXT="$(echo "$WRITE_RESULT" | jq -r '.content[0].text // empty' 2>/dev/null)"
if [[ -n "$WRITE_TEXT" ]] \
   && echo "$WRITE_TEXT" | jq -e '.dryRun == true' >/dev/null 2>&1 \
   && echo "$WRITE_TEXT" | jq -e '.confirmation_token | type == "string" and length > 32' >/dev/null 2>&1 \
   && echo "$WRITE_TEXT" | jq -e '.expires_in_seconds == 900' >/dev/null 2>&1; then
  pass "add_customer_note returned dryRun envelope with token + 900s expiry"
else
  fail "add_customer_note dryRun envelope missing required fields"
  echo "    payload: $(echo "$WRITE_RESULT" | head -c 400)"
fi

echo ""
echo "============================================================"
echo "  Inspector smoke: $PASS passed, $FAIL failed"
echo "============================================================"
[[ $FAIL -gt 0 ]] && exit 1 || exit 0
