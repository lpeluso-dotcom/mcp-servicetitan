# QUA-783 — Shape the 3 `siro_*` tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply `transformResult: defaultShaper` to the 3 `siro_*` tools (verified safe — Siro carries no `_links`/`_meta` on these endpoints) and remove them from the shaper "deferred" status, guarded by a real-payload regression test.

**Architecture:** Two-line edit (import + `transformResult`) to each of 3 tool files. A new behavioral test runs each tool's `transformResult` over the real Siro payloads captured 2026-07-11 and asserts every load-bearing field survives; the existing table-driven wiring sweep is extended 42→45. A CHANGELOG entry records the resolution.

**Tech Stack:** TypeScript, Cloudflare Workers, Vitest. Verify with `npm run check` (= `tsc --noEmit && vitest run`). No lint script.

**Working dir:** `/home/taylor/work/mcp-servicetitan/.worktrees/qua-783` (branch `lpeluso/qua-783-dev-verify-siro-payload-shape-before-shaping-siro_-tools`, off `origin/main`). All paths below are relative to this worktree.

**Spec:** `docs/superpowers/specs/2026-07-11-qua-783-siro-shaper-design.md`

---

## File Structure

- `src/tools/siro_get_engagement.ts` — modify: +import, +`transformResult`
- `src/tools/siro_get_recording_summary.ts` — modify: +import, +`transformResult`
- `src/tools/siro_list_mobile_events.ts` — modify: +import, +`transformResult`
- `src/tools/__tests__/siro_shaper.test.ts` — **create**: real-payload regression guard (QUA-783)
- `src/tools/__tests__/read_shaper_sweep.test.ts` — modify: +3 imports, +3 to `SWEPT_TOOLS`, count 42→45, header/title
- `CHANGELOG.md` — modify: add `## Unreleased` section with the QUA-783 bullet

---

## Task 1: Shape the 3 siro tools (test-first)

**Files:**
- Create: `src/tools/__tests__/siro_shaper.test.ts`
- Modify: `src/tools/__tests__/read_shaper_sweep.test.ts`
- Modify: `src/tools/siro_get_engagement.ts`, `src/tools/siro_get_recording_summary.ts`, `src/tools/siro_list_mobile_events.ts`

- [ ] **Step 1: Write the failing behavioral test** — create `src/tools/__tests__/siro_shaper.test.ts` with exactly this content:

```ts
// ============================================================
// siro_shaper.test.ts — QUA-783
//
// Real Siro payloads captured 2026-07-11 from the 3 siro_* tool
// endpoints. Proves defaultShaper preserves every load-bearing Siro
// field. The sweep review's finding I-3 feared a HAL-style
// `_links.*.href` media pointer would be stripped; verified here that
// Siro exposes none of the 5 stripped keys on these 3 tools, and the
// recording pointer (`recordingId`, a plain scalar) survives.
// ============================================================
import { describe, it, expect } from 'vitest';
import { siro_list_mobile_events } from '../siro_list_mobile_events';
import { siro_get_recording_summary } from '../siro_get_recording_summary';
import { siro_get_engagement } from '../siro_get_engagement';

const STRIPPED = ['paginationToken', 'requestId', 'eTag', '_links', '_meta'] as const;

function keysAnywhere(v: unknown, acc = new Set<string>()): Set<string> {
  if (Array.isArray(v)) {
    for (const item of v) keysAnywhere(item, acc);
  } else if (v && typeof v === 'object') {
    for (const [k, val] of Object.entries(v)) {
      acc.add(k);
      keysAnywhere(val, acc);
    }
  }
  return acc;
}

// --- /v1/core/mobile-events (verbatim real rows) ---
const MOBILE_EVENTS = {
  data: [
    {
      id: '86f3256c-1b0f-4434-b8a5-0d8ee4c2c840',
      recordingId: null,
      userId: 'hvp84DlKcNS1L2cO8O4tYnaT0rB2',
      organizationId: '7e5fbcad-1839-4dcb-b13f-4659468c64a6',
      createdAt: '2026-07-11T13:17:43.676Z',
      eventCode: 'appStateChange',
      event: { value: 'background' },
    },
    {
      id: 'fbfa2212-12cb-4293-affb-bb784343c1bc',
      recordingId: '6778f6ca-31cc-4412-acce-57dd223f5d20-hvp84DlKcNS1L2cO8O4tYnaT0rB2',
      userId: 'hvp84DlKcNS1L2cO8O4tYnaT0rB2',
      organizationId: '7e5fbcad-1839-4dcb-b13f-4659468c64a6',
      createdAt: '2026-07-11T13:17:43.659Z',
      eventCode: 'appStateChange',
      event: { value: 'background' },
      externalOpportunityIds: ['83174924'],
    },
  ],
  cursor: 'MjAyNi0wNy0xMVQxMzoxNzo0My42MDda',
};

// --- /v1/core/recordings/{id}/summaries (verbatim real row) ---
const SUMMARY = {
  data: [
    {
      id: '01c92684-1d96-4dbc-a7d5-5674048ba9ac',
      name: 'Outcome & Next Steps',
      content:
        'The transcript is too incomplete to determine any secured commitment, any materials left with the customer, or any promised follow-up.',
    },
  ],
};

// --- /v1/integrations/engagements/{id} (verbatim real subset) ---
const ENGAGEMENT = {
  id: '07d7dd48-2247-449d-b810-5dda42da4e34',
  externalId: 'e547fed4-4afb-4dcb-b097-cfc0ee9f8d7d',
  subject: 'Clemson Pee Dee Rec , Job # 82023266',
  content: null,
  opportunityId: 'accb4ac5-3422-4548-9d9a-9beb34d90cd3',
  accountId: '264203_269264',
  organizationId: '7e5fbcad-1839-4dcb-b13f-4659468c64a6',
  engagementType: 'SIRO_EVENT',
  recordingId: 'f3ce377b-d880-4d91-932e-46c5d4f527de-VHEkqKZjJxMKLJBXlIGzY28ThYc2',
  engagementUsers: [
    { id: 'ba003ab9-5c8c-4b25-946a-492ad254fb99', userId: '93714fbf-cba0-4569-a188-6a6e7f551f77', externalId: '5522937' },
  ],
};

describe('siro_list_mobile_events — defaultShaper preserves fields', () => {
  it('keeps the cursor and every row recordingId/eventCode', () => {
    const shaped = siro_list_mobile_events.transformResult!(MOBILE_EVENTS) as typeof MOBILE_EVENTS;
    expect(shaped.cursor).toBe('MjAyNi0wNy0xMVQxMzoxNzo0My42MDda');
    expect(shaped.data).toHaveLength(2);
    expect(shaped.data[0]).toHaveProperty('recordingId');
    expect(shaped.data[1].recordingId).toBe(
      '6778f6ca-31cc-4412-acce-57dd223f5d20-hvp84DlKcNS1L2cO8O4tYnaT0rB2',
    );
    expect(shaped.data[1].externalOpportunityIds).toEqual(['83174924']);
    for (const k of STRIPPED) expect([...keysAnywhere(shaped)]).not.toContain(k);
  });
});

describe('siro_get_recording_summary — defaultShaper preserves fields', () => {
  it('keeps data[].{id,name,content}', () => {
    const shaped = siro_get_recording_summary.transformResult!(SUMMARY) as typeof SUMMARY;
    expect(shaped.data[0].id).toBe('01c92684-1d96-4dbc-a7d5-5674048ba9ac');
    expect(shaped.data[0].name).toBe('Outcome & Next Steps');
    expect(shaped.data[0].content).toContain('too incomplete');
    for (const k of STRIPPED) expect([...keysAnywhere(shaped)]).not.toContain(k);
  });
});

describe('siro_get_engagement — defaultShaper preserves fields', () => {
  it('keeps recordingId/opportunityId/subject/accountId', () => {
    const shaped = siro_get_engagement.transformResult!(ENGAGEMENT) as typeof ENGAGEMENT;
    expect(shaped.recordingId).toBe(
      'f3ce377b-d880-4d91-932e-46c5d4f527de-VHEkqKZjJxMKLJBXlIGzY28ThYc2',
    );
    expect(shaped.opportunityId).toBe('accb4ac5-3422-4548-9d9a-9beb34d90cd3');
    expect(shaped.subject).toBe('Clemson Pee Dee Rec , Job # 82023266');
    expect(shaped.accountId).toBe('264203_269264');
    expect(shaped.engagementUsers[0].userId).toBe('93714fbf-cba0-4569-a188-6a6e7f551f77');
    for (const k of STRIPPED) expect([...keysAnywhere(shaped)]).not.toContain(k);
  });
});
```

- [ ] **Step 2: Extend the wiring sweep test** — in `src/tools/__tests__/read_shaper_sweep.test.ts`:

  (a) After the last existing import (`import { list_open_tasks } from '../tasks/list_open_tasks';`), add:

```ts
import { siro_list_mobile_events } from '../siro_list_mobile_events';
import { siro_get_recording_summary } from '../siro_get_recording_summary';
import { siro_get_engagement } from '../siro_get_engagement';
```

  (b) In the `SWEPT_TOOLS` array, after `list_open_tasks,` add:

```ts
  siro_list_mobile_events,
  siro_get_recording_summary,
  siro_get_engagement,
```

  (c) Change the count assertion from `expect(SWEPT_TOOLS).toHaveLength(42);` to `expect(SWEPT_TOOLS).toHaveLength(45);` and its `it(...)` label from `'swept exactly 42 tools'` to `'swept exactly 45 tools (42 + 3 siro, QUA-783)'`.

  (d) Change the header comment line `// Table-driven wiring check for the 42-tool defaultShaper sweep` to `// Table-driven wiring check for the defaultShaper sweep (42 read tools + 3 siro_*, QUA-783)` and the describe title from `'read_shaper_sweep — 42-tool defaultShaper wiring'` to `'read_shaper_sweep — 45-tool defaultShaper wiring (42 + 3 siro)'`.

- [ ] **Step 3: Run the two test files to verify they FAIL**

Run: `npm test -- src/tools/__tests__/siro_shaper.test.ts src/tools/__tests__/read_shaper_sweep.test.ts`
Expected: FAIL. `siro_shaper.test.ts` — all 3 cases throw `TypeError: siro_*.transformResult is not a function` (transformResult is `undefined`). `read_shaper_sweep.test.ts` — the 3 new siro rows fail `expect(typeof tool.transformResult).toBe('function')` (the length-45 assertion passes because the array already has 45 entries).

- [ ] **Step 4: Add the shaper to `src/tools/siro_get_engagement.ts`**

Add the import after `import type { ToolDef } from './index';`:

```ts
import { defaultShaper } from '../response-shape';
```

Add `transformResult: defaultShaper,` as a top-level `ToolDef` property immediately before the `async handler(env, args, { correlation }) {` line:

```ts
  transformResult: defaultShaper,
  async handler(env, args, { correlation }) {
```

- [ ] **Step 5: Add the shaper to `src/tools/siro_get_recording_summary.ts`** — identical edit: `import { defaultShaper } from '../response-shape';` after the `ToolDef` import, and `transformResult: defaultShaper,` immediately before its `async handler(env, args, { correlation }) {` line.

- [ ] **Step 6: Add the shaper to `src/tools/siro_list_mobile_events.ts`** — this file imports `ToolDef` on `import type { ToolDef } from './index';`. Add `import { defaultShaper } from '../response-shape';` after it, and `transformResult: defaultShaper,` immediately before its `async handler(env, args, { correlation }) {` line.

- [ ] **Step 7: Run the two test files to verify they PASS**

Run: `npm test -- src/tools/__tests__/siro_shaper.test.ts src/tools/__tests__/read_shaper_sweep.test.ts`
Expected: PASS (all siro_shaper cases green; sweep shows 45 tools all carrying `transformResult`).

- [ ] **Step 8: Run the full suite + typecheck**

Run: `npm run check`
Expected: `tsc --noEmit` clean, then `vitest run` all green.

- [ ] **Step 9: Commit**

```bash
git add src/tools/siro_get_engagement.ts src/tools/siro_get_recording_summary.ts \
        src/tools/siro_list_mobile_events.ts \
        src/tools/__tests__/siro_shaper.test.ts src/tools/__tests__/read_shaper_sweep.test.ts
git commit -m "feat(siro): apply defaultShaper to the 3 siro_* tools (QUA-783)

Real payloads verified HAL-free (no _links/_meta); recording pointer is
a plain recordingId scalar. Adds a real-payload regression guard and
extends the wiring sweep 42->45. Resolves finding I-3.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Docs — CHANGELOG entry (remove from "deferred" status)

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add an `## Unreleased` section** at the very top of `CHANGELOG.md`, immediately after the `# Changelog` line (line 1) and before `## v1.6.0`:

```markdown

## Unreleased

### QUA-783 — siro_* response shaping (finding I-3 resolved)
- `transformResult: defaultShaper` applied to the 3 `siro_*` tools (`siro_list_mobile_events`, `siro_get_recording_summary`, `siro_get_engagement`), which the Phase-5 sweep (QUA-739) had deferred pending payload verification.
- Real payloads captured 2026-07-11 from all 3 endpoints: none carry any of the 5 stripped keys (`paginationToken`/`requestId`/`eTag`/`_links`/`_meta`). Siro is not HAL-style on these tools — the recording pointer is a plain `recordingId` scalar, pagination uses `cursor` (not `paginationToken`), and the only media/web URL lives on the un-wrapped `/core/recordings` list endpoint under `links.web.self` (no underscore, so unaffected regardless).
- New `src/tools/__tests__/siro_shaper.test.ts` encodes the real shapes as a regression guard; `read_shaper_sweep.test.ts` extended 42→45.
```

- [ ] **Step 2: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): QUA-783 siro_* shaper (I-3 resolved)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Verify, push, and update Linear

**Files:** none (ops).

- [ ] **Step 1: Final verification**

Run: `npm run check`
Expected: typecheck clean + full vitest suite green. Capture the tail (test totals) as the completion evidence.

- [ ] **Step 2: Push the branch**

```bash
git push -u origin lpeluso/qua-783-dev-verify-siro-payload-shape-before-shaping-siro_-tools
```

- [ ] **Step 3: Open a PR** with `gh` (base `main`), body summarizing: research finding (I-3 disproven), the 2-line-each change, the new regression guard + sweep 42→45, and a link to QUA-783. Title: `feat(siro): shape 3 siro_* tools with defaultShaper (QUA-783)`.

- [ ] **Step 4: Update Linear QUA-783** — post a comment with the research verdict + evidence table + what shipped (link the PR), then move the issue to Done (state type `completed`). Use `mcp__linear-server__save_comment` and `mcp__linear-server__save_issue`.

---

## Self-Review

**Spec coverage:** (1) apply `defaultShaper` to 3 tools → Task 1 Steps 4-6. (2) real-payload verification encoded → Task 1 Step 1. (3) wiring/sweep consistency → Task 1 Step 2. (4) remove from "deferred" → Task 2 (CHANGELOG). (5) verify before done → Task 1 Step 8 + Task 3 Step 1. (6) git + Linear documentation → Task 3. All spec sections covered.

**Placeholder scan:** No TBD/TODO; every code step shows complete code; every run step shows the exact command + expected result.

**Type consistency:** Tool symbols (`siro_list_mobile_events`, `siro_get_recording_summary`, `siro_get_engagement`) match the exports in `src/tools/siro_*.ts` and the imports added in both test files. `transformResult` is the `ToolDef` property used throughout the repo. Count 45 used consistently in the assertion, label, and describe title. Fixture field names (`recordingId`, `cursor`, `opportunityId`, `engagementUsers[].userId`) match the captured payloads.
