#!/usr/bin/env bash
# ============================================================
# probe-connector-guards.sh — re-runnable negative controls for the
# connector surface of BOTH QSC MCP workers.
#
# Written 2026-08-01 during the TAI connector verification pass, which found
# that the guards below were "configured but never proven" — and that the one
# prior reproducibility gate (QUA-1026's `scratchpad/baseline-probe.sh`) had
# been left in a scratchpad and was gone, taking the gate with it. This script
# lives in the repo so that cannot happen again (QUA-1119).
#
# Every check states its PASS condition. A check that cannot fail is not a
# control — so each one here is written to fail loudly on the pre-fix state.
#
#   usage:  bash scripts/probe-connector-guards.sh
#   exit:   0 = all pass, 1 = at least one guard failed
#
# Needs no credentials. Every probe is an UNAUTHENTICATED negative control —
# that is the point: these assert what an attacker without a key gets.
# ============================================================
set -uo pipefail

ST="${ST_BASE:-https://mcp-servicetitan.lpeluso.workers.dev}"
QBO="${QBO_BASE:-https://qsc-hopper.lpeluso.workers.dev}"
CURL=(curl -s --max-time 25)
FAILED=0
PASSED=0

pass() { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASSED=$((PASSED + 1)); }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; printf '        expected: %s\n        actual:   %s\n' "$2" "$3"; FAILED=$((FAILED + 1)); }
head_() { printf '\n\033[1m%s\033[0m\n' "$1"; }

code_of() { "${CURL[@]}" -o /dev/null -w '%{http_code}' "$@"; }

# ── 1. /c/<token>/mcp must be GONE, not merely key-gated ────────────────────
# QUA-1117 item 3. 401 means the route is still compiled and reachable, and is
# disabled only by an unset secret. On TAI-ST a URL token carries its OWN role
# (src/index.ts), so a token minted role:'default' would reach every write tool
# and bypass the read-only guarantee entirely. PASS is 404.
head_ "1. /c/<token>/mcp is removed (PASS = 404, not 401)"
for base in "$ST" "$QBO"; do
  for tok in bogus-token-12345 x; do
    c=$(code_of -X POST "$base/c/$tok/mcp" -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')
    if [ "$c" = "404" ]; then pass "$base/c/$tok/mcp -> 404"
    else fail "$base/c/$tok/mcp" "404 (route deleted)" "$c$([ "$c" = 401 ] && echo '  <- route still compiled, secret-gated only')"; fi
  done
done

# ── 2. PKCE: OAuth 2.1 removes `plain` ──────────────────────────────────────
# QUA-1117 item 4. workers-oauth-provider defaults allowPlainPKCE=true, so this
# regresses silently if the option is ever dropped from createOAuthProvider.
head_ "2. AS metadata advertises S256 only (PASS = no 'plain')"
for base in "$ST" "$QBO"; do
  m=$("${CURL[@]}" "$base/.well-known/oauth-authorization-server" \
      | python3 -c 'import sys,json;print(",".join(json.load(sys.stdin).get("code_challenge_methods_supported") or []))' 2>/dev/null)
  if [ "$m" = "S256" ]; then pass "$base -> [$m]"
  else fail "$base code_challenge_methods_supported" "S256" "${m:-<unreadable>}"; fi
done

# ── 3. Unauthenticated callers get nothing ──────────────────────────────────
head_ "3. Unauthenticated access is refused"
c=$(code_of -X POST "$ST/mcp" -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')
[ "$c" = "401" ] && pass "TAI-ST /mcp no key -> 401" || fail "TAI-ST /mcp no key" 401 "$c"

for p in /report/data-health /report/gl/pnl /report/revenue/summary; do
  c=$(code_of "$QBO$p")
  [ "$c" = "401" ] && pass "TAI-QBO $p -> 401" || fail "TAI-QBO $p" 401 "$c"
done

# hopper discovery is fail-closed-empty by design (200 + []), not an error.
body=$("${CURL[@]}" -X POST "$QBO/mcp" -H 'content-type: application/json' \
        -H 'accept: application/json, text/event-stream' \
        -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')
if echo "$body" | grep -q '"tools":\[\]'; then pass "TAI-QBO anon tools/list -> [] (fail-closed discovery)"
else fail "TAI-QBO anon tools/list" '{"tools":[]}' "$body"; fi

call=$("${CURL[@]}" -X POST "$QBO/mcp" -H 'content-type: application/json' \
        -H 'accept: application/json, text/event-stream' \
        -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_models","arguments":{}}}')
if echo "$call" | grep -q 'unauthorized'; then pass "TAI-QBO anon tools/call -> unauthorized"
else fail "TAI-QBO anon tools/call" "unauthorized error" "$call"; fi

# ── 4. RFC 9728 on the OAuth doors ──────────────────────────────────────────
# Scoped to /mcp-oauth deliberately: the plain /mcp sync-key door is NOT an
# OAuth-protected resource and correctly sends no WWW-Authenticate.
head_ "4. RFC 9728 WWW-Authenticate on /mcp-oauth"
for base in "$ST" "$QBO"; do
  h=$("${CURL[@]}" -D - -o /dev/null -X POST "$base/mcp-oauth" \
      -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
      -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | tr -d '\r' | grep -i '^www-authenticate:')
  if echo "$h" | grep -q 'resource_metadata='; then pass "$base/mcp-oauth carries resource_metadata"
  else fail "$base/mcp-oauth WWW-Authenticate" "Bearer ... resource_metadata=..." "${h:-<absent>}"; fi
  c=$(code_of "$base/.well-known/oauth-protected-resource")
  [ "$c" = "200" ] && pass "$base protected-resource metadata -> 200" || fail "$base protected-resource metadata" 200 "$c"
done

# ── 5. Deployed-state signal ────────────────────────────────────────────────
# NOT a guard — a reminder. TAI-ST's version string is not bumped per feature
# (PRs #85-88 shipped without moving 1.7.0), so toolCount is the only reliable
# deployed-state signal, and TAI-QBO exposes no version at all (open question).
head_ "5. Deployed state (informational)"
printf '  TAI-ST : %s\n' "$("${CURL[@]}" "$ST/health")"
printf '  TAI-QBO: %s\n' "$("${CURL[@]}" "$QBO/health")"

printf '\n\033[1m%d passed, %d failed\033[0m\n' "$PASSED" "$FAILED"
[ "$FAILED" -eq 0 ] || { printf 'One or more connector guards are NOT in place.\n'; exit 1; }
