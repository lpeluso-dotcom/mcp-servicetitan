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

# 2. Filter to reads — DENY BY DEFAULT, derived from the wire (QUA-1044).
#
# This sweep invokes each selected tool with EMPTY ARGS against a live deploy
# target (prod included), so the selection is a safety boundary, not a
# convenience. It used to subtract a hand-maintained WRITES name list and
# sweep everything else — which meant every write tool added after that list
# was written became CI-invocable on prod by default. It rotted twice: 9 real
# write tools uncovered (including the st_add_invoice_line_item /
# st_create_adjustment_invoice money-writes and save_tech_debrief, which
# bypasses the write gate and INSERTs straight into own-D1), plus a phantom
# entry that was a filename and had never matched anything. Only Zod
# required-field rejection stood between the sweep and a live write.
#
# Now: a tool is swept ONLY if it explicitly advertises readOnlyHint == true.
# Anything else — readOnlyHint false, absent, or a new tool that forgot its
# annotations — is excluded. Mirrors isSweepEligible() in src/tool-registry.ts;
# both are pinned by src/tools/__tests__/smoke_sweep_denylist.test.ts.
READS="$(echo "$TOOLS_JSON" | jq -r '.tools[] | select(.annotations.readOnlyHint == true) | .name' 2>/dev/null | tr '\n' ' ')"
READ_COUNT="$(echo "$READS" | wc -w)"
EXCLUDED=$((TOOL_COUNT - READ_COUNT))
echo "  Filtered to $READ_COUNT reads ($EXCLUDED excluded: writes + any tool not explicitly readOnlyHint:true)"

# A wire that carries no usable annotations would silently collapse the sweep
# to zero tools and still exit 0 — a green run that tested nothing. Fail loud.
[[ "$READ_COUNT" -lt 50 ]] && {
  echo "❌ only $READ_COUNT of $TOOL_COUNT tools are annotated readOnlyHint:true — refusing to run a near-empty sweep"
  exit 1
}

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

  # Heuristic: any "input validation" / "invalid arguments" / "requires|either" /
  # "missing" / "required" pattern is a needs_args healthy response (handler is
  # wired; we just didn't pass valid args). External-token config gaps
  # ("not configured") are also NON-blocking — a deploy didn't break them; they're
  # a standing provisioning state. Anything else is a real fail (404 / 500 / drift).
  ARG_PATTERN='input validation|invalid arguments|invalid_value|at least one of|requires|either|required|missing|expected.*string|expected.*number|expected.*array|undefined.*field|not configured|not_configured|not provisioned|not set on this worker'

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
