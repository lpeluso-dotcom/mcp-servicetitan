# Write-gate adversarial verification — v1.2.0 prod

**Date**: 2026-05-02
**Target**: https://mcp-servicetitan.lpeluso.workers.dev/mcp (v1.2.0, deployment `3ca2849`)
**Actor**: `adversarial-test` (audit_log filter)

Four adversarial paths verified against the live HMAC write-gate. All four behaved as designed.

## Test 1 — Args-tampered (HMAC payload mismatch)

Issue dryRun for `add_customer_note(customerId=261837, note="adv-1-original")`. Capture the token. Attempt confirm with the same token but a different `note` value.

**Expected**: gate rejects with "args changed since dryRun".

**Actual**:
```json
{"ok":false,"code":"internal_error",
 "message":"args changed since dryRun — re-run dryRun with current args",
 "correlation":"monkymyt-7d4057f59f60f292"}
```

**Verdict**: ✅ PASS. The `currentArgsHash !== argsHash` check at [src/write-gate.ts:109-110](../../src/write-gate.ts#L109-L110) catches the tampered payload before the D1 row lookup.

## Test 2 — Token-replay (consumed_at flag)

Issue dryRun for `add_customer_note(customerId=99999999, note="adv-2")`. First confirm consumes the token at the gate (line 121), then proceeds to ST write — which fails with 400 because customer 99999999 doesn't exist. The point: the token is already consumed regardless of ST's response. Second confirm with the same token must reject.

**Expected**:
- First confirm: gate verify succeeds + consumes; ST write returns 400 → tool returns `upstream_error`.
- Second confirm: gate rejects with "already used".

**Actual**:
```json
First:  {"ok":false,"code":"upstream_error",
         "message":"add_customer_note failed: 400",
         "correlation":"monkywx9-18271bf301e848c1"}

Second: {"ok":false,"code":"internal_error",
         "message":"confirmation_token already used",
         "correlation":"monkyyky-691f829cadce656e"}
```

**Verdict**: ✅ PASS. Replay protection holds even when the underlying ST write fails. The `consumed_at` flag at [src/write-gate.ts:118-122](../../src/write-gate.ts#L118-L122) is set transactionally on verify, not after the ST round-trip.

## Test 3 — Cross-tool replay (token-tool mismatch)

Issue dryRun for `add_customer_note`. Attempt confirm using the same token against `add_job_note`.

**Expected**: gate rejects with "different tool".

**Actual**:
```json
{"ok":false,"code":"internal_error",
 "message":"confirmation_token is for a different tool",
 "correlation":"monkz9xk-8d016fc9f933c1f8"}
```

**Verdict**: ✅ PASS. The `tokenTool !== tool` check at [src/write-gate.ts:102](../../src/write-gate.ts#L102) catches the cross-tool attempt.

## Test 4 — Token expiry (code-verified)

15-minute TTL is enforced at [src/write-gate.ts:104](../../src/write-gate.ts#L104):

```ts
if (Date.now() - issuedAt > TOKEN_TTL_MS) throw new Error('confirmation_token expired');
```

with `TOKEN_TTL_MS = 15 * 60 * 1000` at [src/write-gate.ts:16](../../src/write-gate.ts#L16).

**Verdict**: ✅ Code-verified. Live time-based test deferred to the unit test suite (no value in 16-minute live wait).

## Summary

| Path | Defense | Source | Status |
|---|---|---|---|
| Args tampering | SHA-256 args hash compared at verify | write-gate.ts:109 | ✅ live |
| Token replay | `consumed_at` flag, set on verify | write-gate.ts:118-121 | ✅ live |
| Cross-tool | `tokenTool !== tool` envelope check | write-gate.ts:102 | ✅ live |
| Expiry | `Date.now() - issuedAt > TOKEN_TTL_MS` | write-gate.ts:104 | ✅ code |
| Actor mismatch | `tokenActor !== safeActor` | write-gate.ts:103 | not exercised here |
| HMAC integrity | Constant-time XOR-reduce verify | write-gate.ts:29-35 | not exercised here |

The gate's design is sound. Audit_log will show the four adversarial attempts under `actor=adversarial-test` for the next 7-day retention window.
