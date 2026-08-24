# AP-Inbox read/verify MCP tools — design

**Date:** 2026-08-24
**Repo:** `mcp-servicetitan`
**Tickets:** QUA-1167 (primary), QUA-672, QUA-1082, QUA-1244
**Status:** DRAFT — blocked on Probe 0. Do not implement until §2 resolves.

---

## 1. What this is

Move the *mechanical* read/verify logic of the `st-apinbox` skill into `mcp-servicetitan`
as three MCP tools, so the checks are versioned, tested, and carry negative controls —
instead of living in unversioned skill scripts that have regressed twice.

Scope is **read/verify only**. `createBillPantheonDemo` and `DeleteDocuments` stay in the
skill. See §8.

### 1.1 Reconciling with the 2026-08-24 architecture ruling

A same-day adversarial review kept `st-apinbox` a Skill:

> This was the load-bearing fact behind the 2026-08-24 adversarial architecture review that
> kept st-apinbox as a Skill (human-mediated auth) rather than a Cloudflare Workflow or
> standalone agent — re-check if QSC ever asks about automating AP-inbox filing without a
> human in the loop.

This design is **consistent** with that ruling, and deliberately so:

- Auth stays human-mediated — cookies are caller-supplied per call, never stored.
- These are stateless tools, not a Workflow and not a standalone agent.
- No unattended trigger. Nothing here runs on a cron.

What moves is arithmetic and set logic. What stays human is authentication and every write.
If a later change would break any of those three properties, this ruling must be re-opened
first.

---

## 2. PROBE 0 — the blocking unknown

**Nothing in §5 may be implemented until this is answered empirically.**

The `st-internal-api` skill states:

> **Why a real browser (not curl/node):** curl from the dev boxes returns 401 even with valid
> replayed cookies — ST's edge rejects raw HTTP clients (TLS fingerprint / session binding).
> Only a real Chromium TLS profile passes.

Memory contradicts this for dev boxes (2026-08-05, supersedes the skill):

> Whole pipeline — GetBillDocuments, ReadBillDocument, getFilteredJobs, validateVdn, Print,
> createBillPantheonDemo, DeleteDocuments — ran on curl + urllib with no browser and no
> Chromium profile lock.

Both can be true and still leave us blocked. "curl from dev02 works" does **not** imply "a
Cloudflare Worker's `fetch` works." Three reasons to expect a difference:

1. ST sits behind Cloudflare (the `__cf_bm` bot-management cookie is in the jar). A
   Worker egresses *from* Cloudflare's network — bot-management may score it differently.
2. `__cf_bm` has a ~30 min TTL. Any Worker path inherits a much tighter freshness window
   than the ~24h `.AspNetCore.AUTH*` cookies.
3. Session cookies may be IP-bound. Worker egress IPs are not Luke's.

**The probe:** replay one `GetBillDocuments` call from a `wrangler dev` Worker using a fresh
cookie jar, and assert HTTP 200 with a JSON body.

- **200** → proceed with §5 as written.
- **401 / Cloudflare challenge HTML** → **stop**. The tools cannot live in the Worker on a
  plain `fetch` transport. Do not build a workaround. Options then become: keep the logic in
  the skill; or split pure-compute tools (§5.2, §5.3, which need no network) into the Worker
  and leave §5.1 in the skill. Escalate to Luke either way.

This is the "stop and flag" case the scoping prompt named. It is cheap to answer and
expensive to guess wrong.

---

## 3. Auth contract

Caller-supplied, per call, never persisted.

| Header | Value | Notes |
|---|---|---|
| `Cookie` | `.AspNetCore.AUTH`, `.AspNetCore.AUTHC1`, `.AspNetCore.AUTHC2`, `__cf_bm`, `X-CSRF-Token` | values stay URL-encoded |
| `X-CSRF-Token` | URL-**decoded** value of the cookie of the same name | 403 on writes without it |
| `X-Requested-With` | `XMLHttpRequest` | not required on GETs in practice |
| `Accept` | `application/json` | |
| `Origin` | `https://go.servicetitan.com` | browser sets this automatically; **a Worker must set it by hand** |
| `Referer` | `https://go.servicetitan.com/` | same |

**No tenant** appears in any path or header. Tenant `431848990` is implied entirely by the
session cookie.

### 3.1 Argument naming is a security requirement, not a style choice

The two auth args **must** be named `session_cookie` and `csrf_token`.

`redactPayload()` in `src/tool-registry.ts` redacts by key name against
`CREDENTIAL_FIELD_PATTERNS`. `session_cookie` matches `/cookie/i`; `csrf_token` matches
`/token/i`. Both therefore land in `audit_log.payload` as `[redacted:str:N]`.

Name them anything else — `stAuth`, `verification`, `jar` — and the live session lands in D1
verbatim. A test must assert this. See §7.

### 3.2 Prohibited

Per the scoping constraint, and restated here because it is the thing most likely to erode:

- No persistence of ST session state in the Worker, D1, KV, or a DO.
- No automated login, and no refresh path that could originate a session without a human.
- No cookie in a log line, error message, or exception body.

Cookie TTLs (`.AspNetCore.AUTH*` ~24h, `__cf_bm` ~30m) mean a caller will hit expiry mid-run.
The correct behavior is a clear typed error telling the human to re-capture — never a retry
that could mask it.

---

## 4. Endpoint contracts (corrected)

Base: `https://go.servicetitan.com/app/api/accounting/inbox/`

### 4.1 `POST GetBillDocuments`

The skill's `endpoints.md` documents `{skip:0, take:1000}`. **That is wrong** and caused a
non-terminating loop on 2026-08-17. The real UI body (captured 2026-08-21):

```json
{"search":"","status":[2],"orderBy":"date","desc":true,"pageIndex":1,"pageSize":25}
```

Returns `{result: [...], totalCount: N}`. `pageSize: 2000` returns everything in one call.

**Status codes:** `1` = scan pending · `2` = pending/"Ready" · `3` = created/"Reviewed" · `4` = empty.

Row fields — note `id`, not `documentId`:

| Field | Type | Notes |
|---|---|---|
| `id` | int | **this is the documentId.** Called `documentId` on ReadBillDocument, `id` as the Print query param |
| `ocrResultId` | int | consistent everywhere |
| `originalFilename` | string | |
| `totalAmount` | number | **the invoice header total — the reconciliation target.** Lives only here, not in `billData` |
| `status` | int | see codes above |
| `scanComplete` | bool | |
| `billWasCreated` | bool | idempotency flag |

Grain is `(documentId, ocrResultId)` = one bill. A multi-invoice PDF yields several rows
sharing one `id` with distinct `ocrResultId`.

### 4.2 `GET ReadBillDocument?documentId=&ocrResultId=`

Returns `{isBillDuplicate, billData}`. **Every `billData` field is a `{value, text}` wrapper**,
including `quantity` and `itemCost`. Reading them as scalars zeroes every line total and makes
every bill report "cannot reconcile" — a documented time sink.

Fields that matter here:

- `purchasingVendor` → `.value` = vendorId (**often null**), `.text` = OCR name
- `vendorDocumentNumber` → the invoice number (called `vendorInvoiceNumber` on write)
- `taxRate` → **an amount, not a rate.** Worst-named field in the surface
- `shipping` → header-level freight charge
- `items[]` → `{sku:{value,text}, description, quantity, itemCost, fuzzyMatchId}`

**Trap:** `sku.text` is ServiceTitan's *fuzzy pricebook match*, not the vendor's line text.
The vendor's real description is `description.value`. Any classifier run on `sku.text`
produces false trade mismatches. Proof: a Johnstone line whose vendor text was `1/2" HUB`
carried `sku.text` of `1-1/2 in. No Hub Heavy Duty Domestic Cast Iron Coupling`.

`sku.value === 57454603` ("Template Item Material") = ST could not match the pricebook.

---

## 5. Tools

New directory `src/tools/ap_inbox/`, registered in `src/tools/index.ts`.

All three are `isWrite: false`. §5.2 and §5.3 take no cookie because they make no network
call.

### 5.1 `ap_inbox_list_documents`

Lists inbox rows across the pending/created boundary. This is the QUA-1167 structural fix:
`extract-classify.js:36` filters to `billWasCreated === false` before anything downstream
runs, so the existing dedup can only ever compare pending rows to each other.

**Cost constraint — this reshapes the tool.** The created-bill enrichment sweep measured
**516 `ReadBillDocument` calls / ~19 minutes at ~0.45 rows/sec**. That does not fit in a
Worker request, and approaches the 1000-subrequest ceiling. So:

- The **list** call is cheap (one `GetBillDocuments`, `pageSize: 2000`) and always runs.
- The **enrichment** (`ReadBillDocument` per row) is opt-in, bounded, and resumable.

```
statuses:        int[]  — default [2, 3]. BOTH pending and created; that span is the fix.
enrich:          bool   — default false. When true, fetch ReadBillDocument per row.
enrich_limit:    int    — default 50, max 200. Hard cap on per-row reads.
enrich_cursor:   int    — default 0. Row offset to resume from.
session_cookie:  string — required (§3.1)
csrf_token:      string — required (§3.1)
```

**Slim shape**, with two corrections to the requested spec:

```
document_id           int      (from row.id)
ocr_result_id         int
original_filename     string
total_amount          number   (header total)
status                int
bill_was_created      bool
vendor_name           string|null   ← enrich-only; billData.purchasingVendor.text
vendor_id             int|null      ← enrich-only; .value, often null
vendor_invoice_number string|null   ← enrich-only; normalized, see §6.1
is_bill_duplicate     bool|null     ← enrich-only; ST's flag. ADVISORY ONLY, see §6.3
```

**Correction 1 — `createdBillId` cannot be returned.** It does not exist on any read
surface. The row carries only the boolean `billWasCreated`. The billId appears solely in the
`createBillPantheonDemo` response, whose field name was never captured (the skill guesses four
ways: `j.billId || j.id || j.Id || j`). There is no way to ask ST "which bill did this
document become." Omit the field rather than ship one that is always null.

**Correction 2 — `vendorName` / `vendorInvoiceNumber` are not list-row fields.** They come
only from `ReadBillDocument`. So they are `null` unless `enrich: true`. The response must
carry `enriched: bool` and `next_cursor: int|null` so a caller cannot mistake an unenriched
`null` for "this bill has no invoice number."

That distinction is load-bearing: silently returning `null` for an unfetched field is the same
class of defect as ST's silent filter drop that `rejectUnsupportedSTFilters` exists to prevent.

`stEndpoint: { method: 'POST', path: '/app/api/accounting/inbox/GetBillDocuments', source: 'live' }`

### 5.2 `ap_inbox_reconcile_amount`

Pure compute. No network, no cookie. Takes line items + header and returns which mode
reconciles, or an explicit refusal.

```
header_total:  number            — row.totalAmount
tax:           number            — billData.taxRate (an AMOUNT)
shipping:      number            — billData.shipping
items:         { description, quantity, unit_cost }[]
```

**The prompt specified two modes. There are five.** Building two would regress against
behavior that is currently correct in production.

| # | Mode | Test | Emit | Seen at |
|---|---|---|---|---|
| 1 | unit | `Σ(cost×qty) + tax + shipping ≈ header` | `totalCost = cost×qty` | Johnstone, McCall's |
| 2 | extended | `Σ(cost) + tax + shipping ≈ header` | `totalCost = cost` | CES |
| 3 | tax-inclusive | `Σ(cost×qty) == header` exactly | file with `tax = 0` | Lowe's |
| 4 | bad-OCR taxRate | `tax > header` | **HOLD — never auto-resolve** | Winsupply |
| 5 | freight double-count | gap `== shipping` AND a FREIGHT line exists in `items[]` | zero `shipping` | Winsupply |

**Tolerance: `< $0.05` absolute.** Mode 1 is tried first and wins ties.

Rules that must not be softened:

- **Mode 4 always HOLDs.** Closing the gap by computing 8% SC sales tax means inventing a
  number to force reconciliation. Gate 3 forbids it. This is a policy line, not a heuristic.
- **A gap with `shipping == 0` and no FREIGHT line is NOT mode 5.** It is an OCR
  line-capture miss needing a human — the CES $80.00 case, held twice.
- **`NEITHER` is a first-class result**, not an error. It returns
  `{ mode: null, reconciles: false, reason, computed: {...} }` so the caller can log the
  arithmetic. The batch continues; the bill does not file.

**The freight bug is bidirectional**, and the prompt named only half of it. The skill's
formula is `Σ(lines) + tax` — `shipping` is absent from the *expected total* but present as an
additive field in the *write payload*. That yields two opposite failures:

- **Over-post:** freight is a line item *and* `shipping` is populated → `Σ+tax == header`
  reconciles → payload sends both → ST books header + freight. Winsupply inv `397305 01`
  missed by exactly `$56.00 == billData.shipping`, which was already a `FREIGHT FREIGHT
  EXPENSE` line at `$2.00 × 28`.
- **False skip:** freight is only in `shipping`, not a line → `Σ+tax` falls short → both
  modes fail → a good bill is wrongly skipped. Two Trane bills, $28 short.

The invariant this tool enforces: `Σ(lines) + tax + shipping ≈ header`, with freight counted
in **exactly one** place.

`stEndpoint: { method: 'GET', path: '(computed)', source: 'computed' }` — or add to
`COVERAGE_EXEMPT`. Decide at implementation; `source: 'computed'` is preferred as it keeps
the coverage report honest without growing the exempt list.

### 5.3 `ap_inbox_dedup_check`

Pure compute. Checks one candidate against the full already-created set from §5.1.

```
candidate:     { vendor_id, vendor_name, vendor_invoice_number, total_amount }
created_bills: same shape[]   — the billWasCreated === true rows
pending_bills: same shape[]   — optional; enables the intra-pending self-join
```

**Match requires all three to agree** — invoice# + vendor + amount — per QUA-1167. On the
2026-08-01 set that gave 87/87 confirmed, 0 ambiguous.

**Two independent checks are required**, because each is blind to a different case:

- candidate ↔ `created_bills` — catches the re-forwarded PDF under a new documentId. This is
  the ~$113K gap.
- `pending_bills` self-join — catches intra-pending duplicates. On 2026-08-05 all 42 pending
  returned "not already entered" from ST, yet three same-invoice pairs existed within the
  pending set.

Returns `{ is_duplicate, matched_against[], confidence, checks_run[] }`.

`source: 'computed'`.

---

## 6. Normalization

### 6.1 Invoice number

Uppercase → strip **all** whitespace → strip leading zeros.

**Do not truncate at the first space.** Real invoice numbers contain one: `396175 01`. A
naive `\S+` parse truncates them, and Carolina prints job numbers space-split as `8480 9343`.

Not stripped, deliberately: suffixes like Johnstone's `.001` (page sequence) and McCall's
`-2026-07-07` (embedded date). These *do* cause missed duplicates. Left alone because the
triple gate already makes false positives unlikely, and a page-split invoice carries a
*different amount* — so it fails the amount check anyway rather than false-matching. Revisit
with evidence, not by guess.

### 6.2 Vendor

Key on **`vendor_id`** when present. Fall back to a normalized slug only when it is null:
`re.sub(r'[^a-z0-9]', '', name.lower())`.

The current skill keys on `(v.lower().strip(), inv)`, which is why
`"McCall's Supply Inc."` and `"MCCALL'S SUPPLY, INC"` landed in different buckets and two real
duplicates escaped — inv `3873769` ($241.09) and `3872849` ($3,993.33). Without a manual
re-check, $241.09 would have been filed twice.

Note `purchasingVendor.value` is null on ~half of rows (17 of 35 auto-matched on 2026-08-21),
so the slug fallback carries real load.

**Do not port the hardcoded crosswalk.** It exists in two hand-synced places
(`vendor-crosswalk.md` and `build-file-list.py`), is 44 days stale, and already contains a
known-false entry (Lowe's is now an active ST vendor, id `83207050`). Call the existing
`inventory_vendors_list` tool and cache with a TTL. That kills the dual-source and the
staleness problem together. Out of scope for this pass — noted so it is not re-invented.

### 6.3 `isBillDuplicate` is advisory only

Return it, never branch on it. It caught **zero of 7** real duplicates on 2026-08-17 (false on
all 115 pending), and on 2026-08-01 caught 220 while missing 87 ($65,085.37).

---

## 7. Tests

TDD — each test written and seen failing before its implementation.

**The negative control is the point of QUA-1167**, quoted from the ticket:

> A check that has never failed is not a check.

`ap_inbox_dedup_check` must ship both halves:

1. Seed a pending row whose invoice# + vendor + amount match a known filed bill → assert
   flagged.
2. Seed a genuinely new invoice → assert **not** flagged.

Neither test is optional and neither may be skipped to get green.

Real-bug cases, not happy paths:

| Test | Guards against |
|---|---|
| `396175 01` survives normalization intact | first-space truncation |
| `MCCALL'S SUPPLY, INC` ≡ `McCall's Supply Inc.` | §6.2 dedup miss ($241.09 near-double-file) |
| leading zeros stripped; `0012` ≡ `12` | QUA-1167 fix |
| `{value,text}` wrappers unwrap on `quantity`/`itemCost` | the 0-of-N "cannot reconcile" parser trap |
| CES extended-mode bill reconciles | bill 83175675, $810.82 filed vs $216.88 true |
| FREIGHT line + populated `shipping` → mode 5, `shipping` zeroed | Winsupply `397305 01`, $56.00 |
| freight only in `shipping` → mode 1 reconciles, not skipped | the two $28-short Trane bills |
| `tax > header` → HOLD, never auto-resolved | Winsupply bad-OCR taxRate |
| gap, `shipping == 0`, no FREIGHT line → `NEITHER` | the CES $80.00 OCR miss |
| `enrich: false` → `vendor_invoice_number` null AND `enriched: false` | unenriched-null ambiguity |
| args named `session_cookie`/`csrf_token` are redacted by `redactPayload` | §3.1 — session in the audit log |

That last one asserts the redaction directly rather than trusting the naming convention to
survive a future rename.

**Gates:** `npm run check` (typecheck + vitest) and `bash scripts/preflight.sh --env dev`.
The coverage gate fails preflight unless each tool declares an `stEndpoint` or is added to
`COVERAGE_EXEMPT` in *both* `src/routes/admin-endpoints.ts` and `coverage_gate.test.ts`.

---

## 8. Out of scope

`createBillPantheonDemo` and `DeleteDocuments` are **not** implemented here.

### 8.1 Recommendation for a later pass

If those move into the Worker, they must use the existing `write-tool-factory.ts` /
`write-gate.ts` two-phase pattern: `dryRun: true` → HMAC-signed confirmation token (15 min
TTL, D1-backed, single-use, bound to a hash of the args) → confirm. Three findings would have
to be resolved first:

1. **`createBillPantheonDemo`'s response shape is unknown.** All 44 calls on 2026-08-17
   returned `None` where the skill's docs claim a billId. A non-exception POST is *not* proof
   of creation — verify by re-listing and confirming `billWasCreated` flipped.
2. **`DeleteDocuments` with `ocrResultId: -1` returns HTTP 200 and silently deletes nothing.**
   Worse, the skill's own verification is structurally blind to it: it compares set membership,
   and `docId/-1` is never in the before-set, so the "some not deleted" warning can never fire.
   It reads `ok:true, deletedCount:0` — a clean success for a no-op. Reject `-1` at input
   validation.
3. **Closed accounting periods** return HTTP 400 and nothing in the OCR payload predicts it.
   July 2026 closed between 08-17 and 08-21, stranding 18 bills / $49,843.81. Check
   `billDate` against the open-period boundary *before* spending effort on job matching.

### 8.2 A framing question for Luke

The scoping prompt treats these writes as high financial risk. Memory records the opposite
ruling, and asks explicitly that it be re-checked rather than silently re-litigated:

> RISK MODEL CLARIFIED by Luke (2026-07-12): QSC pays bills OUT OF QBO, not ServiceTitan. ST
> bill records created by this automation are purely a JOB-COSTING TAG [...] Luke approved FULL
> AUTONOMY (no human gate before ST bill file/delete) specifically because of this risk model.
> Do NOT reflexively treat 'creates/deletes ST AP bills' as high financial risk in future
> sessions — verify this framing still holds (QBO still the payment system of record) before
> re-litigating the autonomy decision.

Both can be reconciled: no *payment* moves, but a wrong bill still corrupts job costing, which
is the entire purpose of the program. The $113K near-miss was a job-costing harm, not a
payment harm — and it was still the most serious incident in this project's history.

**This design keeps writes out regardless**, so nothing here depends on the answer. Flagged so
the next pass starts from Luke's current position rather than an assumption.

---

## 9. Bug → tool map

| # | Bug | Fixed by | Status |
|---|---|---|---|
| 1 | Dedup structurally blind to filed bills (QUA-1167) | §5.1 `statuses: [2,3]` + §5.3 | **Fixed** |
| 2 | Unnormalized vendor dedup keys | §6.2 vendorId-first | **Fixed** |
| 3 | Freight double-count | §5.2 mode 5 | **Fixed** |
| 3b | Freight *omitted* from the gate (false skips) | §5.2 invariant | **Fixed** — not in the original prompt |
| 4 | Label regex missing `PURCHASE ORDER` | — | **Not addressed** — see below |
| 5 | Stale vendor crosswalk | §6.2 note only | **Deferred** — QUA-1244 |
| 6 | `sku.text` is ST's fuzzy match, not vendor text | §4.2 documented | Documented; no classifier in scope |
| 7 | `{value,text}` wrappers read as scalars | §5.2 + test | **Fixed** |
| 8 | XXAR misclassified as NON_BILL → delete | — | **Not addressed** — see below |

### Deliberately not addressed

**Label regex / `PURCHASE ORDER` (bug 4)** — lives in Gate 1, which parses the *PDF text
layer*, not the JSON surface these three tools read. The job number appears only in the PDF.
Porting it means bringing `pdfjs-dist` into the Worker, and that is a materially larger change
with its own failure modes (the skill's version silently swallows every PDF error, so a CDN
outage routes a whole batch toward the delete pile). Belongs in its own pass. QUA-1244 already
holds the skill-side patch, including next-line extraction and the `[78]\d{7}` widening.

**McCall's PO-field resolution** — same reason: PDF-text-layer work. Note the skill's claim
that "McCall's bills have no PO field" is **wrong**, confirmed four separate times. The real
root cause of the HOLD bucket is a *customer name* in the PO field, not an absent field.

**XXAR misclassification (bug 8)** — a bucket-rule defect in `dedup-and-bucket.py`, not a
read/verify concern. Flagged as the highest-value skill-side fix outstanding: rule #1 routes
`XXAR*` to delete under "first match wins," and XXAR is Trane's *accounts-receivable* prefix —
Trane's AR is QSC's AP. It would have deleted ~$45,284 of real payables on 2026-07-11 and
$934.96 on 2026-07-28. First flagged 2026-07-11; **still unfixed 44 days later.** This is a
larger live exposure than anything the three tools in this doc address.

---

## 10. Open questions

1. **Probe 0** (§2) — does a Worker `fetch` reach the inbox API? Blocks everything.
2. `source: 'computed'` vs `COVERAGE_EXEMPT` for §5.2/§5.3 — prefer the former.
3. Should §5.1 expose `validateVdn`? The skill never calls it, and its real path is unknown
   (four guesses 404'd on 2026-08-17). It is also structurally blind to intra-pending
   duplicates, so §5.3 is strictly better. Recommend: no.
4. Invoice-suffix normalization (§6.1) — left off deliberately. Revisit with evidence.
