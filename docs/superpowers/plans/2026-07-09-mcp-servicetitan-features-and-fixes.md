# mcp-servicetitan — Features & Fixes Implementation Plan (Aggressive Rollout, v2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship every actionable fix and feature from the 2026-07-09 backlog **plus** the full MCP-native surface that makes this a reference-grade MCP server (prompts, output schemas, resource links, annotations, registry distribution, eval harness) — sequenced into independently-shippable batches.

**Architecture:** mcp-servicetitan is a Cloudflare Worker (Streamable HTTP MCP via `createMcpHandler`), 91 tools, D1-first reads through the `taylor-ai` `/api/st/read` proxy with live-ST fallback, two-phase dryRun→HMAC-confirm writes, role gating. Fixes are localized per tool file; the MCP-native surface lands as ONE central migration in `src/tool-registry.ts` (legacy `server.tool` → `server.registerTool` config-object form) plus new `src/prompts/` and `src/resources/` modules registered in `buildServer`. Each phase = one reviewable PR that leaves `main` green and deployable.

**Tech Stack:** TypeScript, Cloudflare Workers, `agents/mcp`, `@modelcontextprotocol/sdk` ≥1.29 (supports protocol ≤2025-11-25 — no migration needed; features light up as clients negotiate), Zod, Vitest, D1, KV, Wrangler. Deploy = **manual `workflow_dispatch`** (NOT auto-from-main).

**Positioning target:** Only ~15 public ST MCP servers exist; none combine warehouse-backed reads, HMAC two-phase writes, role gating, prompts, structured output, and registry presence. The official MCP registry has **zero** ServiceTitan servers. This plan makes ours the reference implementation, not just the safest one.

---

## Scope & decomposition

**7 phases**, each an independent PR shipping working software:

| Phase | Theme | Ships | Protected files? |
|---|---|---|---|
| **1** | Prod-hardening | WIP reconcile, 2 broken AR tools, honest error logs, no-by-id audit, PR #41, `servicetitan.md` note | ⚠ `st.ts` (Task 1.5) |
| **2** | MCP-native surface | `registerTool` migration → titles + spec-correct annotations + `structuredContent`; **prompts** (5 workflows); **outputSchema** top-10; **resource links** for oversized composites; **browsable catalog resources** (pricebook tree, roster, report catalog) | No |
| **3** | Remaining defects | payroll non-job mapper, `margin_audit` BU filter, PR #25 | No |
| **4** | Estimate-template CRUD | 5 tools on `/sales/v2`; retires the Playwright hack | No |
| **5** | New capability | ST-77.1 add-ons, D1 readers, margin-discipline composites, shaper completion (all 91), inventory PO/returns | ⚠ maybe `read-router.ts` |
| **6** | Distribution & quality | MCP registry publication, npx/MCPB packaging, description-lint + tool-selection **eval harness**, repo consolidation design | No |
| **7** | Strategic (design-gated) | tool-packs + `listChanged`, PII role, webhook-subscription tools, filter-preservation sweep, new domains, doc/memory reconciliation, ST-78 confirm | Varies |

**Explicitly EXCLUDED** (evidence-de-scoped — do NOT build): elicitation and MCP-UI widgets (require `McpAgent`/DO re-platform or client rendering that QSC consumers lack; D1-token two-phase confirm already covers write safety), protocol "migration" (server already supports ≤2025-11-25), the `/export` bulk domain (D1 mirror covers it), most Accounting/GL writes (Woz/QBO owns them), sampling, durable Tasks.

**Cross-cutting rules:**
- Deploy only from a clean, pushed tree: `bash scripts/preflight.sh` → `Deploy to Cloudflare` `workflow_dispatch`.
- **Canary deploys (sweep amendment):** for phases touching the live Dawn/Retell path (1, 2, 4), prefer `wrangler versions upload` + gradual deployment (~10% traffic) → watch `/admin/metrics` error rate for 15–30 min → `wrangler versions deploy` to 100%. Straight 0→100 acceptable for read-only additive phases with Luke's OK.
- Any edit to a **protected file** (`src/read-router.ts`, `src/write-gate.ts`, `src/write-tool-factory.ts`, `src/composite-helpers.ts`, `src/routes/admin-guard.ts`, `src/routes/admin-endpoints.ts`, `src/tools/st_call.ts`, `src/st.ts`, `src/st-path-builder.ts`, `src/durable/*`, `migrations/0001-0003`) requires **explicit Luke approval in-session** before the edit.
- New tools declare `stEndpoint` or `coverage_gate.test.ts` fails preflight.
- `npm run check` green before every commit. TDD: watch each test fail first.

---

## Phase 1 — Prod-hardening PR

**Branch:** `fix/prod-hardening-invoicing-2026-07`
**Why first:** `get_invoice`/`get_invoice_balance` 404 in prod; `list_unpaid_invoices` silently returns **paid** invoices; PR #41 has been feeding 2014–2016 jobs into the vault `livedata` snapshot since 2026-06-21.

### Task 1.0: Reconcile uncommitted working-tree WIP  ⟵ NEW (accuracy amendment)

**Files:** none created — reconciliation.

`git status` shows uncommitted local modifications to `src/tools/invoicing/list_unpaid_invoices.ts`, `src/tools/__tests__/t6_pricebook_invoicing.test.ts`, and `src/tools/__tests__/cache-integration.test.ts` (apparent QUA-649 WIP — the client-side balance filter version, which **still contains the string-vs-number bug**). PR #41 also touches `cache-integration.test.ts` → conflict risk.

- [ ] **Step 1:** `git stash list && git diff` — review the WIP diff in full. Identify author intent (QUA-649 client-side unpaid filter).
- [ ] **Step 2:** Decide with Luke: commit the WIP as-is on a branch (preferred — this plan's Task 1.3 then fixes the numeric bug on top), or stash it. Never discard silently.
- [ ] **Step 3:** `git commit` (or `git stash push -m "qua649-wip"`) so the tree is clean, then create `fix/prod-hardening-invoicing-2026-07` from `main`.

### Task 1.1: Live-verify the `ids` filter on accounting invoices  ⟵ NEW (Step-0 probe, accuracy amendment)

**Files:** none — probe only. ST's broken-filter class means `?ids=` MUST be proven honored before we build on it (`/estimates/templates/search?ids=` is silently ignored; standing rule: verify on one row before relying).

- [ ] **Step 1:** Call the deployed `list_unpaid_invoices`-style list endpoint with an `ids` filter via an MCP client or curl probe: endpoint `/accounting/v2/tenant/{tid}/invoices?ids=279340` (through taylor-ai `/api/st/read`).
- [ ] **Step 2:** Assert the response contains **exactly** invoice 279340 (one row, matching id) — not the unfiltered first page.
- [ ] **Step 3:** Record the result in the PR description. **If `ids` is IGNORED:** fall back to filtering client-side on `data[]` after querying with a narrowing param (`jobId` — `list_invoices_job` proves job-scoped filtering works), and adjust Tasks 1.2/1.3 accordingly.

### Task 1.2: Fix `get_invoice` — no-by-id route → `?ids=`

**Files:**
- Modify: `src/tools/invoicing/get_invoice.ts`
- Test: `src/tools/__tests__/t6_pricebook_invoicing.test.ts`

Root cause (verified live 2026-07-09): ST `/accounting/v2/.../invoices/{id}` has **no by-id route** → `404 "Unable to match incoming request to an operation."`. The `tenant/000000000` in the error is a red herring (see Task 1.5).

- [ ] **Step 1: Write the failing test**

```ts
it('get_invoice fetches via ?ids= and unwraps data[0]', async () => {
  let captured = '';
  const env = makeEnv(async (url: string) => {
    captured = url;
    return new Response(JSON.stringify({ data: [{ id: 279340, total: '150.00' }] }), { status: 200 });
  });
  const result: any = await get_invoice.handler(env, { invoiceId: 279340 }, CTX);
  const endpoint = new URL(captured).searchParams.get('endpoint')!;
  expect(endpoint).toBe('/accounting/v2/tenant/000000000/invoices?ids=279340');
  expect(result.invoice).toEqual({ id: 279340, total: '150.00' });
});

it('get_invoice throws not_found when ids filter returns empty', async () => {
  const env = makeEnv(liveOk([]));
  await expect(get_invoice.handler(env, { invoiceId: 999 }, CTX)).rejects.toThrow('not found');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tools/__tests__/t6_pricebook_invoicing.test.ts -t "get_invoice fetches via"`
Expected: FAIL — current impl hits `/invoices/279340` (path segment) and returns the raw body, not `data[0]`.

- [ ] **Step 3: Write minimal implementation**

```ts
import { z } from 'zod';
import { readST } from '../../st';
import { McpError } from '../../errors';
import type { ToolDef } from '../index';

interface Args { invoiceId: number }

export const get_invoice: ToolDef<Args> = {
  name: 'get_invoice',
  description: 'Get full invoice details including line items and totals. Source: live ST (accounting invoices, fetched by id via the list endpoint — ST has no /invoices/{id} route).',
  zodSchema: { invoiceId: z.number().int().positive().describe('ST invoice ID') },
  stEndpoint: { method: 'GET', path: '/accounting/v2/tenant/{tid}/invoices', source: 'live' },
  async handler(env, args, { actor, correlation }) {
    const data = await readST<{ data?: unknown[] }>(
      env, { actor, correlation },
      '/accounting/v2/tenant/000000000/invoices',
      { ids: args.invoiceId },
    );
    const invoice = data.data?.[0] ?? null;
    if (!invoice) throw new McpError('not_found', `invoice ${args.invoiceId} not found`, { correlation });
    return { invoice, _source: 'live' };
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/tools/__tests__/t6_pricebook_invoicing.test.ts -t "get_invoice"`
Expected: PASS (both tests)

- [ ] **Step 5: Commit**

```bash
git add src/tools/invoicing/get_invoice.ts src/tools/__tests__/t6_pricebook_invoicing.test.ts
git commit -m "fix(invoicing): get_invoice fetches via ?ids= (ST has no /invoices/{id} route)"
```

### Task 1.3: Fix `get_invoice_balance` — same no-by-id fix

**Files:**
- Modify: `src/tools/invoicing/get_invoice_balance.ts`
- Test: `src/tools/__tests__/t6_pricebook_invoicing.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('get_invoice_balance fetches via ?ids= and reads balance off data[0]', async () => {
  let captured = '';
  const env = makeEnv(async (url: string) => {
    captured = url;
    return new Response(JSON.stringify({ data: [{ id: 279340, total: '150.00', balance: '25.00', payments: [] }] }), { status: 200 });
  });
  const result: any = await get_invoice_balance.handler(env, { invoiceId: 279340 }, CTX);
  const endpoint = new URL(captured).searchParams.get('endpoint')!;
  expect(endpoint).toBe('/accounting/v2/tenant/000000000/invoices?ids=279340');
  expect(result.balance).toMatchObject({ invoiceId: 279340, total: '150.00', balance: '25.00' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tools/__tests__/t6_pricebook_invoicing.test.ts -t "get_invoice_balance fetches via"`
Expected: FAIL — hits `/invoices/279340`, reads fields off the wrong shape.

- [ ] **Step 3: Write minimal implementation**

```ts
import { McpError } from '../../errors';
// ...
async handler(env, args, { actor, correlation }) {
  const data = await readST<{ data?: Array<Record<string, unknown>> }>(
    env, { actor, correlation },
    '/accounting/v2/tenant/000000000/invoices',
    { ids: args.invoiceId },
  );
  const invoice = data.data?.[0];
  if (!invoice) throw new McpError('not_found', `invoice ${args.invoiceId} not found`, { correlation });
  return {
    balance: { invoiceId: args.invoiceId, total: invoice.total, balance: invoice.balance, payments: invoice.payments },
    _source: 'live',
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/tools/__tests__/t6_pricebook_invoicing.test.ts -t "get_invoice_balance"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tools/invoicing/get_invoice_balance.ts src/tools/__tests__/t6_pricebook_invoicing.test.ts
git commit -m "fix(invoicing): get_invoice_balance fetches via ?ids= + unwraps data[0]"
```

### Task 1.4: Fix `list_unpaid_invoices` — string-balance filter no-op

**Files:**
- Modify: `src/tools/invoicing/list_unpaid_invoices.ts` (the `.filter(...)` line)
- Test: `src/tools/__tests__/t6_pricebook_invoicing.test.ts`

Root cause (verified live): ST returns `balance` as a **string** (`"0.00"`); `(inv.balance ?? 0) !== 0` is `"0.00" !== 0` → always true → paid invoices pass through. Present in the QUA-649 WIP too.

- [ ] **Step 1: Write the failing test**

```ts
it('list_unpaid_invoices excludes string "0.00" balances', async () => {
  const env = makeEnv(liveOk([
    { id: 1, balance: '0.00' },
    { id: 2, balance: '150.00' },
    { id: 3, balance: '0' },
  ]));
  const result: any = await list_unpaid_invoices.handler(env, {}, CTX);
  expect(result.invoices.map((i: any) => i.id)).toEqual([2]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tools/__tests__/t6_pricebook_invoicing.test.ts -t "excludes string"`
Expected: FAIL — returns all three ids.

- [ ] **Step 3: Write minimal implementation**

```ts
const invoices = (data.data ?? []).filter((inv) => Number(inv.balance ?? 0) !== 0);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/tools/__tests__/t6_pricebook_invoicing.test.ts -t "excludes string"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tools/invoicing/list_unpaid_invoices.ts src/tools/__tests__/t6_pricebook_invoicing.test.ts
git commit -m "fix(invoicing): list_unpaid_invoices coerces string balance (was returning paid invoices)"
```

### Task 1.5: Fix `readST`/`readSTPost` error logging — ⚠ PROTECTED FILE (`src/st.ts`)

> **GATE:** `src/st.ts` is protected. Get Luke's explicit approval before editing. Do not start otherwise.

**Files:**
- Modify: `src/st.ts` — `readST` (~lines 71–81) and `readSTPost` (~98–110)
- Test: Create `src/__tests__/st-error-logging.test.ts`

Problem: error messages interpolate the **pre-rewrite** `endpoint`, so every failure falsely prints `tenant/000000000`, masking the real URL. This is what mis-taught the memory graph that the invoice bug was a tenant bug.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from 'vitest';
import { readST } from '../st';

it('readST error message shows the resolved tenant, not the 000000000 placeholder', async () => {
  const env: any = {
    ST_TENANT_ID: '431848990',
    MCP_SYNC_KEY: 'k', MCP_SERVICE_VERSION: '0',
    ST_PROXY: { fetch: vi.fn(async () => new Response('nope', { status: 404 })) },
  };
  await expect(
    readST(env, { actor: 'v', correlation: 'c' }, '/accounting/v2/tenant/000000000/invoices/1'),
  ).rejects.toThrow('431848990');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/st-error-logging.test.ts`
Expected: FAIL — message contains `000000000`.

- [ ] **Step 3: Write minimal implementation** — resolve once, reuse in URL + error:

```ts
const resolved = rewriteTenantPlaceholders(env, endpoint);
const url = buildUrl(resolved, query);
// ...
`readST ${resp.status} on ${resolved}: ${body.slice(0, 200)}`,
```
Same `resolved`-then-reuse pattern in `readSTPost`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/st-error-logging.test.ts && npm run check`
Expected: PASS; full suite green (existing `000000000` URL assertions hold — rewrite is a no-op when `ST_TENANT_ID` is unset/placeholder in tests).

- [ ] **Step 5: Commit**

```bash
git add src/st.ts src/__tests__/st-error-logging.test.ts
git commit -m "fix(st): error messages log the resolved tenant, not the 000000000 placeholder"
```

### Task 1.6: No-by-id-route audit — `get_estimate`, `get_call`, `get_form_submission`

**Files:** read-only audit; conditional fixes to `src/tools/estimates/get_estimate.ts`, `src/tools/calls_forms/get_call.ts`, `src/tools/calls_forms/get_form_submission.ts`.

The `?ids=` trap is a **class** (independently confirmed: accounting invoices + ST Forms v2 submissions). Audit every remaining per-id GET.

- [ ] **Step 1:** Live-probe each endpoint with a real id; record whether `/{id}` 404s with "Unable to match…operation" (broken) or returns the resource (fine). Known: `/forms/v2/.../submissions/{id}` is broken → use `?formIds={f}&ids={subId}`; `/sales/v2/.../estimates/{id}` likely valid — verify.
- [ ] **Step 2:** For each BROKEN one, apply the Task-1.2 pattern (failing test → `?ids=`/documented filter + unwrap → pass → commit).
- [ ] **Step 3:** For each FINE one, add `// verified 2026-07: /{id} route valid` so the next audit skips it.
- [ ] **Step 4:** Commit per tool touched.

### Task 1.7: Add the ST Forms v2 submissions gotcha to `servicetitan.md` (doc, non-code)

**Files:** Modify `/home/taylor/qsc-infra/.claude/rules/servicetitan.md` (broken-filter section).

- [ ] Add the corrected mapping (from the Discord `#script-help` thread): `formId`→`formIds` (CSV), `createdOnOrAfter`→`submittedOnOrAfter`, `ownerId`→`owners` (+ `ownerType=Job`), `status=Completed`; **`totalCount` is always 0** (use `data.length`+`hasMore`); no `/submissions/{id}` route (use `?formIds={f}&ids={subId}`). Cross-link the general "no-by-id-route" pattern (shared with `get_invoice`).
- [ ] Commit in the qsc-infra repo.

### Task 1.8: Merge PR #41 (`list_jobs_today` ET-appointments fix)

- [ ] `gh pr checks 41` (expect green); `gh pr diff 41` (confirm output shape unchanged: `{jobs, date, _source, _warnings?}`); confirm no conflict with Task 1.0's reconciled `cache-integration.test.ts`.
- [ ] Rebase if behind `main`; re-run `npm run check`.
- [ ] `gh pr merge 41 --merge` (Luke uses merge commits, not squash).

### Task 1.9: Repo engineering shell (sweep amendment — settings + one file, no app code)

- [ ] **CODEOWNERS** — Create `.github/CODEOWNERS` mirroring the protected-modules list (`/src/st.ts @lpeluso-dotcom`, `/src/write-gate.ts @lpeluso-dotcom`, `/src/read-router.ts @lpeluso-dotcom`, `/src/write-tool-factory.ts @lpeluso-dotcom`, `/src/composite-helpers.ts @lpeluso-dotcom`, `/src/st-path-builder.ts @lpeluso-dotcom`, `/src/tools/st_call.ts @lpeluso-dotcom`, `/src/durable/ @lpeluso-dotcom`, `/src/routes/admin-guard.ts @lpeluso-dotcom`, `/migrations/ @lpeluso-dotcom`, `/src/auth.ts @lpeluso-dotcom`). GitHub then mechanically enforces what today is markdown convention.
- [ ] **Branch protection on `main`** — require PR + green `CI` status check before merge: `gh api -X PUT repos/lpeluso-dotcom/mcp-servicetitan/branches/main/protection` with required_status_checks `["CI"]`, enforce_admins false, required_pull_request_reviews (1). Confirm the manual `workflow_dispatch` deploy path is unaffected.
- [ ] Commit CODEOWNERS: `chore(repo): CODEOWNERS mirrors protected-modules; branch protection on main`.

### Task 1.10: Deploy + post-deploy smoke

- [ ] Tree clean + pushed; `bash scripts/preflight.sh`; trigger `Deploy to Cloudflare` (`workflow_dispatch`) on `main`.
- [ ] Smoke: `get_invoice`/`get_invoice_balance` on invoice 279340 return data (not 404); `list_unpaid_invoices` returns only non-zero balances; `list_jobs_today` returns current 8-digit job ids (no 50xxx-range 2014–16 rows).

---

## Phase 2 — MCP-native surface PR (the envelope phase)

**Branch:** `feat/mcp-native-surface`
**Files:** Modify `src/tool-registry.ts`, `src/tools/index.ts` (ToolDef type), `src/index.ts` (buildServer registration); Create `src/prompts/index.ts`, `src/resources/results.ts`, `src/resources/catalogs.ts`; Tests: `src/__tests__/registry-native.test.ts`, `src/__tests__/prompts.test.ts`, `src/__tests__/resources.test.ts` (new).
**Depends on:** nothing (do before Phases 4–5 so new tools inherit the surface).

### Task 2.1: Migrate `registerTool` to `server.registerTool` config-object form (titles + annotations + structuredContent)

One central change covers all 91 tools. **Spec-correct annotation derivation (amended):**

```ts
function deriveAnnotations(tool: AnyToolDef): ToolAnnotations {
  const method = tool.stEndpoint?.method ?? 'GET';
  return {
    title: tool.title ?? tool.name.replaceAll('_', ' '),
    readOnlyHint: !tool.isWrite,
    // destructiveHint DEFAULTS TO TRUE per spec when omitted — set it explicitly for every write.
    // Additive creates (POST notes/tasks) are NOT destructive; PATCH/PUT/DELETE modify existing data.
    destructiveHint: tool.isWrite ? method !== 'POST' : false,
    idempotentHint: tool.isWrite ? ['PUT', 'DELETE'].includes(method) : true,
    // ST tenant is a CLOSED world (fixed entity set) — openWorldHint false across the board.
    openWorldHint: false,
  };
}
```

- [ ] **Step 1: Write failing tests** — register a read tool, an additive write (`create_task`-shaped, POST), and a destructive write (`st_patch_service`-shaped, PATCH) through a stub `McpServer`; assert `registerTool` was called with the config-object form carrying: correct `annotations` per the table above, `title`, and that the handler result includes BOTH `content[0].text` (JSON string) and `structuredContent` (the object).
- [ ] **Step 2:** Run: `npx vitest run src/__tests__/registry-native.test.ts` — Expected: FAIL (legacy 4-arg `server.tool`, no annotations, no structuredContent).
- [ ] **Step 3: Implement** — in `src/tool-registry.ts`: switch to `server.registerTool(tool.name, { title, description, inputSchema: tool.zodSchema, outputSchema: tool.outputSchema, annotations: deriveAnnotations(tool), icons: SERVER_ICONS }, handler)`; at the result site keep the text block AND add `structuredContent: result` (spec back-compat requires the text block). Add optional `title?: string` and `outputSchema?: ZodRawShape` to `ToolDef` in `src/tools/index.ts`. Include server-level `icons` metadata (2025-11-25 spec) in the `McpServer` constructor info.
- [ ] **Step 3b: Protocol-level integration test (NEW — sweep amendment)** — `src/__tests__/mcp-protocol.test.ts`: drive `buildServer` through an in-memory `@modelcontextprotocol/sdk` **Client** (linked transport pair): `initialize` → `tools/list` (assert 91 tools, annotations present, titles present) → `tools/call get_invoice` with a mocked env (assert `structuredContent` + text block). Our 528 handler-level tests can't catch registration-layer regressions; this is the safety net for this exact migration.
- [ ] **Step 4:** `npm run check` — full suite green (528+ tests exercise handlers directly, unaffected).
- [ ] **Step 5:** Commit: `feat(mcp): registerTool migration — titles, spec-correct annotations, structuredContent for all 91 tools`

### Task 2.2: `outputSchema` for the top-10 tools

**Tools:** `get_job`, `find_customer`, `get_invoice`, `list_jobs_today`, `customer_snapshot`, `payroll_job_timesheets_list`, `search_pricebook_all`, `get_estimate`, `job_cost_actuals`, `list_unpaid_invoices`.

- [ ] Per tool: define a Zod output shape matching the ACTUAL current response (derive from the tool's return statement + existing test fixtures — do not invent fields), attach as `outputSchema`, add a test asserting a representative response validates. SDK now VALIDATES structuredContent against it — a mismatch is a caught bug, which is the point.
- [ ] TDD each; one commit per 2-3 tools. If a real response fails validation, fix the schema to match reality (never loosen to `z.any()`).

### Task 2.3: MCP prompts — 5 guided workflows

**Files:** Create `src/prompts/index.ts`; register in `buildServer` (`src/index.ts`, not protected); Test: `src/__tests__/prompts.test.ts`.

Prompts (name → args → what the message template orchestrates):
1. `morning-dispatch-brief` (`date?`) — list_jobs_today + get_capacity + dispatch_pro_alerts_list → capacity/risk brief.
2. `job-closeout-review` (`jobId`) — job_closeout_report + payroll_job_timesheets_list + job_cost_actuals → margin + completeness review.
3. `ar-chase` (`businessUnitId?`) — list_unpaid_invoices (now correct!) + get_customer → prioritized collections list with contact context.
4. `quote-follow-up` (`daysBack?`) — open_opportunities_pulitzer_feed + assigned_vs_sold_estimate_audit → stale-estimate follow-up queue.
5. `membership-outreach` (`window?`) — membership_outreach_list + get_customer_membership → expiring-membership call sheet.

- [ ] **Step 1: Write failing test** — build the server via `buildServer`, assert `prompts/list` exposes exactly these 5 with arg schemas; assert `prompts/get('ar-chase')` returns a messages array whose text names the tools to call and the output format.
- [ ] **Step 2:** Run + FAIL (no prompts registered).
- [ ] **Step 3: Implement** — `PROMPTS` array (name, title, description, `argsSchema` in Zod, `build(args) → messages`), `registerPrompts(server)` loop using `server.registerPrompt`; call it in `buildServer` after tool registration. Prompt text must name exact tool names + arg mapping + expected output table shape (these encode QSC workflow knowledge, not generic fluff).
- [ ] **Step 4:** PASS + `npm run check`.
- [ ] **Step 5:** Commit: `feat(mcp): 5 workflow prompts (dispatch brief, closeout, AR chase, quote follow-up, membership outreach)`

### Task 2.4: Resource links for oversized composite results

**Files:** Create `src/resources/results.ts`; wire in `src/tool-registry.ts` result path; Test in `src/__tests__/registry-native.test.ts`.

Design (stateless-safe): when `JSON.stringify(result).length > 80_000`, write the full payload to KV (`env.CACHE`, key `result:{correlation}`, TTL 900s), return `content: [{type:'text', text: <summary + first N rows>}, {type:'resource_link', uri: 'mcp-st://results/{correlation}', name, description, mimeType:'application/json'}]` and `structuredContent` = the truncated envelope (`{_truncated:true, _full:'mcp-st://results/…'}`). Register a `ResourceTemplate('mcp-st://results/{id}')` in `buildServer` that reads KV by id (404 → friendly "expired, re-run the tool" error).

- [ ] TDD: failing test (oversized fake result → resource_link emitted + KV write called + resource read round-trips), implement, pass, commit.
- [ ] Note: this directly offsets the structuredContent size duplication from Task 2.1 for the 7 heavy composites.

### Task 2.5: Browsable catalog resources — pricebook tree, tech roster, report catalog

**Files:** Create `src/resources/catalogs.ts`; register in `buildServer` (`src/index.ts`); Test: `src/__tests__/resources.test.ts`.

Three read-only MCP resources so clients can BROWSE reference data instead of burning tool calls (pairs with the Task 2.3 prompts, which can cite them):
1. `mcp-st://catalog/pricebook-categories` — category tree from D1 `pb_categories` (id, name, parent, active). `application/json`.
2. `mcp-st://catalog/technicians` — active roster from D1 `technicians` (id, name, role, BU — NO phone/PII; respects the redaction posture). `application/json`.
3. `mcp-st://catalog/reports` — ST report catalog: category list + per-category report ids/names via the same reads `st_run_report`'s discover modes use, cached in KV (TTL 3600s).

- [ ] **Step 1: Write failing test** — `resources/list` exposes exactly these 3 URIs with names/descriptions; `resources/read` on `pricebook-categories` returns JSON rows from a mocked D1; roster resource omits phone fields even when D1 returns them.
- [ ] **Step 2:** Run `npx vitest run src/__tests__/resources.test.ts` — Expected: FAIL (no resources registered).
- [ ] **Step 3: Implement** — `CATALOG_RESOURCES` array (uri, name, description, mimeType, `read(env) → contents`), `registerCatalogResources(server, env)` loop via `server.registerResource`; PII strip on the roster mapper; KV cache for the report catalog.
- [ ] **Step 4:** PASS + `npm run check`.
- [ ] **Step 5:** Commit: `feat(mcp): browsable catalog resources (pricebook tree, tech roster, report catalog)`

### Task 2.6: Completions for prompt arguments (sweep amendment)

**Files:** Modify `src/prompts/index.ts`; Test: `src/__tests__/prompts.test.ts`.

Wire `completable()` (SDK) around prompt args so clients autocomplete real values: `businessUnitId` (from D1 `business_units`-backed cached name list), `date` (today/yesterday/ISO), `window` (7d/30d/60d). Same cached name→ID lookup planned for Phase 3/5 name resolution — build the cache helper once here (`src/name-cache.ts`, KV TTL 1800s), reuse later.

- [ ] TDD: failing test — `completion/complete` on `ar-chase.businessUnitId` with prefix "Plumb" returns the Plumbing BU; implement; pass; commit: `feat(mcp): argument completions for workflow prompts`.

### Task 2.7: Deploy + smoke

- [ ] `npm run check`; preflight; `workflow_dispatch` deploy.
- [ ] Smoke with MCP Inspector: `tools/list` shows titles + annotations; a write tool shows `readOnlyHint:false` + correct `destructiveHint`; `prompts/list` shows 5; `resources/list` shows the 3 catalogs + results template; run `ar-chase` end-to-end; force an oversized composite and follow the resource link.

---

## Phase 3 — Remaining defects PR

**Branch:** `fix/payroll-and-margin-audit`

- **`payroll_non_job_timesheets_list`** (`src/tools/payroll/payroll_non_job_timesheets_list.ts`) — working path returns `date:null, hours:0` (mapper drops the real fields — verified live 2026-07-09) and 409s on `employeeId`. Live-probe the raw response + honored param name FIRST (QUA-694 "wrong param name" class — try `employeeIds`, check ST docs); fix the mapper to surface real `date`/`hours`/`activityCodeId` (+ timesheet-code name via D1 `timesheet_codes` if cheap); forward or reject the employee filter explicitly; `assertFilterPreservation` test.
- **`margin_audit`** (`src/tools/composites/margin_audit.ts`) — ignores `businessUnitId`; `businessUnitName`→404. Debug the composite's fanout, wire the honored BU filter through, filter-preservation test.
- **Merge PR #25** (pricebook `hours` in `search_pricebook_all`) — rebase, `npm run check`, `gh pr merge 25 --merge`.
- Deploy + smoke. Expand to bite-sized TDD at execution.

---

## Phase 4 — Estimate-template CRUD (5 tools)

**Branch:** `feat/estimate-template-crud`
**New files:** `src/tools/sales/{list_estimate_templates,get_estimate_template,create_estimate_template,update_estimate_template,delete_estimate_template}.ts`; register in `src/tools/index.ts`; tests `src/tools/__tests__/estimate_templates.test.ts`.

- Namespace = **`/sales/v2/tenant/{id}/estimate-templates`** (KB catalog's `/salestech/v2` is WRONG — QUA-473 live-verified `/sales/v2`).
- Reads via `readST`/`readSTPaged` (list: `active=Any`; per-id GET sees retired templates — verify the by-id route per the Task 1.6 class first). Writes via `defineWriteTool` (dryRun/confirm); every tool declares `stEndpoint`; new tools get `title` + `outputSchema` from day one (Phase 2 surface).
- **Traps:** item PATCH does NOT advance `modifiedOn` → after successful write, force a D1 `estimate_templates` refresh (never trust `modifiedOnOrAfter` sync); `items[]` = full-replacement/removal-by-omission; set `allowDiscounts:true` explicitly on new items.
- TDD per tool; deploy; smoke a create→read→update→delete round-trip in dev tenant paths. Expand to bite-sized TDD at execution.

---

## Phase 5 — New capability PR(s)

**Branch(es):** `feat/new-readers-and-margin-composites` (splittable into ≤3 PRs).

- **ST-77.1 add-ons** — pass through/document `summaryOfWork`, `appointmentSummaries` on `get_job`/`list_jobs_today`/`get_job_appointments`; `equipmentIds` filter forwarding + `assertFilterPreservation` on `st_list_jobs`/`list_jobs_today`.
- **Typed D1-first readers** — `list_installed_equipment`, `list_recurring_service_events` via `readD1` (`src/d1.ts`) over already-synced taylor-ai tables (migrations 0024/0027). ⚠ If `D1_TABLES` in `read-router.ts` needs extending, that file is protected — get approval.
- **Pricebook margin-discipline composites** (borrowed from printing-press) — `pricebook_markup_drift`, `pricebook_cost_drift` (since-window), `pricebook_vendor_part_gaps` over `pb_services`/`pb_materials` D1. Read-only. **Respect dynamic pricing: cost=0/null is NOT an error** (hard rule).
- **Response-shaper completion** — `transformResult` on the 7 raw composites first (`call_quality_review`, `commercial_plumbing_opportunities`, `dispatch_override_audit`, `margin_audit`, `membership_jackpot_leaderboard`, `membership_outreach_list`, `pricebook_health_check_services`), then sweep the remaining ~60 tools to 91/91 (aggressive target; mechanical once the pattern is set).
- **Inventory** — `inventory_purchase_orders_list`, `inventory_returns_list` via `readST` on `/inventory/v2/...`.
- TDD each tool; deploy; smoke. Expand at execution.

---

## Phase 6 — Distribution & quality PR(s)

**Branch:** `feat/distribution-and-evals`

- **Registry publication (first-mover: zero ST servers in the official MCP registry).** Target = the OSS sibling `lpeluso-dotcom/servicetitan-mcp` (BYO-creds, remote Worker). Author `server.json` (remote transport, env-var docs), publish via `mcp-publisher` CLI with GitHub-namespace auth; verify it resolves in registry search. Also submit/refresh listings on Glama + PulseMCP.
- **npx packaging** — publish the OSS sibling's stdio-shim (or document remote-URL install) so `npx`-style one-command setup works for Claude Desktop/Code users; evaluate an `.mcpb` bundle for Desktop one-click after (Rowvyn/mvanhorn precedent).
- **Description lint (static eval)** — a vitest file asserting every tool description states: data source (D1 vs live), when-to-use, and filter behavior; every write tool description mentions dryRun/confirm. Fails CI on drift — the with-91-tools description quality IS the agent UX.
- **Tool-selection eval harness (LLM eval)** — `scripts/evals/tool-selection.ts`: ~20 natural-language QSC scenarios ("what did we make on job X?", "who's on call tomorrow?") → ask Claude (Haiku, `ANTHROPIC_API_KEY`-gated, non-CI) to pick a tool from `tools/list` → score against expected tool. Report top-1/top-3 accuracy; failures feed description fixes. Nobody in the surveyed ecosystem does this.
- **Repo consolidation design memo** — generate the OSS sibling FROM `mcp-servicetitan` (strip proxy/composites, swap direct-ST auth) vs shared-core package; memo → Luke decision (build in Phase 7 if approved).
- **MCP Inspector CLI smoke in CI (sweep amendment)** — post-deploy GitHub Actions job: `npx @modelcontextprotocol/inspector-cli --transport http --url https://mcp-servicetitan.lpeluso.workers.dev/mcp` scripted assertions (tools/list count, prompts/list count, one read call) — automates the manual smoke.
- **Release automation (sweep amendment)** — release-please (or changesets) wired to CI: conventional commits → version bump + CHANGELOG + GitHub Release. Kills the recurring version drift (README said 1.5.1 while live was 1.7.0).

---

## Phase 7 — Strategic (each gated by its own design pass)

- **Tool-packs / domain views + `listChanged`** — env/role/header-selected subsets (payroll/dispatch/pricebook/accounting/voice); emit `notifications/tools/list_changed` when a session's pack switches. The real context lever for 91+ tools; validated externally by Rowvyn's `ST_DOMAINS`. Touches `toolsForRole`/`src/auth.ts`.
- **OAuth 2.1 modernization (sweep amendment)** — extend the existing `workers-oauth-provider` wrap (PR #35) to full spec posture: Protected Resource Metadata (RFC 9728 `.well-known/oauth-protected-resource`), Dynamic Client Registration, and scopes mapped to tool-packs/roles. Replaces the URL-token connector hack (`/c/<token>/mcp`) with the sanctioned connector path. Design pass first — touches `src/auth.ts`/`src/oauth.ts` (protected).
- **PII-minimization reporting role** — aggregate-before-return (jrhoades1 pattern) for a reporting-only audience.
- **Webhook-subscription tools** — `register_webhook`/`list_webhooks` (we ingest at `/webhooks/st` but can't manage subscriptions).
- **Filter-preservation sweep** — extend `assertFilterPreservation` from 7/90 toward full coverage; one test per tool, incremental.
- **New domains** — `location-findings` (deferred-work → follow-up revenue), `technician-skills` (Dispatch-Pro visibility).
- **Doc/memory reconciliation** — KB + `protected-modules.md`: "v1.4/74/deploy-broken/CI-auto" → "v1.7.0/91/manual workflow_dispatch"; fix the graph's wrong `get_invoice` tenant-bug diagnosis; log the `list_unpaid_invoices` string-filter bug + the Discord-as-source finding.
- **ST-78 API-delta confirmation** — drive the dev-portal SPA with the `st-internal-api` skill (Playwright + session); harvest ST-77.3/78 endpoint additions into Phase 4/5-style tool candidates. (Product-level ST-78 themes already known: Speed-to-Lead, Project Financials Forecasting, Affirm, RFI pins.)
- **Consolidation build** — if the Phase 6 memo is approved.

---

## Self-review

- **Spec coverage:** All backlog items (defects D1–D5, PRs #41/#25, infra #5/#6, endpoints #10–#16, strategic #17–#24) map to phases; the four review amendments (WIP reconcile = Task 1.0, `ids` probe = Task 1.1, spec-correct annotations = Task 2.1, size-duplication note = Task 2.4) are folded in; the envelope additions (prompts, outputSchema, resource links, registry, evals) are Phases 2 + 6. De-scoped items listed. ✔
- **Placeholder scan:** Phases 1–2 carry full code + exact commands; Phases 3–7 are concrete task specs explicitly marked "expand to bite-sized TDD at execution" per decomposition rules. No TBDs. ✔
- **Type consistency:** `readST(env, ctx, endpoint, query?)` returns parsed body; list unwrap `.data?.[0]`; `McpError(code, message, {correlation})` matches `errors.ts` usage; `ToolDef` gains optional `title`/`outputSchema` in Task 2.1 and Phase 4/5 tools reference them only after that. `deriveAnnotations` consumes `stEndpoint.method` which every non-exempt tool has (coverage gate). ✔
- **Protected-file gates:** `st.ts` (Task 1.5), possible `read-router.ts` (Phase 5) — flagged with explicit approval requirement. ✔
- **Risk order:** Phase 1 fixes prod-wrong-data first; Phase 2 is additive/central; write-capable features (Phase 4) come after the safety surface (Phase 2) exists. ✔

## Execution handoff

Track chosen: **subagent-driven** (fresh subagent per task, review between tasks, verification-before-completion). Recommended order 1→2→3→4→5→6→7; each phase = one PR, `npm run check` green, manual `workflow_dispatch` deploy + smoke. Phase 1 starts at Task 1.0 (WIP reconcile — needs Luke's call on commit-vs-stash) and Task 1.5 needs Luke's protected-file approval when reached.
