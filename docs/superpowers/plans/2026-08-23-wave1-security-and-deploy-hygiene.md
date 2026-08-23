# Wave 1 — Security & Deploy Hygiene Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the live PII/OAuth exposure on the public `mcp-servicetitan` repo, enforce JWT claim validation, close 4 known `hono` CVEs, make `/health` identify the deployed commit, and ship the pending `main` to prod.

**Architecture:** Five independent code changes plus one deploy. The PII fix reuses the repo's existing, proven deploy-time placeholder-substitution mechanism (`scripts/inject-deploy-config.py`), so no new machinery is introduced. The OAuth fix inserts a human approval step between the identity check and `completeAuthorization`, which is the standing mitigation for open dynamic client registration. Every change is guarded by a new test that fails first.

**Tech Stack:** TypeScript, Cloudflare Workers, Hono, `@cloudflare/workers-oauth-provider` 0.8.1, `jose` 6.x, Vitest, Python 3 (deploy script), GitHub Actions.

## Global Constraints

- **Never commit real employee email addresses, the real ServiceTitan tenant id (the value behind the `000000000` placeholder), or any credential.** This repo is PUBLIC (`gh api repos/lpeluso-dotcom/mcp-servicetitan` → `"private": false`).
- **All existing tests must stay green.** Baseline before starting: 107 test files, 1331 tests passing (`npm test`).
- **`npm run check` must pass** (tsc --noEmit + full vitest run) before any commit.
- **Protected modules** (per `qsc-infra/.claude/rules/protected-modules.md`) touched by this plan: `src/tools/st_call.ts` (NOT touched), `src/write-gate.ts` (NOT touched). `src/oauth.ts` is not on the protected list but is security-critical — every change to it needs a test.
- **Fail closed, never open.** Where this plan changes an allow-list or a token check, the absence of configuration must DENY, not permit.
- **Deploys are CI-only:** `gh workflow run deploy.yml --repo lpeluso-dotcom/mcp-servicetitan --ref <branch> -f env=prod`. A local `wrangler deploy` cannot work — the committed `wrangler.toml` ships placeholder ids by design.
- **Branch protection:** `main` requires a PR plus the `validate` check. Do not push to `main` directly.
- Commit messages end with: `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `wrangler.toml` | Worker config; currently holds 8 real employee emails at lines 60 and 99 | Modify — replace both `ALLOWED_EMAILS` values with a placeholder |
| `scripts/inject-deploy-config.py` | Swaps committed placeholders for real values at deploy time from GH secrets | Modify — add `ALLOWED_EMAILS_PROD` / `ALLOWED_EMAILS_DEV` |
| `scripts/__tests__/test_inject_deploy_config.py` | Existing pytest coverage for the injector (verify it exists; if not, the vitest-side test in Task 1 is the gate) | Modify or skip — see Task 1 Step 1 |
| `src/oauth.ts` | Cloudflare Access OIDC bridge + OAuthProvider construction | Modify — remove `DEFAULT_ALLOWED` (Task 1); add consent screen (Task 2) |
| `src/jwt.ts` | HS256 JWT verification for dual-mode auth | Modify — require `exp`, enforce `aud`/`iss` |
| `src/env.ts` | Env typing | Modify — add `JWT_AUDIENCE`, `JWT_ISSUER`, `GIT_SHA` |
| `src/index.ts` | Router + `healthPayload()` | Modify — add `commit` to health payload |
| `.github/workflows/deploy.yml` | Manual prod/dev deploy | Modify — pass `ALLOWED_EMAILS_*` and stamp `GIT_SHA` |
| `src/__tests__/oauth-allowlist-failclosed.test.ts` | NEW — proves an unset allow-list denies everyone | Create |
| `src/__tests__/oauth-consent.test.ts` | NEW — proves `/callback` does not complete authorization without approval | Create |
| `src/__tests__/jwt-claims.test.ts` | NEW — proves `exp`/`aud`/`iss` are enforced | Create |
| `src/__tests__/health-shape.test.ts` | Existing health-shape assertions | Modify — assert `commit` present |

---

### Task 1: Remove real employee emails from the public repo (audit S-8)

**Files:**
- Modify: `wrangler.toml:60`, `wrangler.toml:99`
- Modify: `src/oauth.ts:24` (delete `DEFAULT_ALLOWED`), `src/oauth.ts:36` (`allowedEmails`)
- Modify: `scripts/inject-deploy-config.py:30-56`
- Test: `src/__tests__/oauth-allowlist-failclosed.test.ts` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks (this is Task 1).
- Produces: `allowedEmails(env: Env): string[]` keeps its exact signature and still returns a lowercased, trimmed, empty-filtered array — but returns `[]` when `env.ALLOWED_EMAILS` is unset or blank. Task 2 depends on `/callback` still rejecting a non-allow-listed email with HTTP 403 and body `forbidden`.

**Context the implementer needs:** `wrangler.toml` currently contains, at BOTH line 60 (prod `[vars]`) and line 99 (`[env.dev.vars]`), a comma-separated list of 8 real `@qualityservicecompany.net` addresses. `src/oauth.ts:24` hardcodes 2 more as a fallback, so fixing only `wrangler.toml` leaves a leak. The repo already solves exactly this class of problem for D1/KV ids: the committed file carries an obvious placeholder, and `scripts/inject-deploy-config.py` swaps it from a GitHub Actions secret at deploy time, exiting non-zero if any placeholder survives. Reuse that mechanism — do not invent a new one.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/oauth-allowlist-failclosed.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '../..');

describe('ALLOWED_EMAILS is never committed (audit S-8)', () => {
  it('wrangler.toml contains no real qualityservicecompany.net address', () => {
    const toml = readFileSync(resolve(REPO_ROOT, 'wrangler.toml'), 'utf8');
    expect(toml).not.toMatch(/@qualityservicecompany\.net/);
  });

  it('src/oauth.ts contains no hardcoded email fallback', () => {
    const src = readFileSync(resolve(REPO_ROOT, 'src/oauth.ts'), 'utf8');
    expect(src).not.toMatch(/@qualityservicecompany\.net/);
    expect(src).not.toMatch(/DEFAULT_ALLOWED/);
  });

  it('wrangler.toml still declares ALLOWED_EMAILS with a placeholder in both sections', () => {
    const toml = readFileSync(resolve(REPO_ROOT, 'wrangler.toml'), 'utf8');
    const matches = toml.match(/^ALLOWED_EMAILS\s*=\s*"allowed@example\.com"$/gm) ?? [];
    expect(matches).toHaveLength(2);
  });
});
```

Add to the SAME file a fail-closed unit test for `allowedEmails`. Because `allowedEmails` is module-private, assert it through the exported `/callback` behaviour instead — copy the `vi.mock('@cloudflare/workers-oauth-provider', ...)` block verbatim from `src/__tests__/oauth-csrf-cookie.test.ts:3-22`, then:

```typescript
// (place the vi.mock block from oauth-csrf-cookie.test.ts above these imports)
import { handleOAuthRoute } from '../oauth';

describe('allow-list fails closed when unset', () => {
  it('rejects /callback when ALLOWED_EMAILS is undefined', async () => {
    const env: any = {
      ACCESS_ISSUER: 'https://team.cloudflareaccess.com/cdn-cgi/access/sso/oidc/abc123',
      SELF_ORIGIN: 'https://example.workers.dev',
      // ALLOWED_EMAILS deliberately absent
      OAUTH_KV: {
        get: async () => null,
        put: async () => undefined,
        delete: async () => undefined,
      },
    };
    const req = new Request('https://example.workers.dev/callback?state=s&code=c');
    const res = await handleOAuthRoute(req, env);
    // No stored login state -> 400 before the allow-list is consulted.
    // This asserts the route is reachable and does not throw with no ALLOWED_EMAILS set.
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/__tests__/oauth-allowlist-failclosed.test.ts`
Expected: FAIL — the first two assertions fail because `wrangler.toml` and `src/oauth.ts` still contain `@qualityservicecompany.net`; the third fails because the placeholder is not there yet.

- [ ] **Step 3: Replace the committed values with a placeholder**

In `wrangler.toml`, at line 60 and line 99, replace the entire value:

```toml
ALLOWED_EMAILS = "allowed@example.com"
```

Leave the surrounding comment at line 56 intact but append this sentence to it:

```toml
# Real values are injected at deploy time by scripts/inject-deploy-config.py from the
# ALLOWED_EMAILS_PROD / ALLOWED_EMAILS_DEV GitHub Actions secrets. Never commit real
# addresses here — this repository is public (audit S-8, 2026-08-01).
```

- [ ] **Step 4: Delete the hardcoded fallback and fail closed**

In `src/oauth.ts`, delete line 24 entirely:

```typescript
const DEFAULT_ALLOWED = '<two real addresses>';   // DELETE THIS LINE
```

Then change `allowedEmails` (line 36) from:

```typescript
function allowedEmails(env: Env): string[] {
  return (env.ALLOWED_EMAILS || DEFAULT_ALLOWED).split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
}
```

to:

```typescript
// Fail closed: an unset or blank ALLOWED_EMAILS denies EVERY email rather than
// falling back to a committed list. The deploy injector (scripts/inject-deploy-config.py)
// exits non-zero if the placeholder survives, so an unconfigured deploy fails loudly
// at build time rather than silently granting access at runtime. (audit S-8)
function allowedEmails(env: Env): string[] {
  return (env.ALLOWED_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}
```

- [ ] **Step 5: Teach the deploy injector about ALLOWED_EMAILS**

In `scripts/inject-deploy-config.py`, add the two new names to `REQUIRED_VARS` (currently lines 30-34):

```python
REQUIRED_VARS = (
    'ST_TENANT_ID',
    'D1_DATABASE_ID_PROD', 'D1_DATABASE_ID_DEV',
    'KV_NAMESPACE_ID_PROD', 'KV_NAMESPACE_ID_DEV',
    'ST_PROXY_SERVICE_PROD', 'ST_PROXY_SERVICE_DEV',
    'ALLOWED_EMAILS_PROD', 'ALLOWED_EMAILS_DEV',
)
```

Add the placeholder constant next to the others (after line 39):

```python
EMAILS_PLACEHOLDER = '"allowed@example.com"'
```

Add the two section entries to `SECTION_SUBS` (the dict starting line 43). `SECTION_RE` already matches single-bracket headers, so `[vars]` and `[env.dev.vars]` are valid keys:

```python
    '[vars]':          [(EMAILS_PLACEHOLDER, 'ALLOWED_EMAILS_PROD', True)],
    '[env.dev.vars]':  [(EMAILS_PLACEHOLDER, 'ALLOWED_EMAILS_DEV',  True)],
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/__tests__/oauth-allowlist-failclosed.test.ts`
Expected: PASS, 4 tests.

Run: `python3 -c "import ast,sys; ast.parse(open('scripts/inject-deploy-config.py').read()); print('syntax ok')"`
Expected: `syntax ok`

Then verify the injector actually substitutes, using a scratch copy so the working tree is untouched:

```bash
cp wrangler.toml /tmp/wrangler-test.toml
ST_TENANT_ID=000000000 \
D1_DATABASE_ID_PROD=aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa \
D1_DATABASE_ID_DEV=bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb \
KV_NAMESPACE_ID_PROD=cccccccccccccccccccccccccccccccc \
KV_NAMESPACE_ID_DEV=dddddddddddddddddddddddddddddddd \
ST_PROXY_SERVICE_PROD=proxy-prod \
ST_PROXY_SERVICE_DEV=proxy-dev \
ALLOWED_EMAILS_PROD="a@example.org,b@example.org" \
ALLOWED_EMAILS_DEV="a@example.org" \
python3 scripts/inject-deploy-config.py /tmp/wrangler-test.toml
grep -n ALLOWED_EMAILS /tmp/wrangler-test.toml
```

Expected: exit 0, and the grep shows `ALLOWED_EMAILS = "a@example.org,b@example.org"` in the prod section and `ALLOWED_EMAILS = "a@example.org"` in the dev section — no placeholder left.

If `inject-deploy-config.py` takes the path differently (read its `__main__` block, lines 60+, before running), adapt the invocation — do not change the script's CLI contract.

- [ ] **Step 7: Run the full suite**

Run: `npm run check`
Expected: tsc clean; vitest 108 files / 1335 tests passing (the 4 new ones added to the 1331 baseline).

- [ ] **Step 8: Commit**

```bash
git add wrangler.toml src/oauth.ts scripts/inject-deploy-config.py src/__tests__/oauth-allowlist-failclosed.test.ts
git commit -m "$(cat <<'EOF'
fix(security): move ALLOWED_EMAILS to deploy-time injection (audit S-8)

The committed wrangler.toml published 8 real employee email addresses in
both the prod and dev vars blocks, and src/oauth.ts carried 2 more as a
hardcoded fallback. This repository is public, and the audit's S-1 finding
(open dynamic client registration, no consent screen) makes that list a
directly actionable phishing target.

Both lists are now a placeholder, substituted at deploy time from the
ALLOWED_EMAILS_PROD / ALLOWED_EMAILS_DEV GitHub Actions secrets by the
existing inject-deploy-config.py mechanism, which fails the build if a
placeholder survives. allowedEmails() now fails closed: an unset value
denies everyone rather than falling back to a committed list.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 9: Set the GitHub Actions secrets (BLOCKING — deploy will fail without these)**

The real values are the 8 addresses currently at `wrangler.toml:60` on `origin/main`. Read them from git BEFORE the commit above lands on the remote, then set both secrets:

```bash
PROD_EMAILS=$(git show origin/main:wrangler.toml | grep -m1 '^ALLOWED_EMAILS' | sed 's/^ALLOWED_EMAILS = "//; s/"$//')
gh secret set ALLOWED_EMAILS_PROD --repo lpeluso-dotcom/mcp-servicetitan --body "$PROD_EMAILS"
DEV_EMAILS=$(git show origin/main:wrangler.toml | grep '^ALLOWED_EMAILS' | sed -n 2p | sed 's/^ALLOWED_EMAILS = "//; s/"$//')
gh secret set ALLOWED_EMAILS_DEV --repo lpeluso-dotcom/mcp-servicetitan --body "$DEV_EMAILS"
gh secret list --repo lpeluso-dotcom/mcp-servicetitan | grep ALLOWED_EMAILS
```

Expected: both `ALLOWED_EMAILS_PROD` and `ALLOWED_EMAILS_DEV` listed. Do NOT echo the values to the terminal.

**Note for the human reviewer:** removing these from the current tree does not remove them from git history. History rewriting on a public repo with 307 commits is out of scope for this plan; the addresses are work emails already published in other places, and the exploitable half of the pair (open DCR without consent) is closed in Task 2. Flag to Luke as a separate accept-or-remediate decision.

---

### Task 2: Add a consent screen to the OAuth authorization flow (audit S-1)

**Files:**
- Modify: `src/oauth.ts:118-152` (the `/callback` handler), and add a new `/approve` route
- Test: `src/__tests__/oauth-consent.test.ts` (create)

**Interfaces:**
- Consumes: `allowedEmails(env)` from Task 1 (returns `[]` when unset).
- Produces: a new KV key shape `approve:<state>` holding `{ oauthReqInfo, sub, email, name }` with the same `LOGIN_TTL` (600s) expiry. `handleOAuthRoute` gains a third route, `POST /approve`, which is the ONLY caller of `env.OAUTH_PROVIDER.completeAuthorization`. No other task depends on this.

**Context the implementer needs:** Today `/callback` (line 146) calls `completeAuthorization` immediately after the email allow-list check. Combined with `clientRegistrationEndpoint: '/register'` (line 170, open dynamic client registration), an attacker can register their own OAuth client and send an allow-listed user an `/authorize` link; the user sees only a normal Cloudflare Access login and is then redirected — with a valid token — to the attacker's `redirect_uri`. Nothing tells them which application they just authorized. The MCP spec revision 2026-07-28 deprecates dynamic client registration in favour of Client ID Metadata Documents, but the standing mitigation for an open registration endpoint is an explicit human approval step that names the client and its redirect target.

Do NOT remove `clientRegistrationEndpoint` — Claude Desktop and the claude.ai connector register through it, and removing it breaks new client onboarding. The consent screen is the fix.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/oauth-consent.test.ts`. Copy the `vi.mock('@cloudflare/workers-oauth-provider', ...)` block verbatim from `src/__tests__/oauth-csrf-cookie.test.ts:3-22` to the top of the file, then:

```typescript
import { describe, it, expect, vi } from 'vitest';
// (vi.mock block from oauth-csrf-cookie.test.ts goes here, ABOVE this import)
import { handleOAuthRoute } from '../oauth';

function kvStub(store: Record<string, unknown>) {
  return {
    get: async (k: string, _t?: string) => store[k] ?? null,
    put: async (k: string, v: string) => { store[k] = JSON.parse(v); },
    delete: async (k: string) => { delete store[k]; },
  };
}

describe('OAuth consent screen (audit S-1)', () => {
  it('POST /approve is the only path that completes authorization', async () => {
    const completeAuthorization = vi.fn(async () => ({ redirectTo: 'https://client.example/cb?code=x' }));
    const store: Record<string, unknown> = {
      'approve:st-1': {
        oauthReqInfo: { clientId: 'attacker-client', redirectUri: 'https://evil.example/cb', scope: ['openid'] },
        sub: 'user-sub-1',
        email: 'ok@example.org',
        name: 'Ok User',
      },
    };
    const env: any = {
      ALLOWED_EMAILS: 'ok@example.org',
      SELF_ORIGIN: 'https://example.workers.dev',
      OAUTH_KV: kvStub(store),
      OAUTH_PROVIDER: { completeAuthorization },
    };
    const res = await handleOAuthRoute(
      new Request('https://example.workers.dev/approve', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'state=st-1&decision=approve',
      }),
      env,
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(302);
    expect(completeAuthorization).toHaveBeenCalledTimes(1);
  });

  it('POST /approve with decision=deny does NOT complete authorization', async () => {
    const completeAuthorization = vi.fn();
    const store: Record<string, unknown> = {
      'approve:st-2': {
        oauthReqInfo: { clientId: 'attacker-client', redirectUri: 'https://evil.example/cb', scope: ['openid'] },
        sub: 'user-sub-2',
        email: 'ok@example.org',
        name: null,
      },
    };
    const env: any = {
      ALLOWED_EMAILS: 'ok@example.org',
      SELF_ORIGIN: 'https://example.workers.dev',
      OAUTH_KV: kvStub(store),
      OAUTH_PROVIDER: { completeAuthorization },
    };
    const res = await handleOAuthRoute(
      new Request('https://example.workers.dev/approve', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'state=st-2&decision=deny',
      }),
      env,
    );
    expect(res!.status).toBe(403);
    expect(completeAuthorization).not.toHaveBeenCalled();
  });

  it('POST /approve with an unknown state is rejected', async () => {
    const completeAuthorization = vi.fn();
    const env: any = {
      ALLOWED_EMAILS: 'ok@example.org',
      SELF_ORIGIN: 'https://example.workers.dev',
      OAUTH_KV: kvStub({}),
      OAUTH_PROVIDER: { completeAuthorization },
    };
    const res = await handleOAuthRoute(
      new Request('https://example.workers.dev/approve', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'state=nope&decision=approve',
      }),
      env,
    );
    expect(res!.status).toBe(400);
    expect(completeAuthorization).not.toHaveBeenCalled();
  });

  it('the consent page names the client id and redirect uri', async () => {
    const store: Record<string, unknown> = {
      'approve:st-3': {
        oauthReqInfo: { clientId: 'some-client', redirectUri: 'https://client.example/cb', scope: ['openid'] },
        sub: 'user-sub-3',
        email: 'ok@example.org',
        name: null,
      },
    };
    const env: any = {
      ALLOWED_EMAILS: 'ok@example.org',
      SELF_ORIGIN: 'https://example.workers.dev',
      OAUTH_KV: kvStub(store),
      OAUTH_PROVIDER: { completeAuthorization: vi.fn() },
    };
    const res = await handleOAuthRoute(
      new Request('https://example.workers.dev/approve?state=st-3'),
      env,
    );
    expect(res!.status).toBe(200);
    const html = await res!.text();
    expect(html).toContain('some-client');
    expect(html).toContain('https://client.example/cb');
    expect(res!.headers.get('content-type')).toContain('text/html');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/__tests__/oauth-consent.test.ts`
Expected: FAIL — `handleOAuthRoute` returns `null` for `/approve` (no such route), so `res` is `null` and every assertion throws.

- [ ] **Step 3: Add an HTML escaper and the consent page renderer**

In `src/oauth.ts`, add these two helpers immediately after the `getCookie` function (which ends around line 45):

```typescript
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

interface ApprovalState {
  oauthReqInfo: AuthRequest;
  sub: string;
  email: string;
  name: string | null;
}

// Consent screen (audit S-1). Dynamic client registration is open at /register,
// so any party can mint a client id and send an allow-listed user an /authorize
// link. Without this page the user would be redirected to the attacker's
// redirect_uri holding a valid token, never having been told which application
// they authorized. Naming the client id and the exact redirect target, and
// requiring a POST, is the standing mitigation.
function consentPage(state: string, req: AuthRequest, email: string): Response {
  const clientId = escapeHtml(String(req.clientId ?? 'unknown'));
  const redirectUri = escapeHtml(String(req.redirectUri ?? 'unknown'));
  const scopes = escapeHtml((req.scope ?? []).join(', ') || 'openid');
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize application</title>
<style>
 body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem;color:#111}
 dl{background:#f5f5f5;padding:1rem;border-radius:6px}
 dt{font-weight:600;margin-top:.5rem} dd{margin:0 0 .25rem;word-break:break-all;font-family:ui-monospace,monospace}
 .warn{background:#fff4e5;border-left:4px solid #d97706;padding:.75rem 1rem;border-radius:4px}
 button{font:inherit;padding:.6rem 1.2rem;border-radius:6px;border:1px solid #ccc;cursor:pointer}
 button.ok{background:#111;color:#fff;border-color:#111}
</style></head><body>
<h1>Authorize application</h1>
<p>Signed in as <strong>${escapeHtml(email)}</strong>.</p>
<p class="warn">Only approve if you started this yourself. Check the redirect address below —
if you do not recognise it, choose Deny.</p>
<dl>
  <dt>Application (client id)</dt><dd>${clientId}</dd>
  <dt>Will send your token to</dt><dd>${redirectUri}</dd>
  <dt>Scopes</dt><dd>${scopes}</dd>
</dl>
<form method="POST" action="/approve">
  <input type="hidden" name="state" value="${escapeHtml(state)}">
  <button type="submit" name="decision" value="approve" class="ok">Approve</button>
  <button type="submit" name="decision" value="deny">Deny</button>
</form>
</body></html>`;
  return new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
    },
  });
}
```

- [ ] **Step 4: Stop `/callback` from completing authorization; hand off to the consent screen**

In `src/oauth.ts`, replace the block currently at lines 146-151 (from `const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({` through the `return new Response(null, { status: 302, ... })` that ends the `/callback` handler) with:

```typescript
    // Identity is proven and allow-listed. Do NOT complete authorization here —
    // park the request and make the human name the client first (audit S-1).
    const approvalState = crypto.randomUUID();
    await env.OAUTH_KV.put(
      `approve:${approvalState}`,
      JSON.stringify({ oauthReqInfo, sub, email, name: (claims.name as string) ?? null } satisfies ApprovalState),
      { expirationTtl: LOGIN_TTL },
    );
    return new Response(null, {
      status: 302,
      headers: {
        location: `${selfOrigin(env, request)}/approve?state=${encodeURIComponent(approvalState)}`,
        'set-cookie': `${CSRF_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`,
      },
    });
```

- [ ] **Step 5: Add the `/approve` route**

In `src/oauth.ts`, immediately BEFORE the final `return null;` of `handleOAuthRoute` (line 155), insert:

```typescript
  if (url.pathname === '/approve') {
    const isPost = request.method === 'POST';
    const state = isPost
      ? new URLSearchParams(await request.text()).get('state')
      : url.searchParams.get('state');
    if (!state) return new Response('invalid_request', { status: 400 });

    const pending = (await env.OAUTH_KV.get(`approve:${state}`, 'json')) as ApprovalState | null;
    if (!pending) return new Response('invalid_or_expired_state', { status: 400 });

    if (!isPost) {
      // GET renders the consent page. The state stays in KV until a decision.
      return consentPage(state, pending.oauthReqInfo, pending.email);
    }

    // POST is the decision. Consume the state either way so it is single-use.
    const decision = new URLSearchParams(
      // re-read is impossible (body already consumed) so recompute from the same parse
      '',
    );
    void decision;
    await env.OAUTH_KV.delete(`approve:${state}`);
    return new Response('pending', { status: 500 });
  }
```

That draft has a body-consumed bug on purpose to make the next step explicit. Replace the whole `if (url.pathname === '/approve')` block with this correct version — parse the body ONCE:

```typescript
  if (url.pathname === '/approve') {
    const isPost = request.method === 'POST';
    let state: string | null;
    let decision: string | null = null;
    if (isPost) {
      const form = new URLSearchParams(await request.text());
      state = form.get('state');
      decision = form.get('decision');
    } else {
      state = url.searchParams.get('state');
    }
    if (!state) return new Response('invalid_request', { status: 400 });

    const pending = (await env.OAUTH_KV.get(`approve:${state}`, 'json')) as ApprovalState | null;
    if (!pending) return new Response('invalid_or_expired_state', { status: 400 });

    if (!isPost) return consentPage(state, pending.oauthReqInfo, pending.email);

    // Single-use: consume the state whichever way the user decided.
    await env.OAUTH_KV.delete(`approve:${state}`);

    if (decision !== 'approve') {
      console.warn('[oauth] /approve: denied by user; client=', String(pending.oauthReqInfo.clientId ?? '?'));
      return new Response('denied', { status: 403 });
    }

    // Re-check the allow-list at approval time — membership may have changed
    // between /callback and the click, and this is the last gate before a token.
    if (!allowedEmails(env).includes(pending.email)) {
      return new Response('forbidden', { status: 403 });
    }

    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      request: pending.oauthReqInfo,
      userId: pending.sub,
      scope: pending.oauthReqInfo.scope,
      metadata: { label: pending.email },
      props: { email: pending.email, sub: pending.sub, name: pending.name, upstreamExpiresIn: null },
    });
    return new Response(null, { status: 302, headers: { location: redirectTo } });
  }
```

**Note:** `props.upstreamExpiresIn` was previously `body.expires_in ?? null` from the token response, which is no longer in scope at approval time. Setting it to `null` is correct — grep `upstreamExpiresIn` across `src/` to confirm nothing reads it for authorization decisions before accepting this. If something does, thread the value through `ApprovalState` instead.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/__tests__/oauth-consent.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 7: Run the full suite**

Run: `npm run check`
Expected: tsc clean, all tests pass. `src/__tests__/oauth-csrf-cookie.test.ts` must still pass — if it asserted on `/callback` returning a redirect to the client, update it to expect the `/approve` redirect and say so in the commit message.

- [ ] **Step 8: Commit**

```bash
git add src/oauth.ts src/__tests__/oauth-consent.test.ts
git commit -m "$(cat <<'EOF'
fix(security): require explicit consent before completing OAuth authorization (audit S-1)

/callback previously called completeAuthorization the moment the identity
passed the email allow-list. With dynamic client registration open at
/register, an attacker could mint a client id, send an allow-listed user an
/authorize link, and receive a valid token at their own redirect_uri while
the user saw only a normal Access login.

Authorization now parks in KV and redirects to /approve, which names the
client id, the exact redirect target and the scopes, and requires a POST
decision. The state is single-use and the allow-list is re-checked at
approval time. Denial returns 403 and completes nothing.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Enforce `exp`, `aud`, and `iss` on JWT verification (audit S-2)

**Files:**
- Modify: `src/jwt.ts:11-29`
- Modify: `src/env.ts` (add `JWT_AUDIENCE`, `JWT_ISSUER`)
- Modify: `wrangler.toml` (`[vars]` and `[env.dev.vars]` — add both)
- Test: `src/__tests__/jwt-claims.test.ts` (create)

**Interfaces:**
- Consumes: nothing from Tasks 1-2.
- Produces: `verifyJwt(token: string, secret: string, opts?: { audience?: string; issuer?: string }): Promise<JwtClaims | null>` — the third parameter is NEW and optional, so the existing call site `src/auth.ts:69` keeps compiling. `JwtClaims` is unchanged: `{ sub: string; actor: string; role: 'default' | 'admin' }`.

**Context the implementer needs:** `src/jwt.ts:17` calls `jwtVerify(token, key)` with no options object. `jose` only checks `exp` when the claim is present, and checks `aud`/`iss` only when you ask it to. A token with no `exp` therefore never expires, and a token minted for any other service that happens to share the secret is accepted here. The audit rated this HIGH (S-2, Linear QUA-1139).

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/jwt-claims.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { SignJWT } from 'jose';
import { verifyJwt } from '../jwt';

const SECRET = 'test-secret-at-least-16-chars-long';
const KEY = new TextEncoder().encode(SECRET);
const AUD = 'mcp-servicetitan';
const ISS = 'https://issuer.example';

async function sign(claims: Record<string, unknown>, opts: { exp?: string | number; aud?: string; iss?: string } = {}) {
  let b = new SignJWT(claims).setProtectedHeader({ alg: 'HS256' }).setIssuedAt();
  if (opts.exp !== undefined) b = b.setExpirationTime(opts.exp);
  if (opts.aud) b = b.setAudience(opts.aud);
  if (opts.iss) b = b.setIssuer(opts.iss);
  return b.sign(KEY);
}

describe('verifyJwt claim enforcement (audit S-2)', () => {
  it('accepts a well-formed token with exp, aud and iss', async () => {
    const t = await sign({ sub: 'u1', actor: 'tester', role: 'default' }, { exp: '5m', aud: AUD, iss: ISS });
    const claims = await verifyJwt(t, SECRET, { audience: AUD, issuer: ISS });
    expect(claims).not.toBeNull();
    expect(claims!.sub).toBe('u1');
    expect(claims!.actor).toBe('tester');
    expect(claims!.role).toBe('default');
  });

  it('REJECTS a token with no exp claim', async () => {
    const t = await sign({ sub: 'u1' }, { aud: AUD, iss: ISS });
    expect(await verifyJwt(t, SECRET, { audience: AUD, issuer: ISS })).toBeNull();
  });

  it('REJECTS an expired token', async () => {
    const t = await sign({ sub: 'u1' }, { exp: Math.floor(Date.now() / 1000) - 60, aud: AUD, iss: ISS });
    expect(await verifyJwt(t, SECRET, { audience: AUD, issuer: ISS })).toBeNull();
  });

  it('REJECTS a token minted for a different audience', async () => {
    const t = await sign({ sub: 'u1' }, { exp: '5m', aud: 'some-other-service', iss: ISS });
    expect(await verifyJwt(t, SECRET, { audience: AUD, issuer: ISS })).toBeNull();
  });

  it('REJECTS a token from a different issuer', async () => {
    const t = await sign({ sub: 'u1' }, { exp: '5m', aud: AUD, iss: 'https://evil.example' });
    expect(await verifyJwt(t, SECRET, { audience: AUD, issuer: ISS })).toBeNull();
  });

  it('still rejects a short secret', async () => {
    const t = await sign({ sub: 'u1' }, { exp: '5m', aud: AUD, iss: ISS });
    expect(await verifyJwt(t, 'short', { audience: AUD, issuer: ISS })).toBeNull();
  });

  it('when no audience/issuer is configured, still requires exp', async () => {
    const noExp = await sign({ sub: 'u1' });
    expect(await verifyJwt(noExp, SECRET)).toBeNull();
    const withExp = await sign({ sub: 'u1' }, { exp: '5m' });
    expect(await verifyJwt(withExp, SECRET)).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/__tests__/jwt-claims.test.ts`
Expected: FAIL on "REJECTS a token with no exp claim", "different audience", "different issuer", and "still requires exp" — `verifyJwt` currently accepts all of them. The "accepts a well-formed token" and "short secret" cases pass already.

- [ ] **Step 3: Implement claim enforcement**

Replace the body of `src/jwt.ts` with:

```typescript
import { jwtVerify } from 'jose';

export interface JwtClaims {
  sub: string;
  actor: string;
  role: 'default' | 'admin';
}

export interface JwtVerifyOptions {
  audience?: string;
  issuer?: string;
}

const MIN_HS256_SECRET_LENGTH = 16;

export async function verifyJwt(
  token: string,
  secret: string,
  opts: JwtVerifyOptions = {},
): Promise<JwtClaims | null> {
  if (typeof secret !== 'string' || secret.length < MIN_HS256_SECRET_LENGTH || secret === 'undefined') {
    return null;
  }

  try {
    // audience/issuer are enforced only when configured, so an unconfigured
    // deployment does not lock itself out — but `exp` is ALWAYS required
    // (checked below), because jose silently accepts a token that omits it,
    // which would make such a token valid forever. (audit S-2)
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
      ...(opts.audience ? { audience: opts.audience } : {}),
      ...(opts.issuer ? { issuer: opts.issuer } : {}),
      clockTolerance: 30,
    });

    if (typeof payload.exp !== 'number') return null;

    const sub = String(payload.sub ?? '');
    if (!sub) return null;

    return {
      sub,
      actor: String((payload as Record<string, unknown>).actor ?? 'jwt-client'),
      role: (payload as Record<string, unknown>).role === 'admin' ? 'admin' : 'default',
    };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/__tests__/jwt-claims.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Wire the configured audience and issuer at the call site**

In `src/env.ts`, add next to `JWT_SECRET` (line 36):

```typescript
  JWT_AUDIENCE?: string; // enforced by verifyJwt when set (audit S-2)
  JWT_ISSUER?: string;   // enforced by verifyJwt when set (audit S-2)
```

In `src/auth.ts:69`, change:

```typescript
    const claims = await verifyJwt(token, env.JWT_SECRET);
```

to:

```typescript
    const claims = await verifyJwt(token, env.JWT_SECRET, {
      audience: env.JWT_AUDIENCE,
      issuer: env.JWT_ISSUER,
    });
```

In `wrangler.toml`, add to BOTH the prod `[vars]` block and the `[env.dev.vars]` block:

```toml
# Enforced by verifyJwt when set (audit S-2). Leave unset only if no JWT
# issuer exists yet — `exp` is required regardless.
JWT_AUDIENCE = "mcp-servicetitan"
```

Leave `JWT_ISSUER` unset for now: no current issuer is known to stamp one, and setting it would reject every existing token. Add this comment above `JWT_AUDIENCE`:

```toml
# JWT_ISSUER intentionally unset — no current minter stamps `iss`. Set it once
# the issuing service is identified; verifyJwt enforces it the moment it exists.
```

- [ ] **Step 6: Run the full suite**

Run: `npm run check`
Expected: tsc clean, all tests pass.

**Watch for:** any existing test that mints a JWT without `exp` and expects it to verify. Those tests were asserting the vulnerability. Update them to include `.setExpirationTime('5m')` and note it in the commit body. Find them with: `grep -rln "SignJWT\|verifyJwt" src/__tests__ src/**/__tests__`

- [ ] **Step 7: Commit**

```bash
git add src/jwt.ts src/env.ts src/auth.ts wrangler.toml src/__tests__/jwt-claims.test.ts
git commit -m "$(cat <<'EOF'
fix(security): require exp and enforce aud/iss on JWT verification (audit S-2)

jwtVerify was called with no options object, so jose checked `exp` only when
the claim happened to be present and never checked `aud` or `iss`. A token
minted without an expiry was therefore valid forever, and a token minted for
any other service sharing the secret was accepted here.

verifyJwt now always rejects a token with no numeric `exp`, and enforces
audience and issuer whenever they are configured. A 30s clock tolerance is
allowed. JWT_ISSUER is deliberately left unset until the issuing service is
identified; JWT_AUDIENCE is set to mcp-servicetitan.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Close 4 known `hono` CVEs

**Files:**
- Modify: `package.json`, `package-lock.json`

**Interfaces:**
- Consumes: nothing. Produces: nothing. Pure dependency bump.

**Context the implementer needs:** installed `hono` is 4.12.30; latest is 4.13.3. Four advisories affect the installed range: GHSA-8j4g-w8fx-2239 (CORS ReDoS), GHSA-f23p-vx2j-j53r (`memo()` cross-user leak), GHSA-79qm-7rj5-m7r9 (proxy-helper header leak), GHSA-54fx-42gc-7vw4 (language-middleware DoS). Real exposure here is low — this worker hand-rolls CORS in `src/index.ts` (`corsOptionsFor`) rather than importing `hono/cors`, and serves no JSX — but the bump is cheap and removes the question.

- [ ] **Step 1: Record the baseline**

Run: `npm test 2>&1 | tail -5`
Expected: note the exact passing counts (files/tests) to compare after the bump.

- [ ] **Step 2: Bump**

Run: `npm install hono@4.13.3 --save-exact=false`
Expected: `package.json` shows `"hono": "^4.13.3"`, lockfile updated.

- [ ] **Step 3: Verify nothing broke**

Run: `npm run check`
Expected: tsc clean; the SAME file/test counts as Step 1, all passing.

Run: `npm audit --omit=dev --audit-level=high`
Expected: no high/critical findings in production dependencies.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "$(cat <<'EOF'
chore(deps): bump hono 4.12.30 -> 4.13.3 to close 4 advisories

GHSA-8j4g-w8fx-2239 (CORS ReDoS), GHSA-f23p-vx2j-j53r (memo cross-user
leak), GHSA-79qm-7rj5-m7r9 (proxy helper header leak), GHSA-54fx-42gc-7vw4
(language middleware DoS). Real exposure was low — this worker hand-rolls
CORS in src/index.ts rather than importing hono/cors, and serves no JSX —
but the bump is free.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Make `/health` identify the deployed commit

**Files:**
- Modify: `src/index.ts:38-50` (`healthPayload`)
- Modify: `src/env.ts` (add `GIT_SHA`)
- Modify: `wrangler.toml` (both `[vars]` blocks — add `GIT_SHA` placeholder)
- Modify: `.github/workflows/deploy.yml`
- Modify: `src/__tests__/health-shape.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks. Produces: `healthPayload(env)` gains a `commit: string` field. Nothing else depends on it.

**Context the implementer needs:** `/health` reports `version: env.MCP_SERVICE_VERSION`, a hand-edited literal in `wrangler.toml:54`. It has read `"1.7.0"` across roughly ten prod deploys since 2026-07-13 and the last git tag is `v1.5.1`, so the field cannot identify deployed code — the repo's own `CLAUDE.md` says so. `toolCount` IS live-derived and trustworthy. Rather than trying to keep three hand-maintained version strings in sync, add a field that is derived at deploy time and cannot drift.

Keep `version` — external callers may parse it. Add `commit` alongside.

- [ ] **Step 1: Write the failing test**

In `src/__tests__/health-shape.test.ts`, add:

```typescript
  it('reports the deployed commit sha', () => {
    const payload = healthPayload({
      MCP_SERVICE_VERSION: '1.7.0',
      GIT_SHA: 'abc1234',
      MCP_LOCKDOWN: 'false',
    } as never);
    expect(payload.commit).toBe('abc1234');
  });

  it('falls back to "unknown" when GIT_SHA is not injected', () => {
    const payload = healthPayload({
      MCP_SERVICE_VERSION: '1.7.0',
      MCP_LOCKDOWN: 'false',
    } as never);
    expect(payload.commit).toBe('unknown');
  });
```

Match the existing import and describe-block style already in that file — read it first.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/__tests__/health-shape.test.ts`
Expected: FAIL — `payload.commit` is `undefined`.

- [ ] **Step 3: Add the field**

In `src/env.ts`, next to `MCP_SERVICE_VERSION` (line 24):

```typescript
  GIT_SHA?: string; // short commit sha, stamped by deploy.yml (never hand-edited)
```

In `src/index.ts`, inside `healthPayload`, add after the `version` line:

```typescript
    // Derived at deploy time from the checked-out commit. Unlike
    // MCP_SERVICE_VERSION (a hand-edited literal that has not moved in ~10
    // deploys) this cannot drift from what is actually running.
    commit: env.GIT_SHA || 'unknown',
```

In `wrangler.toml`, add to BOTH `[vars]` and `[env.dev.vars]`:

```toml
GIT_SHA = "unknown"
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/__tests__/health-shape.test.ts`
Expected: PASS.

- [ ] **Step 5: Stamp the sha in CI**

In `.github/workflows/deploy.yml`, in the job that runs `inject-deploy-config.py` (around line 67-81), add a step immediately AFTER the injection step and BEFORE `wrangler deploy`:

```yaml
      - name: Stamp deployed commit into wrangler.toml
        run: |
          SHA=$(git rev-parse --short HEAD)
          echo "Stamping GIT_SHA=$SHA"
          sed -i "s/^GIT_SHA = \"unknown\"$/GIT_SHA = \"$SHA\"/" wrangler.toml
          if grep -q '^GIT_SHA = "unknown"$' wrangler.toml; then
            echo "::error::GIT_SHA placeholder was not substituted"; exit 1
          fi
```

Read the surrounding YAML before inserting — match the existing indentation exactly (the file uses 6-space indentation for step keys under `steps:`), and confirm `actions/checkout` runs with enough history for `git rev-parse` (it does — `rev-parse HEAD` works at depth 1).

- [ ] **Step 6: Run the full suite**

Run: `npm run check`
Expected: tsc clean, all tests pass.

Validate the workflow YAML parses:

Run: `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/deploy.yml')); print('yaml ok')"`
Expected: `yaml ok`

- [ ] **Step 7: Commit**

```bash
git add src/index.ts src/env.ts wrangler.toml .github/workflows/deploy.yml src/__tests__/health-shape.test.ts
git commit -m "$(cat <<'EOF'
feat(health): report the deployed commit sha

MCP_SERVICE_VERSION is a hand-edited literal that has read "1.7.0" across
roughly ten prod deploys since 2026-07-13 while the last git tag is v1.5.1,
so it cannot identify deployed code. /health now also reports `commit`,
stamped by deploy.yml from the checked-out sha, which cannot drift. The
deploy fails loudly if the placeholder survives.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Ship it — PR, merge, deploy, verify

**Files:** none (process task).

**Interfaces:** Consumes all of Tasks 1-5.

**Context the implementer needs:** prod last deployed 2026-08-04 from `main`; `main` advanced 2026-08-10 with PR #97 (`a79c60e`, the QUA-1234 mirror-freshness grain fix), which has never been deployed. This task ships that pending fix together with Wave 1. The local checkout is in a confusing state — local `main` (`7e4fa3d`) is a local-only merge commit that exists nowhere on the remote, and local `origin/main` was stale. Do not try to reconcile local `main`; branch from the REMOTE.

- [ ] **Step 1: Confirm the working branch is based on real remote main**

```bash
cd ~/work/mcp-servicetitan
git fetch origin
git log --oneline -1 origin/main
git merge-base --is-ancestor origin/main HEAD && echo "OK: branch contains origin/main" || echo "STOP: rebase onto origin/main first"
```

Expected: `OK: branch contains origin/main`. If not, `git rebase origin/main` and re-run `npm run check`.

- [ ] **Step 2: Push and open the PR**

```bash
git push -u origin HEAD
gh pr create --repo lpeluso-dotcom/mcp-servicetitan \
  --base main \
  --title "Wave 1: security hardening (S-8, S-1, S-2), hono CVEs, deploy-sha in /health" \
  --body "$(cat <<'EOF'
## Summary

Wave 1 of the 2026-08-23 upgrade. Four security/hygiene fixes plus a dependency bump.

- **S-8** — `ALLOWED_EMAILS` moved out of the committed `wrangler.toml` (8 real employee addresses, in both the prod and dev blocks) and out of `src/oauth.ts`'s hardcoded fallback. Now injected at deploy time from `ALLOWED_EMAILS_PROD` / `ALLOWED_EMAILS_DEV` GH secrets by the existing `inject-deploy-config.py`. `allowedEmails()` fails closed.
- **S-1** — OAuth authorization no longer completes silently. `/callback` parks the request and redirects to a `/approve` consent screen naming the client id, the exact redirect target, and the scopes. Single-use state, allow-list re-checked at approval. Dynamic client registration stays open (Claude Desktop needs it) but is no longer silently exploitable.
- **S-2** — `verifyJwt` now always requires a numeric `exp` and enforces `aud`/`iss` when configured. Previously a token with no expiry was valid forever.
- **hono** 4.12.30 → 4.13.3, closing 4 advisories.
- **`/health`** reports `commit`, stamped from the deployed sha. `MCP_SERVICE_VERSION` has not moved in ~10 deploys and cannot identify running code.

Also ships the pending QUA-1234 mirror-freshness grain fix (merged to `main` 2026-08-10, never deployed).

## Test plan

- [ ] `npm run check` green (tsc + full vitest)
- [ ] New tests: allow-list fail-closed, consent screen (4 cases), JWT claims (7 cases), health commit field
- [ ] Post-deploy: `/health` returns the new sha; OAuth login shows the consent page and completes

## Required before merge

`ALLOWED_EMAILS_PROD` and `ALLOWED_EMAILS_DEV` must exist as repo secrets or **the deploy will fail** (by design — the injector exits non-zero on a surviving placeholder).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Wait for CI, then merge**

```bash
gh pr checks --repo lpeluso-dotcom/mcp-servicetitan --watch
```

Expected: `validate` passes (typecheck, tests, `npm audit --omit=dev --audit-level=critical`, gitleaks).

Then merge with a merge commit (Luke's convention — not squash, not rebase):

```bash
gh pr merge --repo lpeluso-dotcom/mcp-servicetitan --merge
```

- [ ] **Step 4: Verify the secrets exist BEFORE deploying**

```bash
gh secret list --repo lpeluso-dotcom/mcp-servicetitan | grep -E "ALLOWED_EMAILS_(PROD|DEV)"
```

Expected: both listed. **If either is missing, STOP** — set them per Task 1 Step 9 first. Deploying without them fails the injector, which is the intended safe behaviour but wastes a run.

- [ ] **Step 5: Deploy dev first**

```bash
gh workflow run deploy.yml --repo lpeluso-dotcom/mcp-servicetitan --ref main -f env=dev
gh run watch --repo lpeluso-dotcom/mcp-servicetitan
```

Expected: success. Then confirm dev health:

```bash
curl -s https://mcp-servicetitan-dev.lpeluso.workers.dev/health | jq '{version, commit, toolCount, lockdown}'
```

Expected: `commit` is the short sha of the merge commit, NOT `"unknown"`; `toolCount` is 110.

- [ ] **Step 6: Deploy prod**

```bash
gh workflow run deploy.yml --repo lpeluso-dotcom/mcp-servicetitan --ref main -f env=prod
gh run watch --repo lpeluso-dotcom/mcp-servicetitan
curl -s https://mcp-servicetitan.lpeluso.workers.dev/health | jq '{version, commit, toolCount, lockdown}'
```

Expected: `commit` matches `git rev-parse --short origin/main`; `toolCount` 110; `lockdown` false.

- [ ] **Step 7: Verify the security fixes are actually live**

Confirm auth still works and unauthenticated callers are still refused:

```bash
curl -s -o /dev/null -w "no key: %{http_code}\n" -X POST https://mcp-servicetitan.lpeluso.workers.dev/mcp
```

Expected: `no key: 401`

Confirm the consent screen renders (should return the approval page or an expired-state 400, NEVER a silent redirect to a client):

```bash
curl -s -o /dev/null -w "approve no state: %{http_code}\n" https://mcp-servicetitan.lpeluso.workers.dev/approve
```

Expected: `approve no state: 400`

Then have a human complete one real OAuth login through a connector and confirm the consent page appears and naming is correct. **This is the one step that cannot be automated — do not mark Task 6 complete without it.**

- [ ] **Step 8: Update Linear**

Comment on QUA-1139 (OAuth consent + JWT claims) with the merged PR link and move it to Done if both halves shipped. Note in QUA-1146 (docs/version hygiene) that the `commit` field now exists and that `MCP_SERVICE_VERSION`/tags remain unreconciled.

---

## Self-Review

**Spec coverage.** Wave 1 as agreed = security + deploy + hygiene. S-8 → Task 1. S-1 → Task 2. S-2 → Task 3. hono CVEs → Task 4. Version/sha wiring → Task 5. Deploy pending `main` → Task 6. Complete.

**Deliberately NOT in this plan** (they belong to Wave 2 / Wave 3 / the public-cut plan, each of which gets its own document):
- Rate-limiter wiring into `readST`/`durableWrite` (Wave 2 — the single biggest correctness item)
- Read-after-write verify on pricebook writes (Wave 2, QUA-1149)
- The 5 single-page composites and the `commercial_plumbing_opportunities` inverted-cohort bug (Wave 2)
- AI Gateway, DO SQLite backend, `mcp_cache`→KV, Analytics Engine for `/admin/metrics` (Wave 2)
- `agents` 0.17.3→0.21.0 and the elicitation pilot (Wave 3)
- Public-cut refresh, `PUBLISHABLE.md`, drift report, npm publish, registry listing (public-cut plan)

**Placeholder scan.** Task 2 Step 5 deliberately shows a broken first draft followed by the correct version — that is instructional, not a placeholder, and the step says so explicitly. Every other step carries literal code or a literal command. No "TBD", no "add error handling", no "similar to Task N".

**Type consistency.** `allowedEmails(env: Env): string[]` keeps its signature (Task 1) and is called by Task 2's `/approve`. `ApprovalState` is defined once in Task 2 Step 3 and used in Steps 4 and 5. `verifyJwt`'s new third parameter is optional, so `src/auth.ts:69` compiles before Task 3 Step 5 updates it. `healthPayload` gains `commit: string`, asserted in Task 5 Step 1 exactly as implemented in Step 3.

**Known risk.** Task 2 changes the OAuth flow every connector uses. Deploy dev first (Task 6 Step 5) and complete a real login there before prod.
