# QUA-783 — Shape the 3 `siro_*` tools with `defaultShaper`

**Date:** 2026-07-11
**Ticket:** QUA-783 (parent QUA-739, Phase 5 response-shaper sweep)
**Type:** research → small implementation
**Branch:** `lpeluso/qua-783-dev-verify-siro-payload-shape-before-shaping-siro_-tools` (worktree `.worktrees/qua-783`, off `origin/main`)

## Problem

The Phase-5 sweep (QUA-739) applied `transformResult: defaultShaper` to 42 read tools but
**deliberately excluded the 3 `siro_*` tools** (`siro_get_engagement`,
`siro_get_recording_summary`, `siro_list_mobile_events`). Those tools return the external Siro
API payload verbatim (`cacheGet(...) => siroFetch(...)`, no field projection).

`defaultShaper` recursively strips 5 key names: `paginationToken`, `requestId`, `eTag`,
`_links`, `_meta`. The adversarial review of the sweep (finding **I-3**) flagged the risk that
Siro might be HAL-style and expose the recording/media URL only under `_links.*.href` (or
metadata under `_meta`) — in which case shaping would silently delete the caller's only pointer
to the recording. Unlike ServiceTitan (verified `{data,hasMore,page,pageSize,totalCount}`
envelopes, no HAL links), Siro's payload shape was unverified locally.

## Research finding (2026-07-11) — I-3 does NOT hold

Captured real live payloads from all 3 tool endpoints (prod worker has no `SIRO_API_TOKEN`, so
probed Siro directly with the `~/.env` token, read-only) and scanned each recursively for the 5
stripped keys. **None of the 3 tool payloads contain any of the 5 keys.**

| Tool | Endpoint | Real shape | Recording/media pointer |
|---|---|---|---|
| `siro_list_mobile_events` | `/v1/core/mobile-events` | `{data:[{id,userId,recordingId,eventCode,event,value,externalOpportunityIds,createdAt,organizationId}], cursor}` | plain scalar `recordingId`; pagination key is **`cursor`** (not `paginationToken`, so unaffected) |
| `siro_get_recording_summary` | `/v1/core/recordings/{id}/summaries` | `{data:[{id,name,content}]}` (empty `{data:[]}` until a summary is generated) | none — summary carries no URL |
| `siro_get_engagement` | `/v1/integrations/engagements/{id}` | flat object incl. `recordingId, opportunityId, accountId, subject, content, engagementUsers, …` | plain scalar `recordingId` |

The only media/web URL in the Siro API lives on `/v1/core/recordings` (a **list endpoint that is
not one of the 3 tools**) at `links.web.self` = `https://salespro.siro.ai/#/recordings/{compositeId}`.
That key is **`links`** (no underscore); `defaultShaper` strips `_links` (with underscore), so it
would survive anyway — but it is moot, as none of the 3 tools return it.

**Verdict:** safe to apply `transformResult: defaultShaper` to all 3 (ticket option **a**); no
bespoke shaper needed. On today's payloads the shaper is effectively a no-op (strips nothing);
its value is forward-consistency with the other 42 shaped tools and forward-protection if Siro
later adds `_meta`/`_links` noise.

## Design

### 1. Code — 3 files, identical 2-line edit each
`src/tools/siro_get_engagement.ts`, `siro_get_recording_summary.ts`, `siro_list_mobile_events.ts`:
- add `import { defaultShaper } from '../response-shape';` (siro tools live directly under
  `src/tools/`, so `'../response-shape'`, same as `st_list_customers.ts`)
- add `transformResult: defaultShaper,` to the exported `ToolDef`.

### 2. Tests — TDD, additions written to fail first (`transformResult` is `undefined` pre-change)
- **Wiring:** add the 3 tools to `SWEPT_TOOLS` in
  `src/tools/__tests__/read_shaper_sweep.test.ts` and bump the count assertion `42 → 45`.
  Update the header comment to note the +3 (QUA-783).
- **Real-payload guard (new `src/tools/__tests__/siro_shaper.test.ts`):** three fixtures = the
  actual payloads captured 2026-07-11. Each runs `tool.transformResult!(fixture)` and asserts
  the load-bearing fields survive, plus that none of the 5 stripped keys reappear:
  - mobile-events → top-level `cursor` preserved; `data[0].recordingId` preserved.
  - summary → `data[0].{id,name,content}` preserved.
  - engagement → `recordingId`, `opportunityId`, `subject` scalars preserved.
  This converts the research into a durable regression guard against exactly the I-3 failure mode
  (a future Siro shape change that moves a semantic field under `_links`/`_meta`).

### 3. Docs / "deferred list" removal
No file literally names the 3 tools as "deferred-for-shaping" — the deferral lived in QUA-739's
finding I-3 and this ticket. Concretely: add a `CHANGELOG.md` entry
("QUA-783: `defaultShaper` applied to the 3 `siro_*` tools; I-3 resolved — real payloads verified
HAL-free; +3 to the shaper sweep, count 42→45"). The README `Siro | 3` row is an inventory row
(makes no shaper claim) and needs no edit.

### 4. Out of scope (YAGNI)
- Adding `SIRO_API_TOKEN` to the prod worker (separate concern; today the live MCP siro tools
  return `auth_failed` in prod).
- `COVERAGE_EXEMPT` in `admin-endpoints.ts` — stays; it is about ST-endpoint declaration (siro
  has no ST endpoint), unrelated to shaping.
- Any change to the recordings/opportunities/accounts endpoints or a bespoke shaper.

## Verification
- `npm test` — full suite green, including the new sweep count `45` and the 3 fixture assertions.
- `npm run lint` + typecheck clean.
- Show real command output before claiming done (no "done" without fresh output).
- Close QUA-783 with a summary comment; branch merges independently to `main`.
