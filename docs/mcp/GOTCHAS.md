# ServiceTitan API GOTCHAS — by domain

A rolling list of tested-true corrections, quirks, and traps that bit us
while wiring `mcp-servicetitan`. Each entry is *concrete* — a path, a
field rename, or a status-code surprise. Vague "be careful" notes do not
belong here.

## How to use this file

- Each gotcha is a tested-true correction or quirk that bit us.
- Update when you discover a new one. **Date each entry** (YYYY-MM-DD).
- Keep deployment-specific API notes, operating rules, and endpoint catalogs outside this public repository.
- The MCP server inventories its declared `stEndpoint` descriptors at
  `GET /admin/endpoints` (X-Sync-Key gated). Use that to confirm a tool is
  actually wired to the path you expect.

## Path & body normalizations (handled centrally in `src/st-path-builder.ts`)

These four rewrites are applied to **every** ST request before it leaves the
worker. Never re-implement them in a tool — extend the builder if you find a
fifth correction that should be central.

- `/task-management/` → `/taskmanagement/` (no hyphen). ST 404s on the
  hyphenated form despite documenting it.
- `isConfigurable` → `isConfigurableEquipment` (equipment PATCH bodies).
- `useStaticPrice` → `useStaticPrices` (pricebook write bodies — plural).
- Tenant ID auto-injected for any `/<api>/v<n>/` path missing the
  `/tenant/{id}/` segment. Callers do not provide tenant IDs; the public placeholder is rewritten at runtime from `ST_TENANT_ID`.

## Per-domain quirks

### Dispatch

- `POST /capacity-planning` vs `POST /capacity` — **DIFFERENT endpoints**
  despite both being POST-as-read.
  - `/capacity-planning` returns BU capacity counts (used by `get_capacity`).
  - `/capacity` returns bookable slots (used by `st_get_capacity_slots`).
  - Confusing them silently returns the wrong shape — there is no schema
    validation upstream. (audit 2026-04-28)
- Both must use HTTP POST. `servicetitan-proxy`'s `/api/st/read` accepts POST bodies
  for exactly this kind of "read with a complex filter" endpoint.
- `list_technicians_available` accepts an `availabilityDate` query — the
  field is named differently in the response (`technicianAvailability[]`).

### JPM (Jobs / Projects / Appointments)

- `POST /jpm/v2/.../jobs` requires `campaignId`. ST returns **422
  Unprocessable Entity** without it. `book_job` enforces this in the schema.
- `/jpm/v2/.../*-custom-fields` endpoints **400 on `page=0`**. Always
  `page=1+`. Most ST endpoints tolerate `page=0`, these specific ones do not.
- Appointment status transitions are NOT API-writable. There is no
  `PATCH /appointments/{id}` for `status`. Use the dedicated sub-routes:
  - `POST /appointments/{id}/hold` (hold)
  - `POST /appointments/{id}/confirmation` (confirm)
- `assign_technicians` is a **two-call compound** — there is no generic
  PATCH. Must `unassign-technicians` then `assign-technicians`. The dryRun
  payload shows both steps; the live path issues both.
- Projects: not yet in D1 sync as of 2026-04-29. The composite
  `project_snapshot` is deferred until Phase 2 D1 tables land.

### Reporting

- Three-step discovery + 1-step run pattern:
  `list_categories` → `list_reports` → `describe_report` → `run`.
- `describe_report` is **mandatory** before first run on an unknown
  `reportId` — the parameter schema is dynamic per report. Skipping it
  guarantees a 400 on `run` with an opaque "parameter not found" message.
- `POST /reports/{id}/data` is the data fetch (not a job-trigger). Returns
  rows synchronously.
- **Reporting `POST .../reports/{id}/data` takes `page`, `pageSize`, and
  `includeTotal` as QUERY parameters, not body fields.** The body schema
  (`Reporting.V2.ReportDataRequest`) is `additionalProperties: false` and
  carries only `parameters`. ServiceTitan does NOT reject body-placed paging —
  it silently ignores it and returns its own default page of up to 1000 rows
  with `totalCount: null`. Verified by tenant probe 2026-08-25 on report
  `accounting/155`: requested `pageSize: 3`, received 188 rows, echoed
  `pageSize: 1000`. An earlier version of this file asserted the opposite and
  is what put the parameters in the body.
- Use `st_run_report` (mode discriminator) instead of hand-rolling — it
  validates required args per mode and emits a uniform shape.

### Marketing Ads

- Four sibling attribution endpoints under `/marketingads/v2/`:
  - `job-attributions` (top-level `jobId`)
  - `web-booking-attributions` (top-level `bookingId`)
  - `web-lead-form-attributions` (top-level `leadFormId`)
  - `external-call-attributions` (top-level `externalCallId` or `callId`)
  All four take JSON; common payload `attributionData` carries UTM source/
  medium/campaign/content/term, gclid/fbclid, landingPageUrl, referrerUrl,
  sessionId, clientId. Fold via `kind=*` (see `st_post_marketing_attribution`).
- `create_call_with_campaign` POSTs `/telecom/v3/.../calls` with `campaignId`
  stitched in — distinct from full attribution writes. Use that when you
  only need the campaign association on a telecom call record.

### Accounting

- `ap-bills`, `inventory-bills`, `credit-memos` share the same filter shape
  (`createdOnOrAfter`, `modifiedOnOrAfter`, business-unit + customer filters).
  A single tool with a `subtype` discriminator is appropriate.
- `gl-accounts` is reference data — **KV-cache 24h is appropriate**, the list
  changes once a quarter at most.

### Memberships

- ST `status` filter is unreliable — passing `status=Active` does not
  exclusively return active memberships. **Always client-side re-filter for
  `status === 'Active'`**. `list_memberships_active` already does this and
  reports `_filtered: { received, kept }` when discrepancies show up.
- Phase 1 D1 sync expansion landed 2026-04-28: the `memberships` table is
  populated. Tools may flip from live-ST to D1-first reads in v1.3 — for now
  every membership tool hits live ST.
- `create_recurring_service` returns 400 if the membership is not
  `status === 'Active'`. ST's error message is unhelpful — surface this as a
  validation error before the call.

### Pricebook

- `pb_services`, `pb_materials`, `pb_equipment`, `pb_discounts_and_fees`,
  `pb_membership_types`, `pb_membership_discounts`, `pb_recurring_service_types`
  are all D1-synced as of 2026-04-28 (servicetitan-proxy nightly).
- Bulk endpoints: `POST /pricebook/v2/.../pricebook` (literal name —
  yes, the path repeats `pricebook`) for create; `PATCH` same for update.
  Singular `/services/{id}` and `/materials/{id}` exist for per-record
  edits and are what `st_patch_service` / `st_patch_material` use.
- `useStaticPrice` → `useStaticPrices` rewrite is in `st-path-builder.ts`
  for write bodies; do not re-implement at the tool layer.
- Equipment `isConfigurable` field has the same rewrite trap — use
  `isConfigurableEquipment` in source if you need to bypass the builder.

### CRM

- Customer notes are append-only (`POST /customers/{id}/notes`). There is
  no `PATCH /notes/{id}`. `add_customer_note` enforces this — the original
  v0 `update_customer_note` was renamed for accuracy.

### Telecom

- Call attribution via `create_call_with_campaign` is the *minimal* form
  (just `campaignId`). For full UTM / gclid / fbclid / landing-page payloads,
  use `st_post_marketing_attribution` with `kind=external_call`.

### Form Submissions

- Form responses reference **unit IDs**, not equipment IDs. The equipment
  join must happen at the composite layer via the `forms_equipment` D1
  table — this is why `job_closeout_report` notes "equipment join done at
  composite". (See `src/tools/composites/job_closeout_report.ts`.)

### Tasks

- Path is `/taskmanagement/` (one word, no hyphen). The dev-portal docs
  show `/task-management/` in some places, which 404s. The path-builder
  rewrites the hyphenated form so callers can use either.

### Warehouse / gold-grain revenue

- **A job with `$0` revenue is usually correct — do NOT file it as a
  pipeline defect.** This has now been raised twice against
  `gold_margin_by_bu` and closed twice. Roughly half of completed jobs in a
  month legitimately carry `$0`, for three independent reasons:
  1. **Sales / lead business units book one job per lead.** An unsold lead
     is genuinely `$0`. Whole BUs can therefore read `$0` revenue and still
     be perfectly healthy — check whether the BU is a *Sales* unit before
     concluding anything.
  2. **Test jobs** (obvious once you look at the booking contact).
  3. **Manual bypass invoice batches.** Revenue invoiced through a bypass
     batch never touches the ST *job-invoice* grain, so it can never appear
     in a job-grain fact table no matter how correct the pipeline is. This
     is the one that looks most like a bug and is not.
- Before reporting missing revenue, **pull the linked ST invoice**. If the
  invoice itself reads `total: "0.00"`, the warehouse is mirroring ST
  faithfully and there is nothing to fix at the pipeline layer.
- Both `gold_margin_by_bu` caveats travel with the payload
  (`_margin_basis`, `_revenue_basis`), not just in the tool description —
  the caller holding the numbers is exactly who is about to quote them.
  (2026-07-28)

---

*Last updated: 2026-07-28 — gold-grain revenue semantics; v1.2 ST API expansion (capacity-slots,
run-report, marketing-attribution).*
