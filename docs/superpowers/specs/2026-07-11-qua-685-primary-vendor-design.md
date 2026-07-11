# QUA-685 — Add `primaryVendor` to `st_create_material`

- **Date:** 2026-07-11
- **Ticket:** [QUA-685](https://linear.app/quality-service-company/issue/QUA-685) (type.bug, sev via dept.IT-Systems, High)
- **Repo:** `mcp-servicetitan` (v1.7.0), branch `lpeluso/qua-685-primary-vendor` off `origin/main`
- **Status:** design approved 2026-07-11

## Problem

`st_create_material` cannot create any material in QSC's tenant. ServiceTitan requires **exactly one primary vendor** on material creation, but the tool's schema exposes no vendor field — every confirmed write POSTs without one, ST returns **400 "There must be exactly one vendor selected as Primary" and rolls back** (no partial material lands). Blocked a 13-material batch on 2026-07-05.

**Verified live 2026-07-11 (this session):**
- Current `src/tools/st_create_material.ts` (v1.7.0, on `main`) `Args` + `zodSchema` = `name, categoryId, code, description, cost, price, active, unitOfMeasure, dryRun, confirmation_token`. No vendor field.
- A dryRun preview produced payload `{cost, displayName, categories:[…]}` — no `primaryVendor`. A confirmed write would 400 + roll back.
- `src/tools/pricebook-payload.ts` `toStPricebookPayload` spreads `{...payload}` and only rewrites `name→displayName`, `categoryId→categories`, drops `useStaticPrice`. **A new `primaryVendor` key flows through untouched** — no mapper change needed.
- ST material read shape (live `search_materials`) confirms `primaryVendor: {id, vendorName, vendorId, cost, active, …}`; writable shape is the root-level singular object `{vendorId, cost, active}` (per `st-pricebook` skill: `vendors:[]` / `vendorPricingLinks:[]` are read-only/dropped shapes — do not use).

## Scope

**In scope:** the tool fix, tests, and deploy to prod, with a live create + read-back as the acceptance test.

**Out of scope (separate follow-ups):**
- The 13 blocked materials (ticket lists bare part numbers only; creating them needs per-part vendorId/categoryId/name/cost).
- `st_create_equipment` — no such tool exists today; equipment POST has the same ST vendor requirement (note for a future tool).

## Design

### Vendor is mandatory, accepted via either form

Vendor is **required**, but supplied via **either** a nested object **or** flat shorthand. Because two input forms are allowed, "required" is enforced as a **dryRun validation guard**, not a bare zod-required field. Missing vendor → the dryRun fails with a clear message, so an unwritable material never reaches ST.

### 1. Schema additions (`st_create_material.ts` — `Args` interface + `zodSchema`)

```ts
primaryVendor: z.object({
  vendorId: z.number().int().positive().describe('ST vendor ID (see inventory_vendors_list)'),
  cost:     z.number().optional().describe('Vendor cost per unit; defaults to the material cost when omitted'),
  active:   z.boolean().default(true).describe('Whether this vendor link is active'),
}).optional().describe('Primary vendor — REQUIRED by ST (exactly one). Supply this or primaryVendorId.'),
primaryVendorId:   z.number().int().positive().optional().describe('Shorthand: primary vendor ID (alternative to the primaryVendor object)'),
primaryVendorCost: z.number().optional().describe('Shorthand: primary vendor cost (used with primaryVendorId; defaults to material cost)'),
```

Tool `description` string updated to state that a primary vendor is required.

### 2. Handler normalization (local `resolvePrimaryVendor` helper, co-located in `st_create_material.ts`)

Kept out of the shared `toStPricebookPayload` so material-vendor logic doesn't leak into service/patch transforms.

Resolution order:
1. nested `primaryVendor` present → use it (fill `cost ?? materialCost`, `active ?? true`);
2. else `primaryVendorId` present → `{vendorId: primaryVendorId, cost: primaryVendorCost ?? materialCost, active: true}`;
3. else → `throw new McpError('validation_error', 'primaryVendor is required: ST rejects a material create without exactly one primary vendor. Pass primaryVendor:{vendorId,…} or primaryVendorId.', { correlation })`.

The handler builds `{...rest, primaryVendor: resolved}` and **strips the flat `primaryVendorId`/`primaryVendorCost` keys** so only a clean `primaryVendor` object flows onward.

### 3. Payload flow (unchanged transform)

`{...rest, primaryVendor}` → `toStPricebookPayload` (spreads `primaryVendor` through untouched) → `POST /pricebook/v2/tenant/431848990/materials`. No change to `toStPricebookPayload`.

## Testing (TDD — write failing tests first, watch each fail)

Target files: `src/tools/__tests__/schemas.test.ts` (schema) and the write-tools dryRun test (payload/preview assertions).

1. **Schema** accepts the nested `primaryVendor:{vendorId,cost,active}` form and the flat `primaryVendorId`/`primaryVendorCost` form.
2. **Required guard:** dryRun with no vendor (neither form) → `validation_error`.
3. **Nested passthrough:** dryRun with nested vendor → preview payload contains `primaryVendor:{vendorId,…}` + `categories:[…]`, and **no** `primaryVendorId`/`primaryVendorCost` leak.
4. **Flat normalization:** dryRun with `primaryVendorId` only → preview payload has normalized `primaryVendor` with `cost` defaulted to the material `cost` and `active:true`.

## Deploy + acceptance

- Fresh branch off `origin/main` → implement → PR referencing QUA-685.
- `tsc --noEmit` clean + full vitest green before deploy.
- Deploy only on Luke's explicit go-ahead (CI auto-deploys from `main`; the 10-ahead `feat/distribution-and-evals` branch stays untouched).
- **Acceptance (the real test):** a live confirmed create lands a material in ST (read-back GET 200 with the correct primary-vendor link), on a disposable test material that is then deactivated/cleaned up.
- Update the `st-pricebook` skill row (`SKILL.md` flags this gap) → mark resolved once shipped.

## Risks / notes

- Making vendor mandatory changes the tool signature, but the tool is 100% broken today — no working caller regresses.
- Deploy base is `main` == live prod v1.7.0; the fix is additive (one tool file + tests), low blast radius.
- Transient taylor-ai D1 CPU-throttle (QUA-764) is unrelated to this write path.
