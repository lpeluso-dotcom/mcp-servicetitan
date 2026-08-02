# QUA-685 — `primaryVendor` on `st_create_material` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `st_create_material` create materials in ServiceTitan by adding a required `primaryVendor` (nested object + flat shorthand, cost-defaulting), enforced at dryRun time.

**Architecture:** Vendor is mandatory but accepted via a nested `primaryVendor` object OR flat `primaryVendorId`/`primaryVendorCost` shorthand. A local `resolvePrimaryVendor` helper in the tool normalizes to `{vendorId, cost, active}`, defaults cost to the material cost, and the handler throws `validation_error` when absent. The normalized object flows through the existing `toStPricebookPayload` (which spreads unknown keys) to ST unchanged.

**Tech Stack:** TypeScript, Zod, Cloudflare Workers, Vitest.

**Base:** branch `lpeluso/qua-685-primary-vendor` off `origin/main` (v1.7.0 == live prod). Files: `src/tools/st_create_material.ts` + its two test files. `toStPricebookPayload` is unchanged.

---

### Task 1: Failing tests (schema + handler), including fixups for the two now-broken existing tests

**Files:**
- Modify: `src/tools/__tests__/schemas.test.ts` (`st_create_material schema` block, ~L241-250)
- Modify: `src/tools/__tests__/st_write_tools.test.ts` (`st_create_material` describe ~L224-242 and pricebook-transform preview test ~L285-291)

- [ ] **Step 1: Add schema-layer tests** — append inside `describe('st_create_material schema', …)` in `schemas.test.ts`:

```ts
  it('accepts a nested primaryVendor', () => {
    expect(s.safeParse({ name: 'R-22', categoryId: 10, primaryVendor: { vendorId: 555 } }).success).toBe(true);
  });

  it('accepts flat primaryVendorId shorthand', () => {
    expect(s.safeParse({ name: 'R-22', categoryId: 10, primaryVendorId: 555, primaryVendorCost: 9.5 }).success).toBe(true);
  });

  it('rejects a non-positive vendorId', () => {
    expect(s.safeParse({ name: 'R-22', categoryId: 10, primaryVendor: { vendorId: 0 } }).success).toBe(false);
  });
```

- [ ] **Step 2: Fix the two existing handler tests that now lack a required vendor** — in `st_write_tools.test.ts`, update the calls so the dryRun path still runs:

Line ~227 (`dryRun=true returns DryRunResult for material create`):
```ts
    const result: any = await st_create_material.handler(env, { name: 'R-22', categoryId: 10, primaryVendorId: 555 }, CTX);
```

Line ~287 (`st_create_material dryRun preview uses displayName + categories`):
```ts
    const result: any = await st_create_material.handler(env, { name: 'WidgetMat', categoryId: 99, code: 'WM-1', primaryVendorId: 555 }, CTX);
```

- [ ] **Step 3: Add handler-layer tests** — append a new describe block at the end of `st_write_tools.test.ts`:

```ts
// ── QUA-685: st_create_material requires a primaryVendor ──────
describe('st_create_material primaryVendor (QUA-685)', () => {
  it('throws validation_error when no vendor is supplied', async () => {
    const env = makeEnv(dryRunFetch());
    await expect(st_create_material.handler(env, { name: 'NoVendorMat', categoryId: 10 }, CTX))
      .rejects.toMatchObject({ code: 'validation_error' });
    expect(env.ST_PROXY.fetch).not.toHaveBeenCalled();
  });

  it('nested primaryVendor flows to the ST payload verbatim', async () => {
    const env = makeEnv(dryRunFetch());
    const result: any = await st_create_material.handler(env,
      { name: 'VendMat', categoryId: 10, primaryVendor: { vendorId: 555, cost: 12, active: true } }, CTX);
    expect(result.payload).toMatchObject({ displayName: 'VendMat', categories: [10], primaryVendor: { vendorId: 555, cost: 12, active: true } });
    expect(result.payload).not.toHaveProperty('primaryVendorId');
    expect(result.payload).not.toHaveProperty('primaryVendorCost');
  });

  it('flat primaryVendorId normalizes to a nested vendor, cost defaults to material cost', async () => {
    const env = makeEnv(dryRunFetch());
    const result: any = await st_create_material.handler(env,
      { name: 'FlatVendMat', categoryId: 10, cost: 9.5, primaryVendorId: 555 }, CTX);
    expect(result.payload.primaryVendor).toMatchObject({ vendorId: 555, cost: 9.5, active: true });
    expect(result.payload).not.toHaveProperty('primaryVendorId');
    expect(result.payload).not.toHaveProperty('primaryVendorCost');
  });
});
```

- [ ] **Step 4: Run tests, verify the new ones FAIL**

Run: `npx vitest run src/tools/__tests__/st_write_tools.test.ts src/tools/__tests__/schemas.test.ts`
Expected: the 3 new schema tests fail (fields not in schema → `primaryVendor`/`primaryVendorId` rejected by strict? no — extra keys pass z.object by default, so schema tests may PASS; the `rejects non-positive vendorId` will FAIL because vendorId isn't validated). The handler tests FAIL: `validation_error` one fails (no guard yet → falls through to dryRun success), and the two passthrough tests fail (`primaryVendor` absent from payload / flat keys leak). Confirm red before implementing.

---

### Task 2: Implement schema fields + `resolvePrimaryVendor` + handler guard

**Files:**
- Modify: `src/tools/st_create_material.ts`

- [ ] **Step 1: Extend the `Args` interface** — add after `unitOfMeasure?`:

```ts
  primaryVendor?: { vendorId: number; cost?: number; active?: boolean };
  primaryVendorId?: number;
  primaryVendorCost?: number;
```

- [ ] **Step 2: Add the vendor fields to `zodSchema`** — add after the `unitOfMeasure` line:

```ts
    primaryVendor: z.object({
      vendorId: z.number().int().positive().describe('ST vendor ID (see inventory_vendors_list)'),
      cost: z.number().optional().describe('Vendor cost per unit; defaults to the material cost when omitted'),
      active: z.boolean().default(true).describe('Whether this vendor link is active'),
    }).optional().describe('Primary vendor — REQUIRED by ST (exactly one). Supply this or primaryVendorId.'),
    primaryVendorId: z.number().int().positive().optional().describe('Shorthand: primary vendor ID (alternative to the primaryVendor object)'),
    primaryVendorCost: z.number().optional().describe('Shorthand: primary vendor cost (used with primaryVendorId; defaults to material cost)'),
```

- [ ] **Step 3: Add the `resolvePrimaryVendor` helper** — above the `export const st_create_material`:

```ts
type ResolvedVendor = { vendorId: number; cost?: number; active: boolean };

// ST requires exactly one primary vendor on material create. Accept either a
// nested primaryVendor object or the flat primaryVendorId/primaryVendorCost
// shorthand; default the vendor cost to the material cost. Returns null when
// no vendor was supplied (caller turns that into a validation_error).
function resolvePrimaryVendor(
  nested: Args['primaryVendor'],
  flatId: number | undefined,
  flatCost: number | undefined,
  materialCost: number | undefined,
): ResolvedVendor | null {
  if (nested && typeof nested.vendorId === 'number') {
    return { vendorId: nested.vendorId, cost: nested.cost ?? materialCost, active: nested.active ?? true };
  }
  if (typeof flatId === 'number') {
    return { vendorId: flatId, cost: flatCost ?? materialCost, active: true };
  }
  return null;
}
```

- [ ] **Step 4: Rewrite the handler body** to normalize the vendor and strip the flat keys:

```ts
  async handler(env, args, { actor, correlation }) {
    const { dryRun = true, confirmation_token, primaryVendorId, primaryVendorCost, ...rest } = args;
    const vendor = resolvePrimaryVendor(rest.primaryVendor, primaryVendorId, primaryVendorCost, rest.cost);
    if (!vendor) {
      throw new McpError('validation_error',
        'primaryVendor is required: ServiceTitan rejects a material create without exactly one primary vendor. ' +
        'Pass primaryVendor:{vendorId,…} or primaryVendorId.', { correlation });
    }
    const payload = { ...rest, primaryVendor: vendor };
    const stPayload = toStPricebookPayload(payload);
    const gate = new WriteGate(env);

    if (dryRun) {
      return gate.dryRun('st_create_material', payload, actor, correlation, stPayload, '/pricebook/v2/tenant/000000000/materials', 'POST', 5 * 60 * 1000);
    }
    if (!confirmation_token) {
      throw new McpError('validation_error', 'confirmation_token required when dryRun=false', { correlation });
    }
    await gate.verifyToken('st_create_material', payload, actor, confirmation_token);
    return durableWrite(env, { actor, operation: 'material.create', target: { id: '0', type: 'material' }, payload: stPayload, correlation });
  },
```

- [ ] **Step 5: Update the tool `description`** — append to the description string: `' A primary vendor is required (primaryVendor:{vendorId} or primaryVendorId) — ST rejects a create without exactly one.'`

- [ ] **Step 6: Run the two test files, verify GREEN**

Run: `npx vitest run src/tools/__tests__/st_write_tools.test.ts src/tools/__tests__/schemas.test.ts`
Expected: PASS (all, including the updated existing tests).

---

### Task 3: Full verification + commit

- [ ] **Step 1: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 2: Full test suite**

Run: `npx vitest run`
Expected: all green (no regression in coverage_gate / description-lint / registry count 99).

- [ ] **Step 3: Commit**

```bash
git add src/tools/st_create_material.ts src/tools/__tests__/st_write_tools.test.ts src/tools/__tests__/schemas.test.ts
git commit -m "feat(st_create_material): require primaryVendor (QUA-685)

ST rejects a material create without exactly one primary vendor.
Add a required primaryVendor accepted as a nested object or flat
primaryVendorId/primaryVendorCost shorthand; default vendor cost to
the material cost; enforce presence at dryRun time. Flows through
toStPricebookPayload unchanged.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: PR + deploy (main-based, Luke-authorized)

- [ ] **Step 1: Push branch + open PR**

```bash
git push -u origin lpeluso/qua-685-primary-vendor
gh pr create --title "feat(st_create_material): require primaryVendor (QUA-685)" --body "Closes QUA-685. …"
```

- [ ] **Step 2: Merge to `main`** (CI auto-deploys from `main`). Confirm the deploy workflow runs green: `gh run list --workflow=deploy.yml -L 3`.

- [ ] **Step 3: Confirm live `/health`** reflects the deploy (version/tool count unchanged at 99; the change is additive to one tool).

---

### Task 5: Live acceptance — real create + read-back + cleanup

- [ ] **Step 1:** Resolve a real vendor + material category (`inventory_vendors_list`, an existing material's `categoryId`, e.g. 20865340).
- [ ] **Step 2:** `st_create_material` dryRun with `primaryVendorId` → capture `confirmation_token`; confirm payload carries `primaryVendor`.
- [ ] **Step 3:** Confirm write (`dryRun:false` + token) → expect a created material id (no 400 "exactly one vendor selected as Primary").
- [ ] **Step 4:** `search_materials`/read-back the new id → assert `primaryVendor.vendorId` matches.
- [ ] **Step 5:** Deactivate the disposable test material (`st_patch_material {id, active:false}`) so it doesn't pollute the pricebook.

---

### Task 6: Document + close ticket

- [ ] **Step 1:** Update `qsc-infra/.claude/skills/st-pricebook/SKILL.md` — mark the `st_create_material` primaryVendor gap resolved.
- [ ] **Step 2:** Add a one-line note to `qsc-infra/.claude/rules/protected-modules.md` mcp-servicetitan row (primaryVendor shipped, QUA-685).
- [ ] **Step 3:** Post a "shipped + live-verified" comment on QUA-685 and set state Done.

---

## Self-Review

- **Spec coverage:** schema fields (T2.2) ✓; required-via-guard (T2.4) ✓; nested+flat+cost-default (T2.3 helper) ✓; flat-key stripping (T2.4 destructure) ✓; passthrough unchanged (no `toStPricebookPayload` edit) ✓; TDD tests (T1) ✓; deploy from main (T4) ✓; live acceptance (T5) ✓; docs (T6) ✓.
- **Placeholder scan:** PR body `…` in T4.1 is a fill-at-time convenience, not a code placeholder; all code steps contain full code.
- **Type consistency:** `resolvePrimaryVendor(nested, flatId, flatCost, materialCost)` signature matches the T2.4 call `resolvePrimaryVendor(rest.primaryVendor, primaryVendorId, primaryVendorCost, rest.cost)`; `ResolvedVendor.active` is non-optional (defaulted), `cost` optional — consistent with the payload assertions in T1.3.
- **Note:** vendor is zod-optional but handler-required, so the existing schema test `accepts minimal create payload {name, categoryId}` stays valid (zod layer) while the handler rejects it (business layer) — intentional two-layer split.
