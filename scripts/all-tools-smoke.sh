#!/usr/bin/env bash
# ============================================================
# scripts/all-tools-smoke.sh — Comprehensive read-tool sweep
#
# Runs every READ tool exposed by mcp-servicetitan against a
# deployed worker, with empty args, and categorizes the response:
#
#   ok          tool returned a parseable success envelope
#   needs_args  tool returned a "missing required field" — healthy
#               (we're verifying the handler is wired, not arg shape)
#   fail        tool returned 5xx / not-found / parse error / no response
#
# Writes are excluded by name (defineWriteTool callers + hand-rolled
# st_create/st_patch/st_post + admin st_call). Goal: prove all read
# handlers are reachable and respond cleanly in v1.2 prod.
#
# Output: CSV at /tmp/mcp-st-all-tools-smoke-YYYYMMDD-HHMMSS.csv
# Returns 0 if zero "fail" entries; 1 otherwise.
#
# Usage:  bash scripts/all-tools-smoke.sh [dev|prod] [--actor <name>]
# Requires: MCP_SYNC_KEY in ~/.env, jq, npx
# ============================================================

set -uo pipefail

if [[ -f "$HOME/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$HOME/.env" 2>/dev/null || true
  set +a
fi

ENV_NAME="dev"
ACTOR="all-tools-smoke"
while [[ $# -gt 0 ]]; do
  case "$1" in
    dev|prod) ENV_NAME="$1"; shift ;;
    --actor) ACTOR="$2"; shift 2 ;;
    *) echo "usage: $0 [dev|prod] [--actor <name>]"; exit 2 ;;
  esac
done

case "$ENV_NAME" in
  dev)  URL="${MCP_URL:-https://mcp-servicetitan-dev.example.workers.dev/mcp}" ;;
  prod) URL="${MCP_URL:-https://mcp-servicetitan.example.workers.dev/mcp}" ;;
esac

[[ -z "${MCP_SYNC_KEY:-}" ]] && { echo "❌ MCP_SYNC_KEY not set"; exit 2; }
command -v jq >/dev/null || { echo "❌ jq required"; exit 2; }

# Write tools (excluded). Source: grep "defineWriteTool|durableWrite" src/tools/.
# Plus st_call (admin gateway) since it's role-gated and shouldn't be in default sweep.
WRITES="add_customer_note add_job_note assign_technicians book_job hold_appointment
reschedule_appointment update_estimate_status create_call_with_campaign
st_post_marketing_attribution create_recurring_service create_task st_call
st_create_material st_create_service st_patch_material st_patch_service"

OUT="/tmp/mcp-st-all-tools-smoke-$(date +%Y%m%d-%H%M%S).csv"
echo "tool,status,latency_ms,note" > "$OUT"

echo "============================================================"
echo "  All-tools smoke — env=$ENV_NAME actor=$ACTOR"
echo "  $URL"
echo "  CSV: $OUT"
echo "============================================================"

inspect() {
  npx @modelcontextprotocol/inspector --cli "$URL" \
    --transport http \
    --header "X-Sync-Key: $MCP_SYNC_KEY" \
    --header "X-Actor: $ACTOR" \
    --method "$@" 2>/dev/null
}

# 1. Fetch tools/list
echo ""
echo "Fetching tools/list…"
TOOLS_JSON="$(inspect tools/list)"
TOOL_NAMES="$(echo "$TOOLS_JSON" | jq -r '.tools[].name' 2>/dev/null)"
TOOL_COUNT="$(echo "$TOOL_NAMES" | grep -c .)"
[[ "$TOOL_COUNT" -lt 60 ]] && { echo "❌ tools/list returned only $TOOL_COUNT tools — abort"; exit 1; }
echo "  Got $TOOL_COUNT tools"

# 2. Filter to reads
READS=""
for TOOL in $TOOL_NAMES; do
  IS_WRITE=0
  for W in $WRITES; do
    [[ "$TOOL" == "$W" ]] && { IS_WRITE=1; break; }
  done
  [[ "$IS_WRITE" -eq 0 ]] && READS="$READS $TOOL"
done
READ_COUNT="$(echo "$READS" | wc -w)"
echo "  Filtered to $READ_COUNT reads ($((TOOL_COUNT - READ_COUNT)) writes excluded)"

# 3. Iterate reads
PASS=0; NEEDS_ARGS=0; FAIL=0
echo ""
for TOOL in $READS; do
  START_MS=$(date +%s%3N)
  RESULT="$(inspect tools/call --tool-name "$TOOL")"
  END_MS=$(date +%s%3N)
  LATENCY=$((END_MS - START_MS))

  TEXT="$(echo "$RESULT" | jq -r '.content[0].text // empty' 2>/dev/null)"
  IS_ERROR="$(echo "$RESULT" | jq -r '.isError // false' 2>/dev/null)"

  # Heuristic: any "input validation" / "invalid arguments" / "at least one of" /
  # "missing" / "required" pattern is a needs_args healthy response (handler is
  # wired; we just didn't pass valid args). Anything else is a real fail.
  ARG_PATTERN='input validation|invalid arguments|invalid_value|at least one of|required|missing|expected.*string|expected.*number|expected.*array|undefined.*field'

  if [[ -z "$TEXT" ]] && [[ "$IS_ERROR" != "true" ]]; then
    STATUS="fail"
    NOTE="no content/text in response"
    FAIL=$((FAIL+1))
  elif [[ "$IS_ERROR" == "true" ]] && (echo "$TEXT" | grep -qiE "$ARG_PATTERN"); then
    STATUS="needs_args"
    NOTE="$(echo "$TEXT" | head -c 80 | tr '\n,' '  ')"
    NEEDS_ARGS=$((NEEDS_ARGS+1))
  elif [[ "$IS_ERROR" == "true" ]]; then
    STATUS="fail"
    NOTE="$(echo "$TEXT" | head -c 120 | tr '\n,' '  ')"
    FAIL=$((FAIL+1))
  elif echo "$TEXT" | jq -e '.error // .ok==false // empty' >/dev/null 2>&1; then
    ERR="$(echo "$TEXT" | jq -r '.error.message // .error // .message // empty')"
    if echo "$ERR" | grep -qiE "$ARG_PATTERN"; then
      STATUS="needs_args"
      NOTE="$(echo "$ERR" | head -c 80 | tr '\n,' '  ')"
      NEEDS_ARGS=$((NEEDS_ARGS+1))
    else
      STATUS="fail"
      NOTE="$(echo "$ERR" | head -c 120 | tr '\n,' '  ')"
      FAIL=$((FAIL+1))
    fi
  else
    STATUS="ok"
    NOTE=""
    PASS=$((PASS+1))
  fi

  printf "  %-35s %-10s %5sms  %s\n" "$TOOL" "$STATUS" "$LATENCY" "$NOTE"
  echo "$TOOL,$STATUS,$LATENCY,\"$NOTE\"" >> "$OUT"
done

echo ""
echo "============================================================"
echo "  Summary: $PASS ok / $NEEDS_ARGS needs_args / $FAIL fail (of $READ_COUNT reads)"
echo "  CSV: $OUT"
echo "============================================================"
[[ "$FAIL" -gt 0 ]] && exit 1 || exit 0
