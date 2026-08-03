# Lockdown Auth Fix + Security Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the `MCP_LOCKDOWN` auth-bypass (the incident switch currently waives authentication instead of narrowing it), land the QUA-519 hardening batch (CORS allowlist, `/health` trim, `__Host-` CSRF cookie, package.json drift), update QUA-741 with the Phase-7 design findings, and clear repo housekeeping.

**Architecture:** All code changes are localized: `src/auth.ts` (auth ordering), `src/index.ts` (CORS + health), `src/oauth.ts` (cookie prefix), `package.json` (description). One branch → one PR → manual `workflow_dispatch` deploy with canary (auth path is on the live Dawn/Retell route). Linear/GitHub actions are separate no-code tasks.

**Tech Stack:** TypeScript, Cloudflare Workers, `agents/mcp` `createMcpHandler`, `@cloudflare/workers-oauth-provider`, Vitest, `gh` CLI, Linear MCP.

## Global Constraints

- **Protected-file approval:** Luke approved edits to `src/auth.ts` and `src/oauth.ts` in-session on 2026-07-13 (AskUserQuestion, scope selection). No other protected files may be touched.
- `npm run check` green before every commit. TDD: watch each test fail first.
- Deploy = manual `workflow_dispatch` from a clean pushed tree after `bash scripts/preflight.sh`. **Never auto-deploy.**
- This PR touches the auth path used by Dawn/Retell → use canary: `wrangler versions upload` → ~10% → watch `/admin/metrics` 15–30 min → `wrangler versions deploy` 100%.
- Luke merges with **merge commits** (`gh pr merge N --merge`), never squash.
- Branch for code tasks: `fix/lockdown-auth-and-hardening`, cut from pushed `main`.
- Linear writes require the `linear-server` MCP (OAuth). If unauthorized in the executing session, output the drafted text and stop — never post via GraphQL or Make.

---

### Task 1: Repo housekeeping (no code)

**Files:** none — git/GitHub operations only.

**Interfaces:**
- Consumes: nothing.
- Produces: pushed `main` (the 4 local doc commits), closed spam PR #59, merged dependabot PRs. Task 2 branches from this pushed `main`.

- [ ] **Step 1: Push main**

```bash
cd /home/taylor/work/mcp-servicetitan
git log origin/main..main --oneline   # expect exactly the 4 doc commits (b721453, 212c28f, 03e5d84, d9012bf)
git push origin main
```

Expected: push succeeds; `git status -sb` shows `## main...origin/main` with no ahead marker. (Leave the untracked `.claude/` dir alone — not this plan's concern.)

- [ ] **Step 2: Close spam PR #59**

PR #59 (`jmthomasofficial`, "feat: add JMT x402 Agent Tools") only edits `README.md` to insert third-party promo links — link spam against the public repo.

```bash
gh pr close 59 --comment "Closing: this PR adds unrelated third-party promotional content to the README. This repo only accepts changes related to the ServiceTitan MCP server itself."
```

Expected: PR state CLOSED.

- [ ] **Step 3: Merge dependabot PRs (checks-gated)**

```bash
gh pr checks 42 && gh pr merge 42 --merge   # actions/checkout 6→7 (CI-only)
gh pr checks 65 && gh pr merge 65 --merge   # dev-group bump (esbuild/vite etc.)
```

For **#43 (runtime group: agents/hono/etc.)** do a local verification first — runtime deps can change MCP transport behavior:

```bash
gh pr checkout 43
npm ci && npm run check
```

Expected: typecheck + full vitest suite green. If green: `gh pr merge 43 --merge`. If not: comment the failure on the PR and leave it open.

- [ ] **Step 4: Sync local main**

```bash
git checkout main && git pull origin main
```

Expected: fast-forward including the dependabot merges.

---

### Task 2: Fix `MCP_LOCKDOWN` auth bypass — ⚠ PROTECTED FILE `src/auth.ts` (approved 2026-07-13)

**Files:**
- Modify: `src/auth.ts` (resolveAuth ~lines 54–108, verifyConnectorToken ~lines 129–158)
- Test: Create `src/__tests__/lockdown-auth.test.ts`

**Interfaces:**
- Consumes: existing exports `resolveAuth(request, env): Promise<AuthResult>`, `verifyConnectorToken(token, env): Promise<ConnectorAuth | null>`.
- Produces: **identical signatures** (index.ts callers unchanged). New behavior: lockdown downgrades role *after* successful authentication; unauthenticated callers stay rejected. Connector tokens also downgrade to `'lockdown'` while the switch is on.

Root cause: [auth.ts:61-63] returns `{ authenticated: true, role: 'lockdown', authMode: 'none' }` **before any credential check**, so flipping the incident switch opens the read surface (customer PII, payroll, `st_run_report`) to unauthenticated callers. The connector path has the mirror-image bug: `verifyConnectorToken` ignores lockdown entirely, so a `'default'`-role connector token keeps **write** access during an incident.

- [ ] **Step 1: Write the failing tests**

Create `src/__tests__/lockdown-auth.test.ts`:

```ts
// ============================================================
// lockdown-auth.test.ts — MCP_LOCKDOWN must NARROW authenticated
// callers, never WAIVE authentication. Regression guard for the
// 2026-07-13 finding: the v1.5.2 short-circuit returned
// authenticated:true before any credential check.
// ============================================================
import { describe, it, expect, vi } from 'vitest';
import { resolveAuth, verifyConnectorToken } from '../auth';

const SYNC_KEY = 'test-sync-key-1234567890';

function req(headers: Record<string, string> = {}): Request {
  return new Request('https://mcp.test/mcp', { method: 'POST', headers });
}

function envWith(extra: Record<string, unknown> = {}): any {
  return { MCP_SYNC_KEY: SYNC_KEY, ...extra };
}

function d1RowEnv(row: Record<string, unknown>, extra: Record<string, unknown> = {}): any {
  return envWith({
    DB: { prepare: () => ({ bind: () => ({ first: async () => row }) }) },
    ...extra,
  });
}

describe('MCP_LOCKDOWN auth ordering', () => {
  it('rejects a caller with NO credentials even when lockdown is on', async () => {
    const auth = await resolveAuth(req(), envWith({ MCP_LOCKDOWN: 'true' }));
    expect(auth.authenticated).toBe(false);
  });

  it('rejects a caller with a WRONG sync key when lockdown is on', async () => {
    const auth = await resolveAuth(
      req({ 'x-sync-key': 'wrong-key' }),
      envWith({ MCP_LOCKDOWN: 'true' }),
    );
    expect(auth.authenticated).toBe(false);
  });

  it('downgrades a valid sync-key caller to the lockdown role', async () => {
    const auth = await resolveAuth(
      req({ 'x-sync-key': SYNC_KEY }),
      envWith({ MCP_LOCKDOWN: 'true' }),
    );
    expect(auth.authenticated).toBe(true);
    expect(auth.role).toBe('lockdown');
    expect(auth.authMode).toBe('sync-key');
  });

  it('downgrades even an ADMIN sync-key caller to the lockdown role', async () => {
    const auth = await resolveAuth(
      req({ 'x-sync-key': SYNC_KEY, 'x-mcp-role': 'admin' }),
      d1RowEnv({ role: 'admin' }, { MCP_LOCKDOWN: 'true' }),
    );
    expect(auth.authenticated).toBe(true);
    expect(auth.role).toBe('lockdown');
  });

  it('leaves roles untouched when lockdown is off (regression)', async () => {
    const auth = await resolveAuth(req({ 'x-sync-key': SYNC_KEY }), envWith());
    expect(auth.authenticated).toBe(true);
    expect(auth.role).toBe('default');
  });

  it('verifyConnectorToken downgrades a default-role connector token to lockdown', async () => {
    const conn = await verifyConnectorToken(
      'connector-token-abcdef1234567890',
      d1RowEnv({ role: 'default', owner: 'jessica.hunt', expires_at: null }, { MCP_LOCKDOWN: 'true' }),
    );
    expect(conn).not.toBeNull();
    expect(conn!.role).toBe('lockdown');
  });

  it('verifyConnectorToken still rejects unknown tokens under lockdown', async () => {
    const conn = await verifyConnectorToken(
      'connector-token-abcdef1234567890',
      d1RowEnv(null as unknown as Record<string, unknown>, { MCP_LOCKDOWN: 'true' }),
    );
    expect(conn).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/lockdown-auth.test.ts`
Expected: FAIL — "rejects a caller with NO credentials" gets `authenticated: true` (the short-circuit), and the connector downgrade test gets `role: 'default'`.

- [ ] **Step 3: Write the minimal implementation**

In `src/auth.ts`, replace the current `resolveAuth` with a wrapper + rename the existing body (short-circuit removed) to a private `resolveCredentials`:

```ts
// Resolve caller role for this request.
// Dual-mode auth: JWT first, then fall back to X-Sync-Key (constant-time).
// MCP_LOCKDOWN (v1.5.2; ordering fixed 2026-07-13): when 'true', every
// AUTHENTICATED caller is forced into the lockdown role — toolsForRole()
// then strips all writes + st_call. Lockdown must never waive
// authentication itself: credentials are still required; the switch only
// narrows what they grant.
export async function resolveAuth(request: Request, env: Env): Promise<AuthResult> {
  const auth = await resolveCredentials(request, env);
  if (env.MCP_LOCKDOWN === 'true' && auth.authenticated) {
    return { ...auth, role: 'lockdown' };
  }
  return auth;
}

async function resolveCredentials(request: Request, env: Env): Promise<AuthResult> {
  const fallbackActor = safeActorHeader(request.headers.get('x-actor'));

  // JWT path first
  const authHeader = request.headers.get('authorization');
  if (authHeader?.startsWith('Bearer ')) {
    // ... existing JWT block unchanged ...
  }

  // Fall back to X-Sync-Key (legacy)
  // ... existing sync-key + D1 admin-lookup block unchanged ...
}
```

(The `if (env.MCP_LOCKDOWN === 'true') { return ... }` block at the top of the old function is **deleted** — that is the bug.)

In `verifyConnectorToken`, downgrade the resolved role while lockdown is on (after the expiry check, replacing the current `const role: Role = ...` assignment):

```ts
    if (row.expires_at != null && row.expires_at < Date.now()) return null; // expired
    const baseRole: Role = (CONNECTOR_ROLES as readonly string[]).includes(row.role)
      ? (row.role as Role)
      : 'readonly';
    // Incident switch: lockdown narrows connector grants too (a 'default'
    // connector token must not keep write access while lockdown is on).
    const role: Role = env.MCP_LOCKDOWN === 'true' ? 'lockdown' : baseRole;
    return { role, owner: safeActorHeader(row.owner) };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/lockdown-auth.test.ts && npm run check`
Expected: new file PASS; full suite green (existing `lockdown.test.ts` only exercises `toolsForRole` and is unaffected).

- [ ] **Step 5: Commit**

```bash
git checkout -b fix/lockdown-auth-and-hardening
git add src/auth.ts src/__tests__/lockdown-auth.test.ts
git commit -m "fix(auth): MCP_LOCKDOWN narrows authenticated callers instead of waiving auth

The v1.5.2 lockdown short-circuit returned authenticated:true before any
credential check, so enabling the incident switch exposed the full read
toolset (customer PII, payroll, st_run_report) to unauthenticated
callers. Lockdown now authenticates first, then downgrades the role.
Connector tokens ('/c/<token>/mcp') are downgraded to lockdown too — a
default-role connector token no longer keeps write access mid-incident."
```

---

### Task 3: CORS allowlist for `/mcp` surfaces

**Files:**
- Modify: `src/index.ts` (CORS_OPTIONS block ~lines 150–178, `unauthorizedConnectorResponse` ~lines 239–253, the three `createMcpHandler(...)` call sites ~lines 287, 319–322, 336)
- Test: Create `src/__tests__/cors-origin.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: exported `corsOriginFor(request: Request): string` and `corsOptionsFor(request: Request)` in `src/index.ts`; both unauthorized-response helpers take `(request: Request)`.

CORS only constrains **browsers** — Claude Desktop/Code and server-side clients send no `Origin` and ignore ACAO, so this cannot break Jessica's Desktop connector or Dawn. It stops arbitrary websites from scripting the endpoints with a visitor's browser. Browser clients that must keep working: claude.ai web connectors and MCP Inspector.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/cors-origin.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { corsOriginFor } from '../index';

function reqWithOrigin(origin?: string): Request {
  return new Request('https://mcp.test/mcp', {
    method: 'POST',
    headers: origin ? { origin } : {},
  });
}

describe('corsOriginFor', () => {
  it('reflects claude.ai', () => {
    expect(corsOriginFor(reqWithOrigin('https://claude.ai'))).toBe('https://claude.ai');
  });
  it('reflects MCP Inspector localhost origins', () => {
    expect(corsOriginFor(reqWithOrigin('http://localhost:6274'))).toBe('http://localhost:6274');
    expect(corsOriginFor(reqWithOrigin('http://localhost:5173'))).toBe('http://localhost:5173');
  });
  it('does NOT reflect unknown origins', () => {
    expect(corsOriginFor(reqWithOrigin('https://evil.example'))).toBe('https://claude.ai');
  });
  it('falls back safely when no Origin header is present (non-browser clients)', () => {
    expect(corsOriginFor(reqWithOrigin())).toBe('https://claude.ai');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/cors-origin.test.ts`
Expected: FAIL — `corsOriginFor` is not exported.

- [ ] **Step 3: Write minimal implementation**

In `src/index.ts`, replace the static `CORS_OPTIONS` comment/value and add the helpers:

```ts
// ─── CORS for MCP Inspector + remote MCP clients ──────────────
// Browser-enforced only: non-browser clients (Claude Desktop/Code, Dawn,
// server-side MCP clients) send no Origin and ignore ACAO. The allowlist
// reflects known browser surfaces; anything else gets the claude.ai value,
// which the requesting page cannot match — the browser blocks the read.
// QUA-519 hardening (was origin:'*').
const ALLOWED_BROWSER_ORIGINS: ReadonlySet<string> = new Set([
  'https://claude.ai',
  'https://claude.com',
  'http://localhost:5173',   // MCP Inspector (vite dev UI)
  'http://127.0.0.1:5173',
  'http://localhost:6274',   // MCP Inspector ≥0.13 default UI port
  'http://127.0.0.1:6274',
]);

export function corsOriginFor(request: Request): string {
  const origin = request.headers.get('origin');
  return origin && ALLOWED_BROWSER_ORIGINS.has(origin) ? origin : 'https://claude.ai';
}

const CORS_BASE = {
  methods: 'GET, POST, OPTIONS, DELETE',
  headers: 'content-type, mcp-session-id, authorization, x-sync-key, x-mcp-role, x-actor, x-correlation-id',
  exposeHeaders: 'mcp-session-id',
  maxAge: 86400,
};

export function corsOptionsFor(request: Request) {
  return { ...CORS_BASE, origin: corsOriginFor(request) };
}
```

Then update the four consumers:

1. `unauthorizedMcpResponse()` → `unauthorizedMcpResponse(request: Request)`; header value `'access-control-allow-origin': corsOriginFor(request)` (other header lines read from `CORS_BASE`). Update its call site to `unauthorizedMcpResponse(request)`.
2. `unauthorizedConnectorResponse()` → same parameterization, call site `unauthorizedConnectorResponse(request)`.
3. All three `createMcpHandler(server, { route: ..., corsOptions: CORS_OPTIONS })` sites → `corsOptions: corsOptionsFor(request)`.
4. Delete the old `CORS_OPTIONS` const once nothing references it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/cors-origin.test.ts && npm run check`
Expected: PASS; typecheck confirms no remaining `CORS_OPTIONS` references.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts src/__tests__/cors-origin.test.ts
git commit -m "feat(security): CORS allowlist replaces origin:'*' (QUA-519)"
```

---

### Task 4: Trim `/health` — stop enumerating tool names unauthenticated

**Files:**
- Modify: `src/index.ts` (`/health` route ~lines 37–49)
- Test: Create `src/__tests__/health-shape.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: exported `healthPayload(env: Env)` in `src/index.ts`. `/health` keeps `toolCount` (mcp-dashboard consumes it) but drops the `tools` name array; per-tool detail stays on the admin-gated `/admin/endpoints`.

- [ ] **Step 1: Check the one known consumer**

The `mcp-dashboard` worker fans out `/health` probes across the 3 MCP servers. Locate its source and confirm it reads `toolCount`, not `tools`:

```bash
DASH=$(ls -d /home/taylor/work/*dashboard* /home/taylor/claude-directory/*dashboard* 2>/dev/null | head -1)
grep -rn "toolCount\|\.tools" "$DASH/src" 2>/dev/null || echo "dashboard source not found — check qsc-infra worker inventory"
```

Expected: only `toolCount` usage. **If it renders the `tools` array**, update mcp-dashboard to use `toolCount` first (separate commit in that repo), then proceed.

- [ ] **Step 2: Write the failing test**

Create `src/__tests__/health-shape.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { healthPayload } from '../index';
import { TOOLS } from '../tools/index';

describe('/health payload', () => {
  const env: any = { MCP_SERVICE_VERSION: '1.7.0-test', MCP_LOCKDOWN: undefined };

  it('keeps toolCount for the mcp-dashboard probe', () => {
    expect(healthPayload(env).toolCount).toBe(TOOLS.length);
  });

  it('does NOT enumerate tool names unauthenticated (QUA-519)', () => {
    expect(Object.keys(healthPayload(env))).not.toContain('tools');
  });

  it('reports lockdown state', () => {
    expect(healthPayload({ ...env, MCP_LOCKDOWN: 'true' }).lockdown).toBe(true);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/__tests__/health-shape.test.ts`
Expected: FAIL — `healthPayload` is not exported.

- [ ] **Step 4: Write minimal implementation**

In `src/index.ts`, extract the payload and drop the `tools` array:

```ts
export function healthPayload(env: Env): Record<string, unknown> {
  return {
    ok: true,
    service: 'mcp-servicetitan',
    version: env.MCP_SERVICE_VERSION,
    toolCount: TOOLS.length,
    // tool NAMES intentionally omitted (QUA-519): unauthenticated enumeration
    // aids targeting. Full per-tool inventory lives on admin-gated /admin/endpoints.
    transport: 'agents-sdk createMcpHandler (Streamable HTTP)',
    stProxy: 'service-binding',
    lockdown: env.MCP_LOCKDOWN === 'true',
  };
}

app.get('/health', (c) => c.json(healthPayload(c.env)));
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/health-shape.test.ts && npm run check`
Expected: PASS. If any existing test asserted the `tools` array on /health, update that assertion to `toolCount` (search: `grep -rn "tools:" src/__tests__/ src/routes/__tests__ 2>/dev/null | grep -i health`).

- [ ] **Step 6: Commit**

```bash
git add src/index.ts src/__tests__/health-shape.test.ts
git commit -m "feat(security): /health stops enumerating tool names; toolCount preserved (QUA-519)"
```

---

### Task 5: `__Host-` CSRF cookie — ⚠ PROTECTED FILE `src/oauth.ts` (approved 2026-07-13)

**Files:**
- Modify: `src/oauth.ts` (line 21: `CSRF_COOKIE` constant)
- Test: Create `src/__tests__/oauth-csrf-cookie.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: no exported-surface change — the constant is internal; set + clear + read all use it.

The Cloudflare securing-MCP guide mandates the `__Host-` prefix on `*.workers.dev` cookies: it forces Secure + Path=/ + no Domain attribute, blocking sibling-subdomain cookie injection. The cookie already satisfies all three attribute requirements — only the name changes. In-flight logins during deploy simply restart the OAuth dance (10-min TTL, cosmetic).

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/oauth-csrf-cookie.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { handleOAuthRoute } from '../oauth';

describe('OAuth CSRF cookie', () => {
  it('sets a __Host- prefixed cookie on /authorize', async () => {
    const env: any = {
      ACCESS_ISSUER: 'https://team.cloudflareaccess.com/cdn-cgi/access/sso/oidc/abc123',
      ACCESS_CLIENT_ID: 'client-id',
      SELF_ORIGIN: 'https://mcp-servicetitan.lpeluso.workers.dev',
      OAUTH_KV: { put: vi.fn(async () => {}) },
      OAUTH_PROVIDER: {
        parseAuthRequest: vi.fn(async () => ({ clientId: 'c1', scope: ['openid'] })),
      },
    };
    const url = new URL('https://mcp-servicetitan.lpeluso.workers.dev/authorize');
    const res = await handleOAuthRoute(new Request(url, { method: 'GET' }), env, url);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(302);
    const cookie = res!.headers.get('set-cookie') ?? '';
    expect(cookie.startsWith('__Host-mcpst_oauth_csrf=')).toBe(true);
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('Path=/');
    expect(cookie).not.toMatch(/Domain=/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/oauth-csrf-cookie.test.ts`
Expected: FAIL — cookie name is `mcpst_oauth_csrf` (no prefix).

- [ ] **Step 3: Write minimal implementation**

In `src/oauth.ts` line 21:

```ts
// __Host- prefix (securing-MCP guide): browser-enforced Secure + Path=/ +
// no Domain — a sibling *.workers.dev host cannot plant or override it.
const CSRF_COOKIE = '__Host-mcpst_oauth_csrf';
```

Then confirm no other literal references exist: `grep -rn "mcpst_oauth_csrf" src/` — expected: only the constant (set/clear/read already go through `CSRF_COOKIE` / `getCookie`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/oauth-csrf-cookie.test.ts && npm run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/oauth.ts src/__tests__/oauth-csrf-cookie.test.ts
git commit -m "feat(security): __Host- prefix on OAuth CSRF cookie (securing-MCP guide)"
```

---

### Task 6: package.json description — stop hand-writing counts/versions

**Files:**
- Modify: `package.json` (the `description` field only)

**Interfaces:** none — metadata only. Release-please (PR #60) owns `version`; this removes the second drift source (the description said "90 tools" while the registry has 91).

- [ ] **Step 1: Replace the description**

```json
"description": "ServiceTitan MCP server for QSC — Streamable HTTP via the Cloudflare Agents SDK. D1-first reads through the taylor-ai proxy with live-ST fallback; two-phase dryRun→HMAC-confirm writes; role gating (admin/default/readonly/lockdown); D1 audit log + Analytics Engine telemetry; response shaper; ST webhook ingest. Tool inventory and version: GET /health (toolCount) and /admin/endpoints — counts are not maintained in this field."
```

- [ ] **Step 2: Verify + commit**

Run: `npm run check` (jsonc sanity via typecheck tooling reading package.json)
Expected: green.

```bash
git add package.json
git commit -m "chore: description no longer hand-maintains tool counts/version (drift source)"
```

---

### Task 7: PR + canary deploy + smoke

**Files:** none — release engineering.

**Interfaces:**
- Consumes: Tasks 2–6 commits on `fix/lockdown-auth-and-hardening`.
- Produces: merged PR, deployed worker, verified behavior.

- [ ] **Step 1: Push + open PR**

```bash
git push -u origin fix/lockdown-auth-and-hardening
gh pr create --title "Security: fix MCP_LOCKDOWN auth bypass + QUA-519 hardening batch" --body "$(cat <<'EOF'
## What
- **fix(auth):** MCP_LOCKDOWN authenticated:true short-circuit ran BEFORE any credential check — enabling the incident switch waived authentication for the whole read surface. Now: authenticate first, then downgrade role to lockdown. Connector tokens (/c/<token>/mcp) downgrade too.
- **CORS:** origin allowlist (claude.ai, claude.com, Inspector localhost) replaces `origin:'*'` (QUA-519).
- **/health:** drops the unauthenticated 91-tool name enumeration; keeps toolCount (mcp-dashboard probe verified) (QUA-519).
- **OAuth:** CSRF cookie now `__Host-` prefixed per the Cloudflare securing-MCP guide.
- **chore:** package.json description no longer hand-maintains counts.

## Verification
- New tests: lockdown-auth (7 cases incl. connector downgrade), cors-origin, health-shape, oauth-csrf-cookie. Full `npm run check` green.
- Post-deploy smoke below (canary).

⚠ Protected files touched with Luke's in-session approval (2026-07-13): src/auth.ts, src/oauth.ts.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 2: CI + merge**

`gh pr checks` green → Luke reviews → `gh pr merge --merge` (merge commit, per convention).

- [ ] **Step 3: Canary deploy** (auth path = live Dawn/Retell route)

```bash
git checkout main && git pull
bash scripts/preflight.sh
npx wrangler versions upload            # new version, no traffic
npx wrangler versions deploy            # interactive: ~10% to the new version
# watch 15–30 min:
curl -s -H "X-Sync-Key: $MCP_SMOKE_KEY" https://mcp-servicetitan.lpeluso.workers.dev/admin/metrics | jq '.period_1h'
npx wrangler versions deploy            # promote to 100%
```

Expected: `error_rate_pct` at or below pre-deploy baseline.

- [ ] **Step 4: Smoke the actual changes**

```bash
# 1. Auth still required (no creds → 401):
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://mcp-servicetitan.lpeluso.workers.dev/mcp   # expect 401
# 2. /health no longer lists names:
curl -s https://mcp-servicetitan.lpeluso.workers.dev/health | jq 'has("tools"), .toolCount'          # expect false, 91
# 3. CORS reflects claude.ai only:
curl -s -o /dev/null -D - -X OPTIONS -H "Origin: https://evil.example" https://mcp-servicetitan.lpeluso.workers.dev/mcp | grep -i access-control-allow-origin   # expect https://claude.ai (not evil.example)
# 4. LOCKDOWN DRILL (dev env — the fix's whole point):
npx wrangler deploy --env dev --var MCP_LOCKDOWN:true
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://mcp-servicetitan-dev.lpeluso.workers.dev/mcp  # expect 401 (was 200-with-tools before the fix)
curl -s -X POST -H "X-Sync-Key: $DEV_SYNC_KEY" -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' https://mcp-servicetitan-dev.lpeluso.workers.dev/mcp | jq '.result.tools | length'  # expect read-only count (no writes)
npx wrangler deploy --env dev   # restore dev without the lockdown var
# 5. Jessica's Desktop connector + claude.ai OAuth connector: confirm both still list tools.
```

- [ ] **Step 5: MCP Inspector round-trip** — `npx @modelcontextprotocol/inspector@latest` against prod `/mcp` with the sync key: `tools/list` works from the localhost UI (proves the CORS allowlist kept Inspector alive).

---

### Task 8: Linear updates (no code — requires `linear-server` MCP auth)

**Files:** none.

**Interfaces:**
- Consumes: findings from the 2026-07-13 review session; Task 7's merged PR URL.
- Produces: new bug issue (audit trail), QUA-741 rescoped, QUA-519 checklist pruned.

If `linear-server` is not authorized in the executing session, print the drafts below for Luke and stop.

- [ ] **Step 1: File the lockdown bug issue** (audit trail — work already done via this plan; create in `Done` state, linked to the PR):

```
save_issue({
  title: "DEV: MCP_LOCKDOWN waived authentication instead of narrowing it — fixed",
  team: "QUA",
  project: "Development — MCP Servers",
  priority: 2,
  assignee: "me",
  state: "Done",
  labels: ["type.bug", "source.claude-direct", "vendor.Cloudflare", "sev.production-impact"],
  description: "> **Requested** 2026-07-13 · **Dept** IT-Systems · **Priority** High

**What / why:** The v1.5.2 MCP_LOCKDOWN short-circuit in src/auth.ts returned authenticated:true BEFORE any credential check — enabling the incident switch exposed the full read toolset (customer PII, payroll, st_run_report) to unauthenticated internet callers, and /c/<token> connector tokens with the default role kept WRITE access. Latent (lockdown not set in prod vars), but it failed exactly when the switch would be reached for.

**Detail:** Found 2026-07-13 during the /cloudflare:build-mcp best-practices review. lockdown.test.ts only covered toolsForRole filtering, never the auth path. Fix: authenticate first, then downgrade role; connector tokens downgrade too. PR: <Task-7 PR URL>. Plan: docs/superpowers/plans/2026-07-13-lockdown-auth-fix-and-hardening.md.

**Done when:** PR merged + deployed; lockdown drill in dev returns 401 unauthenticated / read-only toolset authenticated."
})
```

- [ ] **Step 2: Comment on QUA-741 (Phase 7 rescope)** — post verbatim:

```
**Phase-7 design inputs from the 2026-07-13 McpAgent/Agents-SDK best-practices review** (plan: docs/superpowers/plans/2026-07-13-lockdown-auth-fix-and-hardening.md):

1. **Tool-packs: drop `listChanged` from the design.** `notifications/tools/list_changed` requires a stateful session to deliver; our per-request stateless `createMcpHandler` rebuild means it would never reach a client. But `buildServer` + `toolsForRole` already IS pack-by-credential — Phase 7 tool-packs should extend that same per-request filter (role/scope/header → domain pack), no notification plumbing. This deletes the riskiest chunk of this ticket.
2. **OAuth 2.1 / RFC 9728:** `workers-oauth-provider` serves `/.well-known/oauth-authorization-server` but NOT protected-resource metadata — we hand-roll `/.well-known/oauth-protected-resource` and add `WWW-Authenticate` on 401s **only for `/mcp-oauth`**. The keyed `/mcp` and `/c/<token>` routes stay challenge-free on purpose (a challenge makes Claude attempt OAuth on keyed routes) — preserve that.
3. Landed separately ahead of Phase 7 (PR <Task-7 PR URL>): MCP_LOCKDOWN auth-ordering fix, CORS allowlist, /health trim, __Host- CSRF cookie.
4. Doc-reconcile sub-item: also correct package.json-style hand-written tool counts anywhere they appear in KB/protected-modules.md.
```

- [ ] **Step 3: Prune QUA-519** — comment that CORS tightening, /health trim are shipped (link PR); remaining: inbound per-key rate limiting, write-confirm TTL 15m→5m + one-time-use, the 3 ⚡ Luke-only action items (smoke-gate secrets, /capacity scope, monitors).

---

## Self-Review

- **Spec coverage:** All four approved scope items map to tasks — lockdown fix (Task 2), QUA-519 batch (Tasks 3–6), QUA-741 update (Task 8), housekeeping (Task 1); PR/deploy discipline (Task 7). ✔
- **Placeholder scan:** No TBDs. Task 2 Step 3 elides only *unchanged* existing code (marked "existing block unchanged" with the exact deletion identified); all new code shown in full. ✔
- **Type consistency:** `resolveAuth`/`verifyConnectorToken` signatures unchanged; `corsOriginFor(request): string` used consistently in Task 3 test + impl; `healthPayload(env)` matches test import. ✔
- **Protected files:** `src/auth.ts` (Task 2), `src/oauth.ts` (Task 5) — both covered by Luke's 2026-07-13 in-session approval, restated in Global Constraints. ✔
- **Risk order:** housekeeping first (clean base), the security fix second, additive hardening after, deploy with canary + a dev lockdown drill that proves the actual failure mode is gone. ✔
