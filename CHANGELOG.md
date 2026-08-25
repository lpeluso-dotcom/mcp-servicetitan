# Changelog

## Unreleased

### `semantic_search_gold` — trade-coverage warning derived at runtime (fixes a stale prod claim)
- **The `trade_filter_excludes_untagged` warning no longer hardcodes its figures.** It shipped with "62.3% of the index (217,581 of 348,996 chunks) has a NULL trade_bu ... invoice_item, estimate_line, location, pricebook and membership are 100% untagged". After QUA-1059 (gold widening) and QUA-1060 (chunk-template enrichment + a 215,217-chunk re-embed) the live figures were **8.9% overall, invoice_item 0.0%, estimate_line 3.6%, membership 0.8%, location 40.1%** — so prod was misstating the number *and* giving inverted advice ("re-run without `trade` to search the full corpus"). Verified live against `nlaaliehqpgskjmiuzze` 2026-07-28: the tool returned trade-tagged `estimate_line` rows in the same response whose warning called `estimate_line` 100% untagged.
- **New `src/tools/gold/trade_coverage.ts`** — measures the NULL-`trade_bu` share of `vec.entity_chunks` at call time. The noun list is discovered from `vec.pii_allowlist` (not a literal array), per-noun shares are counted live, and any untagged chunk not attributed to a discovered noun is reported as `other_untagged_chunks` rather than dropped. Only `pricebook` + `pricebook_category` are *classified* as untagged BY DESIGN (qsc-vector's `TRADE_BU_COLUMN` deliberately omits them — the 65 ST category roots are supplier catalogues, not trades); their share is still measured, so the label is the only thing written down.
- **Wording is now proportionate to the measurement.** Below a 0.5% untagged share the warning is omitted entirely; the "search the full corpus instead" advice only appears at/above 25%. Below that it names the specific nouns to reach and states the tagged share (currently "the other 91.1% of the index IS tagged"). The named-noun list is capped at 6 with the tail rolled into one weighted clause.
- **Cost + staleness:** read through the shared D1 `mcp_cache` with a 6h TTL, and only probed when a `trade` filter was actually passed — an untraded search makes exactly one Supabase call, as before. A cache miss costs ~30 small PostgREST count requests in bounded-concurrency batches (~3 sequential hops). Reported figures can trail the nightly qsc-vector re-embed (09:30 UTC) by up to 6h; `measured_at` is carried in the warning.
- **Fails soft.** `getTradeCoverage` returns `null` on any failure and the warning degrades to a figure-free note — a search never fails because its warning could not be computed.
- **New `sbCount(env, pathAndQuery, schema?)`** in `src/supabase.ts` — exact row count via `Prefer: count=exact` read from the `Content-Range` header, with `limit=1` forced on so counting never pulls rows (a plain select caps at the project's 1000-row ceiling and would silently under-report). Deliberately not `count=planned`: the planner estimate for the NULL-trade filter measured 34,473 vs an exact 31,203 on 2026-07-28.
- Unchanged by design: the 0.75 relevance floor, the content_text dedup, the per-entity quota, the all-five-named-RPC-params invariant and the `Content-Profile: vec` header.

### `semantic_search_gold` — Woz gold vector search (TAI-STV2 connector, read-only)
- New tool: natural-language semantic search over the QSC gold warehouse vector index (`vec.entity_chunks` on the SAME Supabase project as the pricebook store, `nlaaliehqpgskjmiuzze`) — spans all 12 Woz gold nouns (job, invoice_item, estimate, estimate_line, pricebook, pricebook_category, business_unit, job_type, lead_source, location, truck, membership), not just pricebook. Embeds the query via Workers AI (`bge-base-en-v1.5`, 768-d, same model/binding as `search_pricebook_semantic`) and calls the `vec.match_entities` RPC (qsc-vector migration 0005).
- **`sbRpc` gained an optional 4th `schema` arg** — sets the PostgREST `Content-Profile` header, required for any RPC living outside the project's default-exposed `public` schema. `vec.match_entities` lives in the non-public `vec` schema (project exposes `public, gold, vec`); without the header PostgREST 404s (`PGRST202 Could not find the function public.match_entities`) — verified live 2026-07-18. `search_pricebook_semantic`'s existing `public`-schema RPC call is unaffected (schema arg omitted → no header, same behavior as before).
- **Must pass all 5 named RPC params every call, `p_grain`/`p_trade` included as explicit `null`** — PostgREST resolves this function by the exact set of provided arg names; omitting the two silently drops the `p_entity_key` filter (returns wrong/empty rows, not an error). Verified with a live A/B against the deployed RPC on 2026-07-18.
- **No lexical fallback on embed failure** (unlike `search_pricebook_semantic`) — `match_entities` is pure cosine-similarity with no hybrid/lexical branch, so a null `query_embedding` would return `similarity: null` rows in arbitrary order rather than degrading gracefully. The tool throws instead.
- Read-only (`isWrite` unset), not `adminOnly` — visible to `default`/`admin`/`lockdown`/`readonly` alike, same shape as `search_pricebook_semantic`. Added to the `COVERAGE_EXEMPT` list in both `coverage_gate.test.ts` and `admin-endpoints.ts` (Supabase-backed, no ST endpoint). No new secret required — reuses `SUPABASE_URL`/`SUPABASE_PB_KEY` (verified: the same service key that reads the pricebook store has `EXECUTE` on `vec.match_entities`, granted to `service_role, anon, authenticated`).
- Tool count 104 → 105.

### Supabase-backed pricebook search + 4 new pricebook tools + embed Workflow
- **`search_pricebook_semantic` repointed** off the dead taylor-ai Cloudflare Vectorize path (`/api/pricebook/semantic-search`, bge-small 384-d) to the **shared Supabase pricebook store** (project `nlaaliehqpgskjmiuzze`, the same store `qsc-pricebook-search` reads). Now returns `_source: "supabase-hybrid"`, `_embedded: bool` via the `search_pricebook_hybrid` RPC (fusion of exact-code + lexical + `bge-base-en-v1.5` 768-d vector). Embed failure degrades to lexical-only (`query_embedding=null`).
- **4 new tools:** `search_pricebook_templates` (estimate templates + proposals via `search_templates` RPC), `get_service_breakout` (service + labor/materials/equipment/upgrades), `get_proposal_tiers` (Good/Better/Best ladder for a proposal id), `find_packages_with_item` (reverse lookup: which templates/proposals include a given code).
- **Pricing honesty:** every read runs through `shapePriceRow` so dynamic-priced items surface `st_price: null` + `price_basis` (`"dynamic — computed at invoice"` / `"reference (stored ST price)"`), **never a literal `$0`**. Embedding keys on `(code, item_type)` (code is not unique across item types); embed input text matches the app projection `[name, description, category_name].filter(Boolean).join(' — ').slice(0,1500)` so the shared 768-d space stays consistent.
- **`PricebookEmbedWorkflow`** (`src/workflows/pricebook-embed.ts`) — durable Cloudflare Workflow backstop that drains `is_active=1 AND embedding IS NULL` rows in batches of 100 (ceiling 5000), idempotent, with a no-forward-progress guard. Daily cron `0 10 * * *` (prod `pricebook-embed`, dev `pricebook-embed-dev`). Complements `qsc-pricebook-search`'s best-effort app cron.
- **New bindings/secrets:** `[ai]` (`AI`) + `[[workflows]]` (`EMBED_WORKFLOW`); wrangler secrets `SUPABASE_URL` + `SUPABASE_PB_KEY` (a dedicated connector secret key, separate from `qsc-pricebook-search`'s for independent rotation).
- Verified live on dev + prod: all 5 tools return correctly shaped results (no `$0`), Workflow drain test re-embedded a force-nulled row. Shipped 2026-07-13 (integrated with QUA-519 auth/CORS/health hardening from main before prod deploy).

### QUA-783 — siro_* response shaping (finding I-3 resolved)
- `transformResult: defaultShaper` applied to the 3 `siro_*` tools (`siro_list_mobile_events`, `siro_get_recording_summary`, `siro_get_engagement`), which the Phase-5 sweep (QUA-739) had deferred pending payload verification.
- Real payloads captured 2026-07-11 from all 3 endpoints: none carry any of the 5 stripped keys (`paginationToken`/`requestId`/`eTag`/`_links`/`_meta`). Siro is not HAL-style on these tools — the recording pointer is a plain `recordingId` scalar, pagination uses `cursor` (not `paginationToken`), and the only media/web URL lives on the un-wrapped `/core/recordings` list endpoint under `links.web.self` (no underscore, so unaffected regardless).
- New `src/tools/__tests__/siro_shaper.test.ts` encodes the real shapes as a regression guard; `read_shaper_sweep.test.ts` extended 42→45.

## [1.8.0](https://github.com/lpeluso-dotcom/mcp-servicetitan/compare/mcp-servicetitan-v1.7.0...mcp-servicetitan-v1.8.0) (2026-08-25)


### Features

* **A2:** wire CustomerSnapshotSingleflight DO with D1 mv_customer_snapshot cache ([71d7142](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/71d7142fba01b7c3134dae02fafb373605532057))
* add search_pricebook_semantic MCP tool (Vectorize) ([#48](https://github.com/lpeluso-dotcom/mcp-servicetitan/issues/48)) ([2a36ee0](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/2a36ee0b0269a6309bc770659ed69b30280884e0))
* **ap-inbox:** read/verify MCP tools for AP-inbox dedup (QUA-1167) ([559f540](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/559f54028768ac3df05255efa006e0cba69397f7))
* **ap-inbox:** read/verify MCP tools for AP-inbox dedup (QUA-1167) ([2a1c30d](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/2a1c30d3fc15ae89fada166b39d6cda460731375))
* **composites:** pricebook margin-discipline composites (markup_drift, cost_drift, vendor_part_gaps) — Phase 5 [QUA-739] ([05245a1](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/05245a1df821852338eddd113ca66bf2850a92e6))
* **composites:** pricebook margin-discipline composites (markup_drift, cost_drift, vendor_part_gaps) over pb_ D1 ([1b8aecd](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/1b8aecd0dfa8373f992080345663f43d2d0a9b7c))
* **composites:** shape 7 raw composites via defaultShaper (strip ST noise from nested items) ([eb0d20b](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/eb0d20ba1459bc10035f7dba6d1bf6e6c78a0265))
* **d1:** shared readD1 helper + extend D1_TABLES for v1.5 tables ([9661bd7](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/9661bd7b90ce569e49f0844f4edcd3717ba16be5))
* **D4+X1+X4:** delete marketing_roas stub + rewrite README + add RUNBOOK ([827294b](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/827294b7a9db7bc839799b061c34d6847663084a))
* **detection:** post-deploy smoke gate + /admin/errors/unacked alert source ([#40](https://github.com/lpeluso-dotcom/mcp-servicetitan/issues/40)) ([7e71a65](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/7e71a6522c6f74129c5395a6add0e68d76d98513))
* **estimates:** split update_estimate_status into dismiss/sell/unsell action tools ([#14](https://github.com/lpeluso-dotcom/mcp-servicetitan/issues/14)) ([a46dfa4](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/a46dfa4fb3200f1f1ddc3a931b8c830da84d4ff6))
* **evals:** tool-selection eval harness (offline scenario validation in CI + key-gated live top-1/top-3) ([966c541](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/966c541251468d766ce6f8786cac726a3e91a78b))
* **F1.5:** MCP Inspector smoke harness ([8b3a043](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/8b3a043b4f4446d01536db5fb89a62dc054a9462))
* **F1:** /admin/health/audit probe + obs.ts comment fix ([5b6c34d](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/5b6c34d594c4dd7181ce407a44de27fd612ba23b))
* **F3:** composite partial-failure helper + migrate fanout composites ([ad8a7ca](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/ad8a7ca9e8e45bd6ecc074bf7805d985cdaf44c3))
* **gold:** titan_advisor_score tool over the Woz gold snapshots ([781a567](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/781a5679531964f60fa40249f75e2e539b11486f))
* **gold:** titan_advisor_score tool over the Woz gold snapshots ([8705e5d](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/8705e5d3410bd5ca5b88031674507cb33d8c3851))
* **H1 batch:** migrate 8 write tools to defineWriteTool ([f3dd330](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/f3dd330ad61d609f412db45c596af6aae96afaa7))
* **H1+H3:** write-tool factory + DO hibernation tests ([5786c38](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/5786c3815a5def8abc4086ff886dfa45a10f2704))
* **health:** report the deployed commit sha ([0e9bc49](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/0e9bc49ae9de07c56e8362809ef52e320dc149a2))
* **infra:** readST/readSTPaged helper + filter-preservation test harness ([482db79](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/482db79b5701b2c8a8357ec175990f674385d1a8))
* **inventory,payroll:** add 7 sibling tools matching vendors_list pattern ([4714267](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/4714267cc107367d839109a652971634c9754715))
* **inventory:** add inventory_vendors_list tool ([b8cb843](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/b8cb843066934202a681cb6bf52a9969bd59a245))
* **invoicing:** add st_add_invoice_line_item validation + dryRun path ([190214a](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/190214a8fba752743a720b480c300ac678c894a0))
* **invoicing:** add st_create_adjustment_invoice with Posted/Exported + no-chaining guards ([f43cbc3](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/f43cbc3cbddb480665dc1ab3b7409e1e61f6ea9a))
* **invoicing:** invoice-write tools — st_add_invoice_line_item + st_create_adjustment_invoice ([8082457](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/8082457c76e8ab54d97c6df77bcfc2280da30efe))
* **jobs:** add get_job_history tool for per-ticket audit log ([#29](https://github.com/lpeluso-dotcom/mcp-servicetitan/issues/29)) ([022f8e8](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/022f8e88a9c8bec855c0a2dac28c97027d1343be))
* mcp-servicetitan v1.0.0 — super-MCP full build (F1–H14) ([538bfb7](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/538bfb7d38ff04baf255b8e31f81550b259c4032))
* **mcp-servicetitan:** add find_technician_by_name — name-based technician lookup ([87b4a66](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/87b4a66141f0bbf5e918181ecafe3b22212e100c))
* **mcp-servicetitan:** add otel_span_queue migration (0005) ([c3d8f0b](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/c3d8f0b847aed4c0e410cc99cdcadbfa0ade2b91))
* **mcp-servicetitan:** Phoenix tracing + find_technician_by_name ([c3b65ca](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/c3b65ca2e7b6f21e140886a5bfffa7dd967771e2))
* **mcp-servicetitan:** trace MCP tool calls into Phoenix (fail-open) ([0822c88](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/0822c88cc8cf5eccc0baae0b72e5b92afccd7105))
* **mcp:** 5 QSC workflow prompts (dispatch brief, closeout, AR chase, quote follow-up, membership outreach) ([77af981](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/77af9817d5003530558e17424e2f7f429352d181))
* **mcp:** argument completions for workflow prompts + cached BU name→ID helper ([5383792](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/538379287b9f98fa2be50b102adb3bbb8e8dfc65))
* **mcp:** browsable catalog resources (pricebook tree, PII-stripped roster, report catalog) ([4a02756](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/4a027568c9e6aa6b9caaf783c0bf9af43d9b8da9))
* **mcp:** MCP-native surface — annotations, structuredContent, outputSchema, prompts, resources, completions (QUA-736, Phase 2) ([d411bcd](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/d411bcd63faa85d72bcf2360a31213553096e8bd))
* **mcp:** outputSchema on the top-10 tools (lenient, fixture-validated) ([0731205](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/0731205af7b2988c385aa946e5fd9cbd1dee5be5))
* **mcp:** registerTool migration — titles, spec-correct annotations, structuredContent (all tools) ([6c96454](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/6c96454c4b5461f33d76e62bfcd3b97a2fb7693b))
* **mcp:** resource-link offload for oversized tool results (&gt;80KB → KV + resource) ([a6619e8](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/a6619e8234c9fdc7a1ff77bbf1541fc4e086e277))
* **oauth:** wrap mcp-servicetitan in workers-oauth-provider (Phase-2, read-only) ([#35](https://github.com/lpeluso-dotcom/mcp-servicetitan/issues/35)) ([28fd2b6](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/28fd2b690662667217a57300e72d66ea4197af4c))
* **obs:** enrich /admin/metrics + add query-metrics.sql ([338ad14](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/338ad141fb3b4049f6af49fdc8271f1b1a72861b))
* **payroll:** add payroll_job_timesheets_list (v1.5) ([#16](https://github.com/lpeluso-dotcom/mcp-servicetitan/issues/16)) ([e660149](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/e660149f19c5f1cf768a5c227d438637a94cb115))
* **pricebook:** add find_packages_with_item reverse-link tool ([12ce091](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/12ce0913c3092120d0e0ce2cadf473044c59e21a))
* **pricebook:** add get_proposal_tiers tool ([b245fd5](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/b245fd5cefa2fec1e4dcdfe7b7193666548f2def))
* **pricebook:** add get_service_breakout tool ([17c298f](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/17c298f23469a641d604acb408d79fa4eba7af04))
* **pricebook:** add PricebookEmbedWorkflow durable embed backstop ([1c8a66c](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/1c8a66c7f9b581a45925d84b51fccfc62662884f))
* **pricebook:** add search_pricebook_all adapter for Miss Dawn ([b5ab646](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/b5ab6469c455fe452321bef5ad5f01c500cafe1c))
* **pricebook:** add search_pricebook_templates tool ([c46ae88](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/c46ae881f108a12513bddc1156eaf9a7b4da1a55))
* **pricebook:** hydrate configurable-equipment variant ids into records ([e1f29b6](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/e1f29b60fcdb7c327a41f6da8249157561df640c))
* **pricebook:** repoint search_pricebook_semantic to Supabase hybrid RPC ([7ab080c](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/7ab080ca6b5e1ff985887246b7f51ec219af937b))
* **pricebook:** Supabase-backed semantic search + 4 pricebook tools + embed Workflow ([4252f02](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/4252f024e0c6293ddcc8ce3aa6ef6983c1650809))
* **pricebook:** Supabase/embed/shaper helpers + env bindings ([6ca54fe](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/6ca54fed43e720aafad1c634d0d377671ec6ac69))
* **pricebook:** v1.7.0 — full service field surface on st_create/patch_service ([#37](https://github.com/lpeluso-dotcom/mcp-servicetitan/issues/37)) ([fea9ce5](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/fea9ce58f867f2494ea1cd789463d44caa1e127f))
* **pricebook:** wire PricebookEmbedWorkflow — export, cron scheduled(), bindings ([9883d5e](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/9883d5ea78963a9844bfd1dc476436a2fbf8cefa))
* **prompts:** rebuild the 5 guided workflows around real QSC ops ([101cb1e](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/101cb1e2a2603d13215bbf5b29137e26d64e2632))
* **rate-limit:** gate every ServiceTitan call path through the limiter ([09062c9](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/09062c9994864e9b0e7fb1d4c4620a670d4f02dd))
* **rate-limit:** wire the ST rate limiter into every ServiceTitan call path ([4408097](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/4408097aed37780e885f26c191c41ca53e4e049d))
* read-only Claude Desktop connector (Jessica Hunt) — readonly role + /c/&lt;token&gt;/mcp ([#34](https://github.com/lpeluso-dotcom/mcp-servicetitan/issues/34)) ([d7c0e0f](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/d7c0e0f863a5173965aedbc0c57a42e04952e507))
* **read-router:** re-enable pb_materials/pb_equipment D1-first; drop call_transcripts; paced ST probe (audit 2026-06-12) ([#33](https://github.com/lpeluso-dotcom/mcp-servicetitan/issues/33)) ([8533ef5](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/8533ef59260981386fe2aa0a7562b1e4d4823c9b))
* **response-shape:** add module for stripping ST noise + capping arrays ([e13859c](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/e13859c86e46906fa3c165aa25b251c611ffb0c1))
* **sales:** create_estimate_template write tool ([10a0964](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/10a0964d349e9e6ce9416a04218b94856a124ae2))
* **sales:** delete_estimate_template + wire estimate-template CRUD into TOOLS registry ([cdf2958](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/cdf295849d156575b273824b913d47390b2840d1))
* **sales:** estimate-template CRUD (5 tools, /sales/v2) — Phase 4 [QUA-738] ([0a61335](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/0a61335cdebfbc08fa069f190b351ee4cfb6b8d1))
* **sales:** estimate-template reads (list_estimate_templates, get_estimate_template) ([a375816](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/a375816d0753aa5012fcb4f6b3506c7f41428d90))
* **sales:** update_estimate_template write tool ([702466c](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/702466c41828255aa73ca83b91037e925268af02))
* **security:** __Host- prefix on OAuth CSRF cookie (securing-MCP guide) ([1f0265a](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/1f0265a58b6f916cc1f375f272a7dc5ba1a2cfc2))
* **security:** /health stops enumerating tool names; toolCount preserved (QUA-519) ([bfbf1b1](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/bfbf1b1ceea1cb429746c0b46c50fb1911d4f8cd))
* **security:** CORS allowlist replaces origin:'*' (QUA-519) ([3561093](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/3561093a7a7086293122b91172e1fc62d3f3c25a))
* **security:** Vary: Origin on the two 401 helpers; document readonly≡lockdown filter dependency ([f9a7f9f](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/f9a7f9f0230192568247702b582e29522d8366f5))
* semantic_search_gold tool over Woz gold vector index (TAI-STV2) ([#74](https://github.com/lpeluso-dotcom/mcp-servicetitan/issues/74)) ([f792abe](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/f792abe45ea0c9a368db47979bfa51b28db7ac02))
* **shaper:** response-shaper completion (composites + 42 read tools) + excludeFields hardening — Phase 5 [QUA-739] ([31794cc](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/31794ccd26614f8f379d4faeb76578f565619976))
* **siro:** apply defaultShaper to the 3 siro_* tools (QUA-783) ([fd41744](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/fd41744ed8c6fc8246316999f6ed8b7148464aaf))
* **siro:** shape 3 siro_* tools with defaultShaper (QUA-783) ([6375eb7](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/6375eb7d10cef7dd978de2b21aab2beae2c0938b))
* **st_create_material:** require primaryVendor (QUA-685) ([fb8206f](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/fb8206f80c32b8aabbc1a8700f0a8002788e8cc3))
* **st_create_material:** require primaryVendor (QUA-685) ([6fb0761](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/6fb0761180f03c0321ed07404029c75eb4887736))
* **supabase:** _gold_as_of watermark, retry-on-transient, and bounded error bodies ([017bab1](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/017bab1869947806d6e4c18e4147d6671899a77b))
* **supabase:** _gold_as_of watermark, retry, and bounded error bodies ([8816bfd](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/8816bfdbbccef88c60988d21fe629ffbd5de9269))
* **supabase:** sbSelect Accept-Profile for gold-schema reads ([282f321](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/282f321894aaf99250abe59242eb08cf4088b2fc))
* **tool-registry:** wire optional transformResult into registerTool ([47a9fd3](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/47a9fd32649296c09cf36825c6a9c8e7b73a39f5))
* **tools:** add gold_margin_by_bu (gold-sourced BU margin) ([88499ef](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/88499ef0ed4342a6466fe60a5630f61cd818933f))
* **tools:** add tech_scorecard (D1 weekly per-tech rollup) ([5518721](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/5518721eb8b38383a00cc2b666336bfb1dccfcca))
* **tools:** adopt response shaper on top-3 high-payload tools ([a4ef517](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/a4ef517970789d89fbe080deab8a6e4988a131e7))
* **tools:** register 8 inventory+payroll tools; drop unused active arg from receipts/transfers ([6d97505](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/6d9750527979b6f7377bd2e2b5d0e30ddc848596))
* **tools:** register gold_margin_by_bu + tech_scorecard ([8614db5](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/8614db5491d52a3a6555961c5f4f4b03df9b5a4a))
* **tools:** register st_add_invoice_line_item + st_create_adjustment_invoice ([a44270a](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/a44270a9130931863c3b504fd77aa4e07027b508))
* **tools:** TAI-ST v2 guided surface — gold_margin_by_bu, tech_scorecard, rebuilt prompts ([7777ac2](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/7777ac29280734a69fc6420580c1136f5660a1b6))
* **tools:** v1.5 — payroll/opportunities/dispatch-pro readers + costing composites + create_task fix ([7ab0a6e](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/7ab0a6e1b4bfb68ceca28613b6bed021b1719a1f))
* **tools:** v1.5.1 — ST-77 alignment (active filter, hold reasons, isAutoDispatched) ([ab1a4f0](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/ab1a4f063bced6f0cd28d800dbcfa2c3daf85027))
* **v1.2:** stEndpoint descriptor + /admin/endpoints + 3 new tools (capacity-slots, run-report, marketing-attribution) ([50c7e34](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/50c7e344160cf979b9e31a0440c4f7d21ec1e1e4))
* **v1.4:** paged ST read helper + name resolver + margin_audit pagination fix ([#7](https://github.com/lpeluso-dotcom/mcp-servicetitan/issues/7)) ([15c8c22](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/15c8c22ee41040b8ed5fe159c67b12ac2a8ed566))
* **v1.5.1:** readST sweep, stEndpoint coverage gate, isAutoDispatched composite join ([56748bf](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/56748bf06aecf0db9b7edfba69ccd50886fde70c))
* **webhook:** add event-type allowlist + header read + metric + 0003 index migration ([6939d41](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/6939d41defc9fa475d9bc854c22aa1ae9f76b540))


### Bug Fixes

* **ap-inbox:** 8 defects found by adversarial review, all reproduced ([b7e8fec](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/b7e8fecee47fab8d648699d93be7c3d851a68b04))
* **ap-inbox:** second adversarial review — 8 findings, all reproduced ([6d159e9](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/6d159e942e7258e6f697e7247dab85bee2d661ff))
* **audits:** qualify mirror assignment join ([340a6a6](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/340a6a6798225baeaa695d473d5ae4acbbbecda6))
* **audits:** qualify Supabase mirror assignment join ([a54fdc0](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/a54fdc06f3da41c60e491d116da4abe6e615443a))
* **audits:** read operational mirrors through Supabase ([e2ad319](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/e2ad31927883465228ee2bddd6265e80b3ac7e86))
* **audits:** read operational mirrors through Supabase ([4770323](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/47703235cb697ebd0dd64777e345f680048d5f7a))
* **auth:** delete the /c/&lt;token&gt;/mcp route rather than secret-gate it (QUA-1117) ([3e25c41](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/3e25c41f102fce466d39874080ef2f9b8e887e44))
* **auth:** MCP_LOCKDOWN narrows authenticated callers instead of waiving auth ([b64d297](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/b64d297f0cdef18a92b782206942f70512c7d68d))
* bump MCP_SERVICE_VERSION env var to 1.6.0 (matches package.json) ([#24](https://github.com/lpeluso-dotcom/mcp-servicetitan/issues/24)) ([e8f11a5](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/e8f11a5a96061728f2598cd44f70aa8ea79a074f))
* **calls:** get_call fetches via ?ids= (no /calls/{id} route in telecom v3; call nests as leadCall) ([b728dc0](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/b728dc04a1c6ac2576c1c6938ccd35360676fdfb))
* **CD-3:** strip customer_phone from open_opportunities_pulitzer_feed ([0bd541b](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/0bd541b9e0c9cca0cdafdc555a937bde8711d725))
* **CD-3:** strip customer_phone from open_opportunities_pulitzer_feed (PII redaction) ([0555266](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/05552668bf5200827f3b331f4c4e31d15abd25fc))
* **ci:** bump deploy workflow to Node 22 (wrangler 4.94+ requirement) ([#23](https://github.com/lpeluso-dotcom/mcp-servicetitan/issues/23)) ([1e5ac15](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/1e5ac15118944e15827d42679bdcd43663d069c7))
* **ci:** derive smoke-sweep exclusions from the registry, deny-by-default ([4525e6a](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/4525e6a01b6f5818c4ca5f83e951dd792e5663a5))
* **ci:** derive smoke-sweep exclusions from the registry, deny-by-default (QUA-1044) ([e2c08db](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/e2c08dbed440888f2355d5b46cfa611f2ce8a103))
* **ci:** drop --env flag for prod deploys (wrangler.toml top-level IS prod) ([626033e](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/626033ee756dd6eded67bccccffcc0be5fdd5605))
* **ci:** inject CF resource IDs from GH secrets before deploy ([c744d8b](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/c744d8bb39c2196ab9d3ffbb7d160ab73b18a0fc))
* **ci:** inject Cloudflare resource IDs from GH secrets before deploy ([f5ca704](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/f5ca704d43b9e599545e40df9e4c61b59c548177))
* **ci:** preflight keys off vitest exit code, not a ' failed' substring grep ([5c967ec](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/5c967ec8f8c49d25cb6a3a0a48f6615059a2b7c5))
* **ci:** preflight skips git-alignment subcheck on GITHUB_ACTIONS=true ([f9d59b8](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/f9d59b8a2d3dd39cc5130313409cbc5470be6fe9))
* **ci:** preflight uses vitest exit code, not a ' failed' substring grep ([191b1bd](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/191b1bd18a4a624e1382a6be5bddb1ce2d70e3fa))
* **composites:** markup_drift resolves real categories via categories_json -&gt; pb_categories ([a72459a](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/a72459a9ca0b4f2155f2c8860299442d720b58cd))
* **composites:** markup_drift resolves real categories via categories_json → pb_categories [QUA-739] ([8492508](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/84925083d511afdb7768e4b990dc859e36e79a24))
* **composites:** paginate five single-page composites, fix three that measured the wrong thing ([88d1d71](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/88d1d71952fe2358da7a296f8bfbd96a51279637))
* **composites:** paginate five single-page composites, fix three that measured the wrong thing ([9bffe49](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/9bffe490eac5524babe377e1cf49cabf39fb702f))
* **composites:** warn instead of reporting a 100% margin from missing timesheets ([eb05f15](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/eb05f156f2238f2759a99066ba6b21adf5ed554e))
* **connector:** QUA-1181 PII scrub, QUA-1117 route deletion, QUA-1108/1109 silent undercounts ([781e34f](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/781e34fc25541b8bdc980835aef364bf166ee8fd))
* correct invoice write tools to confirmed ST endpoints + write path ([e284f72](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/e284f7234d04b81ef6662e636971330394bf37f6))
* **d1:** join technicians on tech_id, not technician_id (3 sites) ([70ea33b](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/70ea33bcc61cf97db8352482c03dad0a711b37d7))
* **d1:** repair ST name-resolver 404 + composite 500s (dead query-d1 route + estimates/jobs schema drift) ([#36](https://github.com/lpeluso-dotcom/mcp-servicetitan/issues/36)) ([805a418](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/805a418ee97e2639c720f3d993ec885ac4ef1e69))
* **d1:** shared d1-proxy with retry/classification/correlation (QUA-267 [#3](https://github.com/lpeluso-dotcom/mcp-servicetitan/issues/3)) ([#28](https://github.com/lpeluso-dotcom/mcp-servicetitan/issues/28)) ([df8b158](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/df8b158aff9c2e6f19ccaa6fd34414996aebc9fe))
* **dawn:** route identify_tech_by_phone through ST_PROXY (QUA-267 [#1](https://github.com/lpeluso-dotcom/mcp-servicetitan/issues/1)) ([#26](https://github.com/lpeluso-dotcom/mcp-servicetitan/issues/26)) ([75db88b](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/75db88b4ec85662b52b705752c6ad0a97b098889))
* **dispatch:** use ST-honored filter param names for shifts + non-job events (QUA-694) ([#49](https://github.com/lpeluso-dotcom/mcp-servicetitan/issues/49)) ([6130a28](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/6130a2803ad34d1ce0f4b597dd839a3de5eb65c7))
* **evals:** truthful campaign-cost scenario; fairer compound/pricebook expected sets; validate against live 98-tool catalog; cap top-3; correct ambient-decl comment ([494a3b8](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/494a3b85e91270b610dad6a1498596b0c0c42892))
* **F-tranche:** apply QA-panel findings before Cut 2 ([8bd4272](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/8bd42729b536123e895368a7c5c4cdc06c711e44))
* final-review fixes for invoice write tools (ids-guard, TOCTOU, sandbox hard-block) ([e2484a8](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/e2484a8e06ee1289f1bd651870de4602775cb5a0))
* **find_customer:** cap response to 10 slim rows by default for voice tier ([ca2a4db](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/ca2a4dbeeb0faed206812a845620fde4de3c3c2f))
* **forms:** get_form_submission D1-first (no per-id route; ids ignored even with formIds) ([6dd1f74](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/6dd1f7467afe141ff17b4c8bfd0cffe3448cc4e1))
* **freshness:** publish the returned page own age, distinct from the table (QUA-1234) ([a79c60e](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/a79c60ebd59612a6f472bf48c7b09944ae19bdb0))
* **get_estimate:** correct description to live ST + lock routing (QUA-512/QUA-756) ([2ae592d](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/2ae592d5f3c0f97edea3dffd017257b9aaeafdda))
* **gold:** add post-retrieval layer to semantic_search_gold ([306ecd5](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/306ecd5fdfe972744eb09383a67ce99b69cf78fa))
* **gold:** cap the OLDEST days, not the newest, in titan_advisor_score ([823cdb8](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/823cdb878be20fbb5645a0fb838498d49cb76d03))
* **gold:** derive semantic_search_gold's trade-coverage warning at runtime ([6c7cea6](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/6c7cea68ad214adb5fcd1e2e5ae0edb875cce0bd))
* **gold:** derive the trade-coverage warning at runtime instead of hardcoding it ([1149c31](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/1149c3111c58db7793c90743f8634241e39b7240))
* **gold:** scrub PII + premises access from semantic_search_gold (QUA-1181) ([55e8b62](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/55e8b62956b6b77d2cc5f5409a9bb3678ceb9ffb))
* **gold:** validate date args, cap rows, and flag truncation in titan_advisor_score ([7967dc8](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/7967dc8f5b181b3400be88f7432a6fd90343559d))
* **inventory:** vendor active defaults to null; harden tests + error message ([c53f634](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/c53f6343569ac6aea42b32b2b7e590b762c47632))
* **invoicing:** get_invoice fetches via ?ids= (ST has no /invoices/{id} route) ([dc56e67](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/dc56e67a10a24caa9fbb23fe4f7bbb41ac84f3bf))
* **invoicing:** get_invoice_balance fetches via ?ids= + unwraps data[0] ([9a43015](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/9a4301553af8ab4fcd8b0cb639dcf7fc49fbfadb))
* **invoicing:** list_unpaid_invoices coerces string balance (was returning paid invoices) ([75cbe47](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/75cbe47df06a8371bdc96bba77df6540b88ad83d))
* **invoicing:** rebuild st_add_invoice_line_item on confirmed ST schema ([c743b7e](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/c743b7ec1a7ee4b3317aa2e3f84d630566855bc5))
* **invoicing:** require skuId/skuName when appending an invoice item ([8436d99](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/8436d998b17acbb95269f34f7b11ea1efa1b5c75))
* **invoicing:** review pass — ids-honored guard, balance NaN fail-open, docstring + test pins ([0558cde](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/0558cde34fc52f25acdeae64d2ca5e7dcafc9332))
* **invoicing:** use ServiceTitan's real field names — unitPrice, items[] — and verify the money landed ([b7af8e2](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/b7af8e245a931d7498c2255886cd687b01a19b82))
* **invoicing:** use ST's real field names — unitPrice, and items[] on adjustments ([f40fa22](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/f40fa22f379a16187e785bc70e6fc62a2ec88eda))
* **invoicing:** verify the money landed — post-write verify-read, loud schemas, no $0 appends ([416afe6](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/416afe636a32a1ff90f79cfe7477dce5420c78e1))
* **invoicing:** verify-read against ST's real read types and envelopes ([55acedb](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/55acedbe6e65c0c3bd10b25f1ee5d5ed93d3493d))
* **invoicing:** verify-read against ST's REAL read types and envelopes ([649e61f](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/649e61f85e140c34e0258849c62c59b7fdc52c4b))
* **jobs:** cap list_jobs_today ids-batch at ST's 50-id limit ([0a81d05](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/0a81d05b7d14f0b5620c58494e8f1d9cd9042658))
* **list_jobs_today:** query today's APPOINTMENTS in ET, not the Jobs API ([b8eb309](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/b8eb309e207ac1ff57bbd86d21c0af8e39f60321))
* **list_jobs_today:** return today's jobs via ET appointments, not the Jobs API ([04d2693](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/04d26936abc2a40b0efd3c2f256bb4d359189e0d))
* **margin_audit:** jobs BU filter uses singular businessUnitId (plural businessUnitIds silently ignored) ([58c0b60](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/58c0b60e5d84514270871f526a83163e8ee0a17a))
* **margin_audit:** pagedStRead resolves tenant placeholder (was 403 on every call) — QUA-737 follow-up ([ab0b2ff](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/ab0b2ff5fbf99a5819a02ad739103d4534c59c09))
* **margin_audit:** pagedStRead resolves the tenant placeholder (was sending literal /tenant/000000000/ to ST, causing 403 on every call) ([7db764a](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/7db764a68ff307b6e07accb902eebd6346ba7c5a))
* **mcp-servicetitan:** thread real actor into qsc_actor span column (was hardcoded to 'luke') ([b475477](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/b475477a9ff268544ec269126aabf9fcf688b7b8))
* **mcp:** annotation overrides for miscategorized tools + merge mechanism + test coverage ([01eee91](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/01eee91d29d0ae2aa4146598757b15b3daf3a650))
* **mcp:** payroll non-job-timesheets real fields + client-side filters; margin_audit BU filter (QUA-737, Phase 3) ([701439d](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/701439d25b45c1f9674687491030325abb96afe1))
* **mcp:** schema-safe + fail-safe result offload (outputSchema-aware structuredContent, KV-put fallback) ([14d5bd9](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/14d5bd911ad93af8180dc4de9c4729784b788940))
* **mcp:** st_call flagged isWrite (admin raw-gateway is write-capable, not read-only) ([9eff166](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/9eff1663fa918545bf66c58060f7ff6f8a32cd5c))
* memberships API — use status (singular) + client-side re-filter ([5637190](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/5637190b04532a9f9c51f3936545341eb91a07e8))
* **mirror-freshness:** never claim 'stale' from synced_at evidence alone ([ef9782f](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/ef9782fbf7dd708c72f352ffc45eb0fdcf51a1e3))
* **mirror:** disclose D1 mirror freshness instead of serving stale data as truth ([111902c](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/111902c19a7108d1833028b31bd10039e7a5cda3))
* **mirror:** disclose D1 mirror freshness instead of serving stale data as truth (MB-1 / QUA-1141) ([f17f0c5](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/f17f0c5fcfb6d1d416c3c05d54419c497a3d1467))
* **mirror:** table-level freshness disclosure across the 16 remaining D1 mirror readers (QUA-1141) ([cb4a94e](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/cb4a94ed3c0c82c9e67154a694e7ba2634798b8b))
* **notes:** add_job_note/add_customer_note send ST { text, pinToTop } not { note } (was 400) ([#72](https://github.com/lpeluso-dotcom/mcp-servicetitan/issues/72)) ([1d290e8](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/1d290e80b5fdb37c42acc8bb2b2109c22782b01b))
* **payroll:** auto-fallback only honors filters live ST can express ([8236154](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/82361540df52404d6dbdd8b67e66b87113e4ed5c))
* **payroll:** non-job-timesheets filters employeeId/timesheetCodeId client-side (ST has no working server-side filter for either) ([a3ec9fd](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/a3ec9fd1aa9f12488237dfbc54a3e39fe93a6db7))
* **payroll:** non-job-timesheets real field mapping + honored modifiedOn filters (was null fields + 409) ([b088324](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/b0883241cbf7cbaaf7c561cb16cd2dd96df576a8))
* **preflight:** check COMMITTED content for the S-8 PII invariant, not the working file ([39fb3b9](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/39fb3b9f06c268d9145df442e008a6fc9778caaf))
* **preflight:** S-8 guard must check committed content, not the working file ([ccc2c31](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/ccc2c3152826c110ff8944e859df53034e781325))
* **pricebook:** add `code` parameter for exact-match lookup (QUA-267 [#2](https://github.com/lpeluso-dotcom/mcp-servicetitan/issues/2)) ([#27](https://github.com/lpeluso-dotcom/mcp-servicetitan/issues/27)) ([234bfe6](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/234bfe64c295de9fdce8ea723c4cd8083f82d0cb))
* **pricebook:** add no-progress guard to drainOnce to prevent infinite loop ([8fe4091](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/8fe4091d6bbf5b21c307de453ff464bc2d8fb0dd))
* **pricebook:** apply shapePriceRow to pricebook_cost_drift rows ([2c9f243](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/2c9f243a4120fadacc0b937ddbb09576441a4bb8))
* **pricebook:** disclose variant-hydration truncation; pin the not_found gate ([bb717a8](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/bb717a81e7e59e5a39bb0a5564a41f462a95bd92))
* **pricebook:** Fix TypeScript typing for fetch mocks and shapePriceRow return type ([6d90c8e](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/6d90c8e9362b07e8ea00b9024c74c4aff63a8743))
* **pricebook:** get_configurable_equipment_children read variants from parent record ([4518f99](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/4518f99f5421befbeb94ed742cfd31a5c6215c40))
* **pricebook:** get_configurable_equipment_children returned unfiltered equipment list ([cba92ce](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/cba92ce3e6f119da7059e34da2dbb44811fb9c46))
* **pricebook:** rewrite name→displayName + categoryId→categories + bump poll budget to 180s ([#12](https://github.com/lpeluso-dotcom/mcp-servicetitan/issues/12)) ([ea41a6b](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/ea41a6bc3cb64d60fe56d69c6d8ddd250172162e))
* **pricebook:** shape prices in find_packages_with_item (dynamic-pricing honesty gap) ([5d87136](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/5d87136b86bea8c2d146718b92f6635ecf878342))
* **pricebook:** stop search_pricebook_all reporting dynamic-priced items as $0 ([#46](https://github.com/lpeluso-dotcom/mcp-servicetitan/issues/46)) ([598db02](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/598db020683fb32f99322dc7e38730958c7a87ef))
* **prod-hardening:** invoicing/call/form no-by-id-route fixes + honest tenant logs (QUA-735, Phase 1) ([8044e6a](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/8044e6a9bcd718702b3c9d0e5b91221e1a080439))
* **prod-readiness:** D1 drift, 3 bad ST endpoints, broken writes + retire dead tenant wrapper ([#39](https://github.com/lpeluso-dotcom/mcp-servicetitan/issues/39)) ([51de007](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/51de0071a4f2a326b7795b952ff0ed7cc40ee64a))
* QA pass — customer_snapshot DO protocol, dryRun echo, st_call dedup, NaN guard ([19e076b](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/19e076bcdf8afe94c8069ac437bc31b06ee31c32))
* **QUA-1234:** freshness-grain — expose _rows_synced_hours ([079a37b](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/079a37b97e03a09173b3f572e72a58a2aa49e35d))
* raise Supabase fetch abort budget 10s-&gt;25s (authenticator role statement_timeout was capping RPC calls at 8s) ([#75](https://github.com/lpeluso-dotcom/mcp-servicetitan/issues/75)) ([dbf5fdc](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/dbf5fdcade49590072403b8e7bb18442bae8e802))
* **rate-limit:** re-tune caps against ServiceTitan's documented limits ([9dccde6](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/9dccde6b074ee9bc47e8d9e3ea4432b8b41fdac9))
* **response-shape:** guard excludeFields against Date-&gt;{} corruption and __proto__ pollution ([240235b](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/240235bc7b3bb459d44d5ac5987eb6a1b7dd083d))
* **sales:** create_estimate_template internalName required + flag unresolved 'model' field (live-verified against prod) ([2924428](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/2924428721a1c217f78ac456448fee97eb058d24))
* **scheduled:** widen overlap guard to include all non-terminal workflow states ([053c26c](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/053c26c0bbae80c30d235584fe858b3b6d80a671))
* **search_pricebook_all:** normalize code variants (flu150 -&gt; FLU-150) ([5259a13](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/5259a134f802c8d082827c35d4049eb6ad6f9359))
* **security:** move ALLOWED_EMAILS to deploy-time injection (audit S-8) ([500b8c5](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/500b8c5c58279741511ba6a9d0995425002d0200))
* **security:** require exp and enforce aud/iss on JWT verification (audit S-2) ([5616c80](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/5616c805467385b953692e22994b8bbd008c4cab))
* **security:** require explicit consent before completing OAuth authorization (audit S-1) ([0e64e44](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/0e64e440abb0d216a75c246798b810000d0d5db2))
* **st:** error messages log the resolved tenant, not the 000000000 placeholder ([04d0270](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/04d027093fcd0bca2ca577193a78feb503ce5add))
* **st:** resolve tenant placeholder at readST call site (dispatch/jobs/appointments 404) ([#38](https://github.com/lpeluso-dotcom/mcp-servicetitan/issues/38)) ([246e707](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/246e707348463814683a7ac101b79d0e2f8c28ac))
* TAI-ST connector defect sweep - tickets C-H (6 fixes) ([88674bd](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/88674bdb0236ab9e4b7af3336a4be2c8faa0bd67))
* **test:** unblock tsc on singleflight.test.ts:113 mock.calls destructure ([7487e8d](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/7487e8d90830fff00977afc133608f96cf95b632))
* **tools:** correct false Source:D1 claims on 6 live-ST tools; drop dead source: branch in description-lint ([47c1139](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/47c113954689105b8198120529625d9fd05314e0))
* **tools:** gold_margin_by_bu GP% is not a margin — say so where it is read ([89fc2c3](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/89fc2c323e15c832b979a66a4e9afa17520c8190))
* **tools:** gold_margin_by_bu GP% is not a margin — say so where it is read ([7f1a5b1](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/7f1a5b14a2145f7209e2110e2a9fab5a3130f8c9))
* **tools:** reject ST filters that are silently discarded (QUA-1054, QUA-951) ([#96](https://github.com/lpeluso-dotcom/mcp-servicetitan/issues/96)) ([a66a616](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/a66a616dcbf0dead885ce4fd0663cc214675d4e6))
* **tools:** remove stale active-filter test; renumber T10/T11 → T12/T13; static imports in catalog tests ([6b84154](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/6b841545e061ad5e8ec58606f8cc7e0d86553499))
* **tools:** stop two silent-undercount defects (QUA-1108 Urgent, QUA-1109) ([bf112c2](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/bf112c2bddb0a02c7602125e11727c1d0c775ea7))


### Performance Improvements

* **cache:** wire mcp_cache into 5 hot read tools + invalidation hook ([e2777fa](https://github.com/lpeluso-dotcom/mcp-servicetitan/commit/e2777fa03b393a92ae6c7d71eb6647e9b92a50eb))

## v1.7.0 — 2026-06-16 → 2026-07-10 (pricebook field surface, MCP native surface, estimate templates, semantic search, margin composites)

`package.json` was bumped to 1.7.0 on 2026-06-16 (PR #37) and a large amount of further work landed on `main` afterward without a subsequent manual version bump — this entry catches up the full span. Going forward, release-please (added this task) ties every release PR to actual conventional-commit history instead of a manual edit, so this kind of multi-week catch-up entry shouldn't recur. Tool count **89 → 99** (+10, per `TOOLS.length`); test count **472 → 875** (+403).

### Pricebook (#37, #48)
- `st_create_service` / `st_patch_service`: full pricebook-service field surface — `hours`, `isLabor`, `taxable`, `account` (GL), `paysCommission`, `memberPrice`, plural `useStaticPrices`, multi-category via `categories[]` (precedence over `categoryId`). Removes the silently-dropped singular `useStaticPrice`.
- New **`search_pricebook_semantic`** tool — Vectorize-backed natural-language pricebook lookup.
- `search_pricebook_all` no longer reports dynamically-priced items as `$0` in tool output — QSC runs Pricebook Pro, so a missing/zero static price was never "free," just unresolved at read time; the tool now reflects that correctly (#46).

### New: pricebook margin-discipline composites (QUA-739, #56/#57/#58)
- `pricebook_markup_drift`, `pricebook_cost_drift`, `pricebook_vendor_part_gaps` — new composites over the D1 `pb_*` tables. `markup_drift` resolves real categories via `categories_json` → `pb_categories`.
- `defaultShaper` response-shaping rolled out to 42 read tools + 7 raw composites (finishes the v1.4.1 "mechanical rollout" deferral).

### New: estimate-template CRUD (#55)
- `list_estimate_templates`, `get_estimate_template`, `create_estimate_template`, `update_estimate_template`, `delete_estimate_template` — full `/sales/v2` estimate-template surface.

### New: `get_job_history` (#29)
- Per-ticket audit-log read tool for jobs.

### MCP native surface (#51)
- `registerTool` migration to spec-correct titles/annotations/`structuredContent` across all tools; `outputSchema` on the top-10 tools; resource-link offload for oversized results (>80KB → KV); browsable catalog resources (pricebook tree, PII-stripped roster, report catalog); 5 QSC workflow prompts (dispatch brief, closeout, AR chase, quote follow-up, membership outreach) with argument completions.

### Access & auth
- Read-only Claude Desktop connector ("Jessica Hunt") — new `readonly` role + `/c/<token>/mcp` (#34).
- Wrapped in `workers-oauth-provider`, Phase-2 read-only (#35).

### Reliability fixes
- Tenant-placeholder resolution bugs fixed (`get_capacity`, `st_get_capacity_slots`, `margin_audit`, others were sending the literal `/tenant/000000000/` to ST, causing live 403s).
- `get_invoice`, `get_invoice_balance`, `list_unpaid_invoices`, `get_call`, `get_form_submission` corrected to real ST endpoint/ID semantics (no `/invoices/{id}` or `/calls/{id}` route; forms are D1-first).
- `list_jobs_today` now queries today's appointments in ET, not the Jobs API.
- Post-deploy smoke gate + `/admin/errors/unacked` alert source added (#40).
- Description-lint static eval added; all tool descriptions brought to spec; corrected false `Source:D1` claims on 6 live-ST tools.

## v1.6.0 — 2026-05-25 (Dawn SMS + lockdown + readST sweep)

Combined release. Tool count **87 → 89** (+2); test count **451 → 472** (+21).

Branch: `feat/v1.6.0-dawn-and-sweep`. Three streams folded into one release per Luke's decision to ship Dawn alongside the in-flight v1.5.2 hardening + the v1.6 sweep.

### Stream A — MCP_LOCKDOWN role (was v1.5.2)
- New `lockdown` role in `src/auth.ts`. `MCP_LOCKDOWN=true` env flag short-circuits `resolveAuth` to force every caller into the lockdown role regardless of credentials.
- `toolsForRole('lockdown')` strips every `isWrite=true` tool and adminOnly tools (`st_call`). Composites stay (reads with extra D1 work).
- `/health` surfaces `lockdown: bool`.
- 7 new tests in `src/tools/__tests__/lockdown.test.ts` — doubles as an `isWrite`-classification audit (a name-pattern sweep catches missing `isWrite: true` on new write tools).
- Use case: defence-in-depth during incidents, or fronting an untrusted network. Toggle via env var, no redeploy.

### Stream B — Dawn SMS tools (new)
The conversational debrief agent on (843) 733-9568 calls these as MCP tools from a Retell text agent.

- **`identify_tech_by_phone(phone)`** — D1-only. Two-tier lookup: `voice_registry` (learned associations) → `technicians` (canonical sync). Returns `{status: 'found' | 'not_found' | 'parse_error', tech_id?, tech_name?, role?, business_unit?, source?}`. Always HTTP 200 (F8 lesson from voice era). 4 tests.
- **`save_tech_debrief(...)`** — D1-only. Idempotent INSERT...ON CONFLICT on `dawn_text_debriefs` D1 table (taylor-ai migration 0033, applied to dev + prod). Returns `{status: 'saved' | 'db_error' | 'parse_error', debrief_id?}`. 13 fields (retell_chat_id, tech_id/name/phone, job_id, customer_name, job_complete, parts_used, follow_up_*, additional_notes, transcript_summary, status). Uses `tech_name` not `name` (F9 lesson — `name` collides with Retell internal). 3 tests.

Both tools declare `stEndpoint: null` (added to `COVERAGE_EXEMPT`). Spec at `qsc-infra/docs/superpowers/specs/2026-05-25-miss-dawn-text-agent-design.md`.

### Stream C — readST sweep finished + doc correction
- `dispatch/get_capacity` — migrated raw `ST_PROXY.fetch` POST → new `readSTPost` helper.
- `dispatch/st_get_capacity_slots` — same treatment. Both dispatch tools use POST-as-read so `readSTPost` was added to `src/st.ts` (mirrors `readST` but method=POST + JSON body).
- `reporting/st_run_report` — 3 GET modes were already on `readST`; migrated the `run`-mode POST to `readSTPost`. Dropped unused `authHeaders` import.
- `pricebook/search_pricebook_all` — confirmed D1-only (calls `/api/sql/read`, not `/api/st/read`); no migration applicable. Added 5 smoke tests for the tool + `codeVariants` helper.
- README + CHANGELOG: removed stale "~25 hand-rolled fetch tools" language. All read tools are now on `readST` / `readSTPaged` / `readSTPost`. Write tools (`st_patch_*`, `st_create_*`, `assign_technicians`, etc.) intentionally stay on the write proxy.

### Deferred to v1.6.1 / v1.7
- Response-shaper rollout to the remaining ~62 hand-rolled tools (`transformResult` adoption). v1.6-PLAN scoped 1-2 days; deferred to keep v1.6.0 shippable today.
- Filter-preservation harness coverage across ~80 tools (test-only, incremental).
- ST-77.2/77.3 product probes — separable spikes.
- Tool-pack splitting (role/domain views) — needs design pass first.

## v1.5.1 — 2026-05-19 (ST-77 hardening)

Stacks on top of v1.5 (PR #17). Scope follows the external QA reviewer's pick: **sharp**, not a sweep. Tool count **86 → 87** (+1); test count **437 → 451** (+14).

### Infra
- New `src/st.ts` — `readST(env, ctx, endpoint, query?)` and `readSTPaged(env, ctx, endpoint, query?, options?)`. Centralizes the `env.ST_PROXY.fetch` + `URLSearchParams` + envelope-parse pattern that 30+ tools were hand-rolling. Built-in `hasMore` drain with a `maxPages` cap (default 50) so a runaway loop can't trigger.
- New `src/tools/__tests__/filter_preservation_helper.ts` — reusable test harness: `assertFilterPreservation(tool, matrix, baseArgs?, overrides?)`. For each declared filter, asserts one of: `forwarded_query` (live ST URL), `forwarded_path` (path segment), `forwarded_d1` (SQL WHERE clause), or `rejected_or_skipped` (validation_error or `_fallback_skipped` flag). Designed to be applied incrementally; first adopters are the v1.5.1 tools + 2 v1.5 regression checks.

### ST-77 alignment
- **`st_list_appointments`** — added `active` filter (forwarded as `active=True|False`). The returned `active` boolean on each row passes through unchanged.
- **`st_list_jobs`** + **`get_job`** — docstrings document the ST-77 `isAutoDispatched` field; both tools already return raw JSON so the field flows through naturally. Migrated both to `readST`.
- **New: `jobs_hold_reasons_list`** — wraps `/jpm/v2/tenant/{tid}/job-hold-reasons` (mirrors the `job-cancel-reasons` shape taylor-ai already syncs). Returns `{id, name, active}` rows. Pass to `hold_appointment` callers that need to resolve a reason name → ID before holding.

### Tests
- 14 new tests under `src/tools/__tests__/v151_st77.test.ts`:
  - 4 for `st_list_appointments` active filter + harness sweep of all 5 declared filters
  - 2 for `st_list_jobs` (`isAutoDispatched` pass-through + harness sweep)
  - 1 for `get_job` (`isAutoDispatched` pass-through)
  - 2 for `jobs_hold_reasons_list` (endpoint shape + active filter)
  - 5 regression-via-harness for `payroll_job_timesheets_list` (jobId, technicianId, appointmentId honored in D1 SQL) and `opportunities_list` (6 filters honored in D1 SQL)
- All 451 tests pass; `npm run check` clean.

### Migrated to readST helper
- `st_list_appointments`, `st_list_jobs`, `jobs/get_job` — 3 tools. The remaining hand-rolled read tools (`get_capacity`, `st_get_capacity_slots`, `st_run_report` run-mode) completed in v1.6.0. All read tools are migrated to `readST` / `readSTPaged` / `readSTPost` as of v1.6.0. Write tools (`st_patch_*`, `st_create_*`, `assign_technicians`, etc.) use the write proxy by design and stay direct.

### Out of scope (deferred per reviewer's note)
- Full filter-preservation coverage of all ~80 tools — harness is in place; each tool adopts via a one-test-per-tool addition.
- ST-77.2/77.3 product probes (Equipment auto-attach, Dispatch Pro multi-appointment, FTK dispatch links, Contact Center Pro, Inventory landed costs) — separate v1.6 candidates.
- `settings_intacct_business_unit_mappings_get` — only useful for shops on Sage Intacct.
- Tool-pack splitting (default / payroll / dispatch / accounting / pricebook / admin views) — context-pressure mitigation; separate design discussion.

## v1.5.0 — 2026-05-19

PR (`feat/v1.5-payroll-opportunities-dispatch-pro`): payroll + opportunities + dispatch-pro D1-first reads and four costing composites driven by today's ST Payroll API findings. Tool count **75 → 86** (+9 readers added; +2 composites in opportunities/dispatch_pro count is actually 9 new tools); test count **416 → 430** (+14).

Plan: `~/.claude/plans/inlite-of-what-we-elegant-mitten.md`. Today's payroll probe + Q1 job-costing findings are the motivation; per-job drive/working-time data now flows through the typed MCP surface instead of the taylor-ai proxy escape-hatch.

### New: D1-first reader tools (5)
| Tool | D1 table | ST endpoint mirror |
|---|---|---|
| `opportunities_list` | `opportunities` (mig 0018) | `/sales/v2/tenant/{tid}/opportunities` |
| `opportunity_get` | `opportunities` + `estimates` | `/sales/v2/tenant/{tid}/opportunities/{id}` |
| `dispatch_pro_utilization_list` | `dispatch_pro_utilization` (mig 0022) | reporting/operations/80766576 |
| `dispatch_pro_ratio_list` | `dispatch_pro_ratio` | reporting/operations/80770546 |
| `dispatch_pro_alerts_list` | `dispatch_pro_alerts` | reporting/operations/80769010 |

All five use `transformResult: defaultShaper` and read via the shared `src/d1.ts` helper (`POST /api/sql/read`, SELECT/WITH only).

### Refactored: `payroll_job_timesheets_list` to D1-first
- Previously: live-only (PR #16). Now: reads from the new `job_timesheets` D1 table (migration 0021, denormalized `drive_minutes` + `working_minutes`), with three modes — `auto` (D1, falls back to live on empty/stale with a jobId/appointmentId filter), `d1` (force D1), `live` (force live ST).
- Added filters: `technicianId`, `appointmentId`, `arrivedOnOrAfter`, `arrivedOnOrBefore`, `active`. The probe-reconciliation case (job 77423990 / Brooks / drive=24m + work=152m) is covered by both modes.

### New: composites (4)
| Composite | Purpose | Source |
|---|---|---|
| `job_cost_actuals` | Per-job rollup: timesheets + appointments + assignments + estimates + live invoice + computed `labor_burden_$ = (drive + work) × burdenRate / 60`. Reconciles to today's probe ($132 at $45/hr on the Brooks job). | mixed |
| `tech_drive_time_summary` | Per-tech rollup over a date window: drive %, working minutes, jobs/day, first-call drive, windshield cost ($110/hr default per YTD plan), labor burden. | D1 |
| `assigned_vs_sold_estimate_audit` | Credit-attribution diagnostic: estimates where `sold_by` is empty (status=Sold), no job link, or doesn't match any tech on `appointment_assignments`. | D1 |
| `open_opportunities_pulitzer_feed` | Open cohort (status NOT IN Won/Dismissed, active=1) joined to latest estimate + customer. Same shape as Pulitzer's `open-opportunities` report. | D1 |

### Fix: `create_task` schema expanded to 8 ST-required fields
- Previous shape sent only `{name, jobId, dueDate?, assignedToId?}` — ST returned 200 but created an incomplete task missing reporter / BU / classification.
- v1.5 schema: `body`, `reportedById`, `businessUnitId`, `employeeTaskTypeId`, `employeeTaskSourceId` are now required; `reportedDate` defaults to now; `isClosed` defaults to false; `priority` defaults to 'Normal' (enum: Normal/High/Urgent).

### Infra
- New `src/d1.ts` shared helper (`readD1(env, sql, params)`) — SELECT/WITH gate + typed result.
- `D1_TABLES` set in `src/read-router.ts` extended with: `job_timesheets`, `opportunities`, `opportunity_statuses`, `dispatch_pro_utilization`, `dispatch_pro_ratio`, `dispatch_pro_alerts`.
- Pre-deploy follow-up: migration `0003_webhook_event_index.sql` still needs to be applied to prod (`wrangler d1 execute <your-d1-database> --remote --file migrations/0003_webhook_event_index.sql`).

### QA round 1 — auto-fallback filter-honoring (PR #17 review)
- `payroll_job_timesheets_list` auto-fallback to live ST now requires `jobId` AND no filter the live endpoint can't honor. Previously the condition included `appointmentId`, but `liveRead`'s batch path only forwards page/pageSize/active=Any/modifiedOnOrAfter — so `{ appointmentId, source: 'auto' }` on empty/stale D1 silently returned a wide-net superset labeled `_source: 'live'`. Same class of bug for `technicianId`, `arrivedOnOrAfter`, `arrivedOnOrBefore`, `active`.
- `source: 'live'` with any of `technicianId`, `appointmentId`, `arrivedOnOrAfter`, `arrivedOnOrBefore`, `active` now throws `validation_error` instead of silently dropping them.
- `source: 'auto'` with an unsupported filter still returns the D1 result (no fallback) and includes `_fallback_skipped: 'unsupported_live_filter:<names>'` for transparency.
- 7 new regression tests cover: appointmentId/technicianId/arrived-window-don't-fallback, mixed-filter jobId+technicianId stays D1, live-rejects on each unsupported filter, jobId+modifiedOnOrAfter passes through cleanly. Test count 430 → 437.

## v1.4.1 — 2026-05-06

PR #8 (`feat/shape-inventory-webhooks`): three independently-shippable tracks — response shaper, inventory + payroll pack, webhook hardening. Tool count **66 → 74**; test count **316 → 398** (+82).

### Track 1 — Response shaper
- New `src/response-shape.ts` exporting `excludeFields`, `limitArrays`, `abbreviateKeys`, `defaultShaper`, `DEFAULT_EXCLUDED_FIELDS`, `RESERVED_KEYS`. Strips ST envelope noise (`paginationToken`, `requestId`, `eTag`, `_links`, `_meta`) and caps top-level arrays before MCP serialize.
- New optional `transformResult?: (result: unknown) => unknown` field on `ToolDef`; applied in `registerTool` between handler return and audit/serialize.
- Adopted on 3 high-payload smoke-test tools: `customer_snapshot` (with `limitArrays {jobs:25, invoices:25, estimates:25, locations:10}`), `job_closeout_report`, `st_list_customers`. Mechanical rollout to the remaining ~63 tools deferred to a follow-up PR.

### Track 2 — Inventory + payroll pack (8 new tools)
| Tool | Endpoint |
|---|---|
| `inventory_vendors_list` | `/inventory/v2/tenant/{tid}/vendors` |
| `inventory_warehouses_list` | `/inventory/v2/tenant/{tid}/warehouses` |
| `inventory_receipts_list` | `/inventory/v2/tenant/{tid}/receipts` |
| `inventory_transfers_list` | `/inventory/v2/tenant/{tid}/transfers` |
| `payroll_payrolls_list` | `/payroll/v2/tenant/{tid}/payrolls` |
| `payroll_non_job_timesheets_list` | `/payroll/v2/tenant/{tid}/non-job-timesheets` |
| `payroll_location_rates_list` | `/payroll/v2/tenant/{tid}/locations/rates` |
| `payroll_settings_get` | `/payroll/v2/tenant/{tid}/payroll-settings` |

All use `transformResult: defaultShaper`. Slim transforms default `active`/`*_id` fields to `null` (not `true`). Endpoint paths verified against `MeltanoLabs/tap-service-titan` (Singer tap) — several plan paths corrected (e.g. `/timesheets` → `/payrolls`, `/settings` → `/payroll-settings`, `/purchase-orders` deferred as export-only).

### Track 3 — Webhook hardening
- `ACCEPTED_EVENT_TYPES` allowlist on `webhook-ingest.ts` limited to 4 events from the Velocity n8n trigger node (verified 2026-05-06): `appointmentScheduled`, `jobCompleted`, `paymentReceived`, `customerCreated`. Unknown types now return 400 with `{error: 'unknown_event_type', received: <type>}`.
- Reads canonical `x-servicetitan-event` header before falling back to body fields.
- Per-event metric emission via `env.MCP_METRICS.writeDataPoint({indexes: [eventType], blobs: ['webhook'], doubles: [1]})` — cardinality bounded at 4.
- New migration `0003_webhook_event_index.sql` adds composite index `(event_type, received_at)` for type-filtered queries.

### Tests
- 316 → 398 tests (+82). `npm run check` clean.

### Deferred to v1.5
- Mechanical shaper rollout to the remaining ~63 tools.
- Inventory PO list (export-pattern API, deferred until `from`-token argument shape is added).
- Numeric slim fields default `0` → `null` for clearer "missing" semantics.
- Webhook `x-servicetitan-event-id` header read (currently `eventId` still comes from body).


## v1.4.0 — 2026-05-04

### Bug fixes
- `margin_audit` no longer silently truncates at one page. Previously fetched `pageSize=200` jobs and stopped, undercounting revenue/cost/margin for any business-unit/date-range with >200 jobs. Now paginates up to 4,000 jobs (20 pages × 200) via the new `pagedStRead` helper, with `_truncated: true` and `_warnings: ['truncated_at_max_pages']` surfaced honestly when the cap is hit.

### New helpers
- `src/paged-st-read.ts` — shared pagination helper for `/api/st/read` consumers. Loops on `hasMore`, defends against missing `hasMore` via `data.length < pageSize`, caps at `maxPages` (default 20), retries 429/502/503/504 with `Retry-After` parsing and exponential backoff, cooperates with the existing `StRateLimiter` Durable Object, and surfaces `partialFailures` / `warnings` instead of throwing on mid-paging errors.
- `src/name-resolver.ts` — cached business-unit and technician name → ID resolution against the upstream proxy's nightly-synced D1 tables. Tier match (exact > prefix > contains). Asymmetric ambiguity: read mode returns the first match by ascending id with `ambiguous: true`; write mode throws `validation_error` so writes can never silently target the wrong record.

### Tool ergonomics (additive — existing ID fields still work)
- `margin_audit` accepts `businessUnitName` as an alternative to `businessUnitId`.
- `dispatch_override_audit` accepts `businessUnitName` and `technicianName`.
- `list_jobs_today` accepts `businessUnitName` and `technicianName`.
- `list_technicians_available` accepts `businessUnitName`.

### Tests
- 11 unit tests for `pagedStRead` (loop, exit conditions, retry/backoff, abort, URL shaping).
- 13 unit tests for `name-resolver` (numeric pass-through, exact/prefix/contains, read vs. write ambiguity, cache memoization).
- 4 new integration tests for `margin_audit` (multi-page sum, maxPages truncation, validation refinements).

### Docs
- `docs/audit/margin-reporting-followup-2026-05-04.md` — verification path + acceptance criterion for the deferred ServiceTitan Reporting API migration of `margin_audit`. Tracked rather than guessed (no verified saved-report ID exists yet).

### Deferred to v1.4.1
- Mechanical migration of the other eight truncating composites (`dispatch_override_audit`, `job_closeout_report`, `customer_snapshot` fan-out sub-calls, `membership_jackpot_leaderboard`, `membership_outreach_list`, `commercial_plumbing_opportunities`, `pricebook_health_check_services`, `call_quality_review`) to `pagedStRead`. Helper soaks first.

### Deferred to v1.5
- `st_intel_revenue_summary` (and any Reporting-API migration of `margin_audit`) gated on the verification path in `docs/audit/margin-reporting-followup-2026-05-04.md`.


## Unreleased (folded into v1.4.0)

### Security
- Require credentials for `POST /mcp` (`Authorization: Bearer <JWT>` or `X-Sync-Key`) before registering tools.
- Reject JWT authentication when `JWT_SECRET` is missing, too short, or placeholder-like.
- Make confirmation-token consumption conditional on `consumed_at IS NULL` to close the replay race window.

### Repository readiness
- Declare direct `jose` dependency and align `package-lock.json` root metadata.
- Add CI, Dependabot, issue templates, `.env.example`, `CONTRIBUTING.md`, and `docs/PUBLISHING_CHECKLIST.md` for public feedback.
- Change Cloudflare deployment to manual dispatch so public-feedback changes are not automatically deployed from `main`.
- Replace production tenant IDs, worker URLs, Cloudflare resource IDs, and raw audit artifacts with public-safe placeholders.
- Add runtime tenant placeholder rewriting from `ST_TENANT_ID` so the public source can remain sanitized.

## v1.2.0 — 2026-05-02

### New tools
- `st_get_capacity_slots` — Scheduler Pro slot availability lookup
- `st_run_report` — Run any ST report by category ID + report ID (mode discriminator)
- `st_post_marketing_attribution` — Post marketing attribution (kind discriminator: call / web-visit / email)

### New routes
- `GET /admin/endpoints` — ST endpoint inventory: per-tool `stEndpoint` descriptors + undeclared list

### Observability
- `stEndpoint` descriptor added to every tool definition; powers `/admin/endpoints` gap analysis
- `/admin/metrics` enriched: `period_1h`, `period_24h`, `period_7d` with `error_rate_pct`; `by_actor_24h`; `write_gate_24h` (dry_runs / confirmed / expired)
- `scripts/query-metrics.sql` — 8 documented Analytics Engine SQL queries for Grafana panels

### Security
- `admin-guard.ts` `requireAdminKey` upgraded to async timing-safe comparison via HMAC ephemeral key (prevents timing-side-channel on X-Sync-Key check)
- Gitleaks secret scan added to `scripts/preflight.sh` step [7] (mandatory, CI-enforced)
- `.gitleaksignore` created; initial scan clean
- RBAC end-to-end verified: default role (65 tools, no `st_call`); admin role (66 tools, `st_call` visible); direct call to `st_call` without admin role returns "tool not found"
- `SECURITY.md` + STRIDE-lite threat model added at repo root

### Docs
- `SECURITY.md` — threat model, write-gate flow diagram, audit posture, known limitations
- `CHANGELOG.md` — this file
- `README.md` — Observability section, `/admin/metrics` description update, `/webhooks/st` marked v1.3 (not 501)

### CI
- GitHub Actions `deploy.yml` installs gitleaks v8.30.1 before running preflight

### Deferred to v1.3
- `StRateLimiter` DO hot-path integration (scaffolded, not wired)
- `/webhooks/st` HMAC ingest (stub returns 501)
- `marketing_roas` tool (gated on mcp-scorpion/lsa/lace data)
- Heartbeat KV emission


## v1.1.0 — 2026-04-23

### New tools (H-batch — "H1 write factory")
- `book_job`, `reschedule_appointment`, `hold_appointment`, `assign_technicians` — job lifecycle writes
- `add_customer_note`, `add_job_note` — note writing
- `create_task`, `list_open_tasks` — task management (read + create; ST task API is read+create only, no PATCH)
- `get_call`, `get_form_submission` — calls + forms
- `list_memberships_active`, `list_memberships_expiring`, `create_recurring_service` — membership surface
- `list_campaigns`, `get_campaign_performance`, `create_call_with_campaign` — marketing
- `get_capacity`, `list_technicians_available`, `get_technician_shifts`, `list_non_job_events` — dispatch
- `list_estimates_job`, `get_estimate`, `update_estimate_status` — estimates
- `get_invoice`, `list_invoices_job`, `get_invoice_balance`, `list_unpaid_invoices` — invoicing

### New composites
- `pricebook_health_check_services`, `margin_audit`, `membership_outreach_list`, `dispatch_override_audit`, `call_quality_review`, `commercial_plumbing_opportunities`, `membership_jackpot_leaderboard` — L5 composites for LLM-ready reporting

### Infrastructure
- Durable Object `StRateLimiter` scaffolded (`src/durable/st-rate-limiter.ts`) — token-bucket per endpoint family, not yet wired into hot path
- HMAC write-gate pattern: dryRun → confirmation token (args_hash, 15-min TTL, single-use) → confirm
- `scripts/inspector-smoke.sh` — automated 3-check smoke (tools/list, st_list_customers, add_customer_note dryRun)
- `scripts/rollback-test.sh` — 4-stage D1 rollback test (verified 2026-05-02)
- `scripts/preflight.sh` — 29-check pre-deploy gate

### Security
- `resolveRole` + D1 `mcp_roles` table — RBAC gate for admin vs default tool visibility
- `st_call` admin gateway added (role=admin only)

### D1 schema (migration 0001_baseline)
- `audit_log`, `error_log`, `confirmation_tokens`, `mcp_cache`, `mcp_roles`, `mv_customer_snapshot`, `mv_margin_audit`


## v1.0.0 — 2026-04-14

### Initial release ("super-MCP build")
- F1 tool set: `st_list_customers`, `st_get_customer`, `st_list_jobs`, `st_list_appointments`, `st_get_pricebook`, `st_patch_service`, `st_create_service`, `st_patch_material`, `st_create_material`
- T5 CRM: `find_customer`, `get_customer`, `get_customer_locations`, `list_customer_jobs`, `get_customer_membership`
- T5 Jobs: `get_job`, `list_jobs_today`, `get_job_appointments`
- T6 Pricebook: `search_pricebook_services`, `get_service_details`, `search_materials`, `get_configurable_equipment_children`, `list_service_categories`, `search_pricebook_all`
- C10 Composite: `customer_snapshot`, `job_closeout_report`
- Siro: `siro_list_mobile_events`, `siro_get_recording_summary`, `siro_get_engagement`
- Cloudflare Worker, Hono, Agents SDK Streamable HTTP (`/mcp` route)
- D1 bindings, Analytics Engine (`MCP_METRICS`), servicetitan-proxy service binding
- CI auto-deploy via GitHub Actions (`CLOUDFLARE_API_TOKEN` secret)
