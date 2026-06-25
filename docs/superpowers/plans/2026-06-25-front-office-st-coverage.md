# Front-Office ServiceTitan Coverage — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give QSC front-office staff (CSR / dispatch / sales-install) flexible, list-style and full-context ServiceTitan lookups through the connector they already use, by surfacing the taylor-ai D1 mirror as new read tools plus a guarded ad-hoc query tool.

**Architecture:** Additive tools in `mcp-servicetitan` (no protected file touched). Phase 1 = four D1-first read tools (`list_jobs`, `job_360`, `list_estimates`, `search_notes`) following the existing `readD1` pattern. Phase 2 = one `query_operations` tool gated by an AST allow-list (`node-sql-parser`, ported from `qsc-hopper/src/gateway/allowlist.ts`) over a curated operational table set. Cross-cutting = hot-table indexes on taylor-ai D1, and deploying the already-coded read-only office connector. All new read tools auto-join the `readonly` role (no `isWrite` flag).

**Tech Stack:** TypeScript, Cloudflare Workers, `agents/mcp` SDK, Zod, D1 (taylor-ai mirror via `ST_PROXY` `readD1`; mcp's own `qsc-mcp-st` via `env.DB`), `node-sql-parser` 5.4.0, Vitest.

---

## VERIFICATION DELTAS (spec → code, found while reading the repo)

The 2026-06-25 spec listed six Phase-1 tools. Reading live code + D1 schema changed three of them — keep this list when reviewing:

1. **`job_history` DROPPED** — `list_customer_jobs` (live) already lists a customer's jobs, `customer_snapshot` already merges customer+jobs+invoices+memberships, and a tool named `get_job_history` already exists (live per-job audit timeline). A new `job_history` would collide/duplicate. *Customer history need is met by existing tools.*
2. **`list_memberships` DROPPED** — `list_memberships_active` and `list_memberships_expiring` already exist. No new membership list tool needed.
3. **`search_notes` scoped to customer notes only** — `customer_notes` has **no `job_id`** column; job-level notes are live-ST-only (added via `add_job_note`). So `search_notes` searches `customer_notes` (D1); job notes are out of D1 scope (resolves spec open-Q #3).
4. **`list_jobs` filters = real columns only** — `jobs` has `scheduled_date`, `technician_id`, `business_unit_id`, `job_type_id`, `job_status`, `customer_id`, `is_recall`. There is **no `hold_reason` column on `jobs`** (holds live on appointments / `jobs_hold_reasons_list`), so `list_jobs` does NOT offer a holdReason filter.

Net Phase-1 net-new tools: **`list_jobs`, `job_360`, `list_estimates`, `search_notes`** (4, not 6).

## FILE STRUCTURE

**Create (mcp-servicetitan):**
- `src/tools/jobs/list_jobs.ts` — D1 list/filter over `jobs`.
- `src/tools/composites/job_360.ts` — D1-first job full-context composite.
- `src/tools/estimates/list_estimates.ts` — D1 list/filter over `estimates`.
- `src/tools/crm/search_notes.ts` — D1 keyword search over `customer_notes`.
- `src/tools/query/operations_allowlist.ts` — ported AST allow-list gate (Phase 2).
- `src/tools/query/query_operations.ts` — guarded ad-hoc SELECT tool (Phase 2).
- `src/tools/__tests__/list_jobs.test.ts`, `job_360.test.ts`, `list_estimates.test.ts`, `search_notes.test.ts`, `operations_allowlist.test.ts`, `query_operations.test.ts`.

**Modify (mcp-servicetitan):**
- `src/tools/index.ts` — import + register the 5 new tools in `TOOLS` (NOT a protected file).
- `package.json` — add `node-sql-parser` dependency.
- `docs/audit/` — short acceptance note at the end.

**Create (taylor-ai repo, separate):**
- `migrations/NNNN_front_office_indexes.sql` (+ `_down.sql`) — hot-table indexes.

**Apply (ops, no file in this repo beyond the existing migration):**
- `migrations/0004_mcp_auth_tokens.sql` (already in mcp-servicetitan) → apply to prod `qsc-mcp-st` D1 + insert office token rows.

**Reference D1 ids:** taylor-ai prod `ba02a8c6-bcff-4119-b797-0b4250a3edcf`; taylor-ai-dev `28848a36-3210-4584-830b-fb1508b7503b`; qsc-mcp-st prod `5380b37c-132c-4f21-a294-d99b7e05e6cf`. Apply migrations via `mcp__claude_ai_Cloudflare_Developer_Platform__d1_database_query` (the local CF token lacks D1 scope).

---

## PHASE 0 — Setup

### Task 0: Add the SQL parser dependency (for Phase 2)

**Files:** Modify `package.json`

- [ ] **Step 1: Install node-sql-parser pinned to the version hopper uses**

Run: `cd /home/taylor/work/mcp-st-front-office && npm install node-sql-parser@5.4.0`
Expected: `package.json` gains `"node-sql-parser": "5.4.0"` under dependencies; lockfile updates.

- [ ] **Step 2: Verify it imports in the Workers build**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "build: add node-sql-parser@5.4.0 for query_operations gate"
```

---

## PHASE 1 — Coverage tools

### Task 1: `list_jobs` — D1 list/filter over jobs

**Files:**
- Create: `src/tools/jobs/list_jobs.ts`
- Test: `src/tools/__tests__/list_jobs.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/tools/__tests__/list_jobs.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../../d1', () => ({ readD1: vi.fn() }));
import { readD1 } from '../../d1';
import { list_jobs } from '../jobs/list_jobs';

const ctx = { actor: 'test', correlation: 'c1' };

describe('list_jobs', () => {
  beforeEach(() => vi.mocked(readD1).mockReset());

  it('filters by technicianId + scheduled date range and reports has_more', async () => {
    vi.mocked(readD1).mockResolvedValue({
      rows: Array.from({ length: 51 }, (_, i) => ({ job_id: i })),
    } as any);
    const r: any = await list_jobs.handler({} as any,
      { technicianId: 123, scheduledFrom: '2026-06-01', scheduledTo: '2026-06-07', pageSize: 50 }, ctx);
    expect(r.has_more).toBe(true);
    expect(r.jobs).toHaveLength(50);
    const call = vi.mocked(readD1).mock.calls[0];
    const sql = call[1] as string;
    const params = call[2] as unknown[];
    expect(sql).toContain('technician_id = ?');
    expect(sql).toContain('scheduled_date >= ?');
    expect(sql).toContain('scheduled_date <= ?');
    expect(sql).toContain('LIMIT ? OFFSET ?');
    expect(params).toEqual([123, '2026-06-01', '2026-06-07', 51, 0]);
  });

  it('returns all rows with no filters and has_more=false when under page size', async () => {
    vi.mocked(readD1).mockResolvedValue({ rows: [{ job_id: 1 }, { job_id: 2 }] } as any);
    const r: any = await list_jobs.handler({} as any, {}, ctx);
    expect(r.has_more).toBe(false);
    expect(r.count).toBe(2);
    expect((vi.mocked(readD1).mock.calls[0][1] as string)).not.toContain('WHERE');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tools/__tests__/list_jobs.test.ts`
Expected: FAIL — cannot find module `../jobs/list_jobs`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/tools/jobs/list_jobs.ts
import { z } from 'zod';
import { McpError } from '../../errors';
import { defaultShaper } from '../../response-shape';
import { readD1 } from '../../d1';
import type { ToolDef } from '../index';

interface Args {
  technicianId?: number;
  scheduledFrom?: string;
  scheduledTo?: string;
  jobStatus?: string;
  businessUnitId?: number;
  jobTypeId?: number;
  customerId?: number;
  isRecall?: boolean;
  page?: number;
  pageSize?: number;
}

const DEFAULT_PAGESIZE = 50;
const MAX_PAGESIZE = 200;

export const list_jobs: ToolDef<Args> = {
  name: 'list_jobs',
  description:
    'List and filter ServiceTitan jobs across the whole board (not just today). ' +
    'Use for "all jobs for tech X this week", "jobs in a business unit by status", ' +
    '"a customer\'s jobs by date". Filter by technician, scheduled-date range, status, ' +
    'business unit, job type, customer, or recall flag. Source: D1 jobs mirror (synced every 2h).',
  zodSchema: {
    technicianId: z.number().int().positive().optional().describe('Assigned technician ID'),
    scheduledFrom: z.string().optional().describe("ISO date 'YYYY-MM-DD'. jobs.scheduled_date >= value"),
    scheduledTo: z.string().optional().describe("ISO date 'YYYY-MM-DD'. jobs.scheduled_date <= value"),
    jobStatus: z.string().optional().describe('Exact job_status (e.g. "Scheduled", "Completed", "Hold")'),
    businessUnitId: z.number().int().positive().optional().describe('business_unit_id'),
    jobTypeId: z.number().int().positive().optional().describe('job_type_id'),
    customerId: z.number().int().positive().optional().describe('customer_id'),
    isRecall: z.boolean().optional().describe('Only recall jobs when true'),
    page: z.number().int().positive().optional().describe('Page number, default 1'),
    pageSize: z.number().int().positive().max(MAX_PAGESIZE).optional()
      .describe(`Page size, default ${DEFAULT_PAGESIZE}, max ${MAX_PAGESIZE}`),
  },
  stEndpoint: { method: 'GET', path: '/jpm/v2/tenant/{tid}/jobs', source: 'd1' },
  async handler(env, args, { correlation }) {
    const page = args.page ?? 1;
    const pageSize = Math.min(args.pageSize ?? DEFAULT_PAGESIZE, MAX_PAGESIZE);
    const where: string[] = [];
    const params: unknown[] = [];
    if (args.technicianId !== undefined) { where.push('technician_id = ?'); params.push(args.technicianId); }
    if (args.scheduledFrom !== undefined) { where.push('scheduled_date >= ?'); params.push(args.scheduledFrom); }
    if (args.scheduledTo !== undefined) { where.push('scheduled_date <= ?'); params.push(args.scheduledTo); }
    if (args.jobStatus !== undefined) { where.push('job_status = ?'); params.push(args.jobStatus); }
    if (args.businessUnitId !== undefined) { where.push('business_unit_id = ?'); params.push(args.businessUnitId); }
    if (args.jobTypeId !== undefined) { where.push('job_type_id = ?'); params.push(args.jobTypeId); }
    if (args.customerId !== undefined) { where.push('customer_id = ?'); params.push(args.customerId); }
    if (args.isRecall !== undefined) { where.push('is_recall = ?'); params.push(args.isRecall ? 1 : 0); }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const offset = (page - 1) * pageSize;
    const sql =
      `SELECT job_id, customer_id, customer_name, location, business_unit, job_type, ` +
      `job_status, technician, technician_id, scheduled_date, completed_date, revenue, ` +
      `invoice_total, summary, is_recall FROM jobs ${whereSql} ` +
      `ORDER BY scheduled_date DESC LIMIT ? OFFSET ?`;
    try {
      const { rows } = await readD1<Record<string, unknown>>(env, sql, [...params, pageSize + 1, offset]);
      const hasMore = rows.length > pageSize;
      const slice = hasMore ? rows.slice(0, pageSize) : rows;
      return { count: slice.length, jobs: slice, has_more: hasMore, _source: 'd1' };
    } catch (err) {
      throw new McpError('upstream_error', `list_jobs failed: ${(err as Error).message}`, { correlation });
    }
  },
  transformResult: defaultShaper,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/tools/__tests__/list_jobs.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/tools/jobs/list_jobs.ts src/tools/__tests__/list_jobs.test.ts
git commit -m "feat(tools): list_jobs — D1 cross-record job list/filter"
```

### Task 2: `job_360` — full job context in one call

**Files:**
- Create: `src/tools/composites/job_360.ts`
- Test: `src/tools/__tests__/job_360.test.ts`

Reads five taylor-ai tables via `readD1` (job header, appointments, tech assignments, invoice + line items / materials, job timesheets / times) plus customer notes for the job's customer. Materials used = `invoice_items` where `type='Material'`.

- [ ] **Step 1: Write the failing test**

```ts
// src/tools/__tests__/job_360.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../../d1', () => ({ readD1: vi.fn() }));
import { readD1 } from '../../d1';
import { job_360 } from '../composites/job_360';

const ctx = { actor: 'test', correlation: 'c1' };

describe('job_360', () => {
  beforeEach(() => vi.mocked(readD1).mockReset());

  it('assembles job header, appointments, items, timesheets and notes', async () => {
    vi.mocked(readD1)
      .mockResolvedValueOnce({ rows: [{ job_id: 77, customer_id: 9, customer_name: 'Acme' }] } as any) // job
      .mockResolvedValueOnce({ rows: [{ appointment_id: 1, job_id: 77 }] } as any)                      // appts
      .mockResolvedValueOnce({ rows: [{ assignment_id: 5, technician_name: 'Pat' }] } as any)           // assignments
      .mockResolvedValueOnce({ rows: [{ invoice_id: 3, total: 100 }] } as any)                          // invoices
      .mockResolvedValueOnce({ rows: [{ item_id: 8, type: 'Material', sku_name: 'PVC' }] } as any)      // items
      .mockResolvedValueOnce({ rows: [{ timesheet_id: 2, drive_minutes: 12, working_minutes: 60 }] } as any) // timesheets
      .mockResolvedValueOnce({ rows: [{ id: 4, text: 'gate code 1234' }] } as any);                     // notes
    const r: any = await job_360.handler({} as any, { jobId: 77 }, ctx);
    expect(r.job.job_id).toBe(77);
    expect(r.appointments).toHaveLength(1);
    expect(r.materials_used).toEqual([{ item_id: 8, type: 'Material', sku_name: 'PVC' }]);
    expect(r.timesheets[0].working_minutes).toBe(60);
    expect(r.notes[0].text).toContain('gate code');
  });

  it('returns _found=false when the job header is missing', async () => {
    vi.mocked(readD1).mockResolvedValue({ rows: [] } as any);
    const r: any = await job_360.handler({} as any, { jobId: 999 }, ctx);
    expect(r._found).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tools/__tests__/job_360.test.ts`
Expected: FAIL — cannot find module `../composites/job_360`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/tools/composites/job_360.ts
import { z } from 'zod';
import { McpError } from '../../errors';
import { readD1 } from '../../d1';
import type { ToolDef } from '../index';

interface Args { jobId: number; noteLimit?: number }

export const job_360: ToolDef<Args> = {
  name: 'job_360',
  description:
    'Everything about one ServiceTitan job in a single call: job header, appointments, ' +
    'assigned technicians, the invoice with its line items, MATERIALS USED, job times ' +
    '(drive + working minutes), and recent customer notes. Use this instead of chaining ' +
    'get_job + get_job_appointments + get_invoice + ... . Source: D1 mirror (synced every 2h).',
  stEndpoint: { method: 'GET', path: '/jpm/v2/tenant/{tid}/jobs/{id}', source: 'd1' },
  zodSchema: {
    jobId: z.number().int().positive().describe('ST job ID'),
    noteLimit: z.number().int().positive().max(50).optional().describe('Max customer notes, default 10'),
  },
  async handler(env, args, { correlation }) {
    const { jobId } = args;
    const noteLimit = Math.min(args.noteLimit ?? 10, 50);
    try {
      const jobRes = await readD1<Record<string, unknown>>(
        env,
        `SELECT job_id, customer_id, customer_name, location, business_unit, job_type, ` +
          `job_status, technician, technician_id, scheduled_date, completed_date, revenue, ` +
          `invoice_total, summary, membership_id, is_recall FROM jobs WHERE job_id = ? LIMIT 1`,
        [jobId],
      );
      const job = jobRes.rows[0];
      if (!job) return { jobId, _found: false, _source: 'd1' };
      const customerId = job.customer_id as number | undefined;

      const [appts, assignments, invoices, items, timesheets, notes] = await Promise.all([
        readD1(env,
          `SELECT appointment_id, appointment_number, start_date, end_date, status FROM appointments WHERE job_id = ? ORDER BY start_date`,
          [jobId]),
        readD1(env,
          `SELECT assignment_id, appointment_id, technician_id, technician_name, status FROM appointment_assignments WHERE job_id = ?`,
          [jobId]),
        readD1(env,
          `SELECT invoice_id, invoice_number, invoice_status, subtotal, tax, total, balance, due_date, paid_date FROM invoices WHERE job_id = ?`,
          [jobId]),
        readD1(env,
          `SELECT item_id, invoice_id, sku_name, display_name, type, quantity, price, total, sold_hours FROM invoice_items WHERE job_id = ? ORDER BY invoice_id, item_id`,
          [jobId]),
        readD1(env,
          `SELECT timesheet_id, appointment_id, technician_id, dispatched_on, arrived_on, done_on, drive_minutes, working_minutes FROM job_timesheets WHERE job_id = ?`,
          [jobId]),
        customerId !== undefined
          ? readD1(env,
              `SELECT id, text, is_pinned, created_on FROM customer_notes WHERE customer_id = ? ORDER BY created_on DESC LIMIT ?`,
              [customerId, noteLimit])
          : Promise.resolve({ rows: [] as Record<string, unknown>[] }),
      ]);

      const allItems = (items as { rows: Record<string, unknown>[] }).rows;
      return {
        jobId,
        _found: true,
        job,
        appointments: (appts as { rows: unknown[] }).rows,
        technicians: (assignments as { rows: unknown[] }).rows,
        invoices: (invoices as { rows: unknown[] }).rows,
        line_items: allItems,
        materials_used: allItems.filter((i) => i.type === 'Material'),
        timesheets: (timesheets as { rows: unknown[] }).rows,
        notes: (notes as { rows: unknown[] }).rows,
        _source: 'd1',
      };
    } catch (err) {
      throw new McpError('upstream_error', `job_360 failed: ${(err as Error).message}`, { correlation });
    }
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/tools/__tests__/job_360.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/tools/composites/job_360.ts src/tools/__tests__/job_360.test.ts
git commit -m "feat(tools): job_360 — full job context (materials, times, notes) in one call"
```

### Task 3: `list_estimates` — cross-job estimate list/filter

**Files:**
- Create: `src/tools/estimates/list_estimates.ts`
- Test: `src/tools/__tests__/list_estimates.test.ts`

"Open estimates not followed up" = `status='Open' AND sold_on IS NULL`, oldest first.

- [ ] **Step 1: Write the failing test**

```ts
// src/tools/__tests__/list_estimates.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../../d1', () => ({ readD1: vi.fn() }));
import { readD1 } from '../../d1';
import { list_estimates } from '../estimates/list_estimates';

const ctx = { actor: 'test', correlation: 'c1' };

describe('list_estimates', () => {
  beforeEach(() => vi.mocked(readD1).mockReset());

  it('openOnly adds status + unsold predicate and orders oldest first', async () => {
    vi.mocked(readD1).mockResolvedValue({ rows: [] } as any);
    await list_estimates.handler({} as any, { openOnly: true, businessUnit: 'HVAC Service' }, ctx);
    const sql = vi.mocked(readD1).mock.calls[0][1] as string;
    const params = vi.mocked(readD1).mock.calls[0][2] as unknown[];
    expect(sql).toContain("status = 'Open'");
    expect(sql).toContain('sold_on IS NULL');
    expect(sql).toContain('business_unit = ?');
    expect(sql).toContain('ORDER BY created_date ASC');
    expect(params[0]).toBe('HVAC Service');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tools/__tests__/list_estimates.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/tools/estimates/list_estimates.ts
import { z } from 'zod';
import { McpError } from '../../errors';
import { defaultShaper } from '../../response-shape';
import { readD1 } from '../../d1';
import type { ToolDef } from '../index';

interface Args {
  status?: string;
  openOnly?: boolean;
  businessUnit?: string;
  customerId?: number;
  jobId?: number;
  createdFrom?: string;
  createdTo?: string;
  page?: number;
  pageSize?: number;
}

const DEFAULT_PAGESIZE = 50;
const MAX_PAGESIZE = 200;

export const list_estimates: ToolDef<Args> = {
  name: 'list_estimates',
  description:
    'List and filter ServiceTitan estimates across jobs. Use for "open estimates not followed up", ' +
    '"estimates by business unit", "old unsold estimates". openOnly=true returns Open + unsold ' +
    'estimates oldest-first (the follow-up queue). Source: D1 estimates mirror (synced daily).',
  zodSchema: {
    status: z.string().optional().describe('Exact status (e.g. "Open", "Sold", "Dismissed")'),
    openOnly: z.boolean().optional().describe('Shortcut: Open status AND not yet sold (follow-up queue)'),
    businessUnit: z.string().optional().describe('Exact business_unit string'),
    customerId: z.number().int().positive().optional().describe('customer_id'),
    jobId: z.number().int().positive().optional().describe('job_id'),
    createdFrom: z.string().optional().describe("ISO date 'YYYY-MM-DD'. created_date >= value"),
    createdTo: z.string().optional().describe("ISO date 'YYYY-MM-DD'. created_date <= value"),
    page: z.number().int().positive().optional(),
    pageSize: z.number().int().positive().max(MAX_PAGESIZE).optional(),
  },
  stEndpoint: { method: 'GET', path: '/sales/v2/tenant/{tid}/estimates', source: 'd1' },
  async handler(env, args, { correlation }) {
    const page = args.page ?? 1;
    const pageSize = Math.min(args.pageSize ?? DEFAULT_PAGESIZE, MAX_PAGESIZE);
    const where: string[] = [];
    const params: unknown[] = [];
    if (args.openOnly) {
      where.push("status = 'Open'");
      where.push('sold_on IS NULL');
    } else if (args.status !== undefined) {
      where.push('status = ?'); params.push(args.status);
    }
    if (args.businessUnit !== undefined) { where.push('business_unit = ?'); params.push(args.businessUnit); }
    if (args.customerId !== undefined) { where.push('customer_id = ?'); params.push(args.customerId); }
    if (args.jobId !== undefined) { where.push('job_id = ?'); params.push(args.jobId); }
    if (args.createdFrom !== undefined) { where.push('created_date >= ?'); params.push(args.createdFrom); }
    if (args.createdTo !== undefined) { where.push('created_date <= ?'); params.push(args.createdTo); }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const offset = (page - 1) * pageSize;
    // Oldest-first so the follow-up queue surfaces the most-stale estimates at the top.
    const sql =
      `SELECT estimate_id, job_id, customer_id, customer_name, location_id, business_unit, ` +
      `status, summary, total, sold_on, sold_by, created_date, modified_date, project_id ` +
      `FROM estimates ${whereSql} ORDER BY created_date ASC LIMIT ? OFFSET ?`;
    try {
      const { rows } = await readD1<Record<string, unknown>>(env, sql, [...params, pageSize + 1, offset]);
      const hasMore = rows.length > pageSize;
      const slice = hasMore ? rows.slice(0, pageSize) : rows;
      return { count: slice.length, estimates: slice, has_more: hasMore, _source: 'd1' };
    } catch (err) {
      throw new McpError('upstream_error', `list_estimates failed: ${(err as Error).message}`, { correlation });
    }
  },
  transformResult: defaultShaper,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/tools/__tests__/list_estimates.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/estimates/list_estimates.ts src/tools/__tests__/list_estimates.test.ts
git commit -m "feat(tools): list_estimates — cross-job estimate list incl. follow-up queue"
```

### Task 4: `search_notes` — keyword search over customer notes

**Files:**
- Create: `src/tools/crm/search_notes.ts`
- Test: `src/tools/__tests__/search_notes.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/tools/__tests__/search_notes.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../../d1', () => ({ readD1: vi.fn() }));
import { readD1 } from '../../d1';
import { search_notes } from '../crm/search_notes';

const ctx = { actor: 'test', correlation: 'c1' };

describe('search_notes', () => {
  beforeEach(() => vi.mocked(readD1).mockReset());

  it('builds a LIKE predicate with wildcards bound as a parameter', async () => {
    vi.mocked(readD1).mockResolvedValue({ rows: [] } as any);
    await search_notes.handler({} as any, { query: 'gate code' }, ctx);
    const sql = vi.mocked(readD1).mock.calls[0][1] as string;
    const params = vi.mocked(readD1).mock.calls[0][2] as unknown[];
    expect(sql).toContain('text LIKE ?');
    expect(params[0]).toBe('%gate code%');
  });

  it('scopes by customerId when provided', async () => {
    vi.mocked(readD1).mockResolvedValue({ rows: [] } as any);
    await search_notes.handler({} as any, { query: 'x', customerId: 42 }, ctx);
    const sql = vi.mocked(readD1).mock.calls[0][1] as string;
    expect(sql).toContain('customer_id = ?');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tools/__tests__/search_notes.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/tools/crm/search_notes.ts
import { z } from 'zod';
import { McpError } from '../../errors';
import { defaultShaper } from '../../response-shape';
import { readD1 } from '../../d1';
import type { ToolDef } from '../index';

interface Args {
  query: string;
  customerId?: number;
  createdFrom?: string;
  createdTo?: string;
  pinnedOnly?: boolean;
  page?: number;
  pageSize?: number;
}

const DEFAULT_PAGESIZE = 25;
const MAX_PAGESIZE = 100;

export const search_notes: ToolDef<Args> = {
  name: 'search_notes',
  description:
    'Keyword-search CUSTOMER notes (e.g. "find the note about the gate code / dog / access"). ' +
    'Optionally scope to one customer or a date range, or only pinned notes. ' +
    'NOTE: this covers customer-level notes only; per-job notes are not mirrored to D1. ' +
    'Source: D1 customer_notes mirror.',
  zodSchema: {
    query: z.string().min(1).describe('Keyword/phrase; matched as a substring (case-insensitive)'),
    customerId: z.number().int().positive().optional().describe('Scope to one customer_id'),
    createdFrom: z.string().optional().describe("ISO date 'YYYY-MM-DD'. created_on >= value"),
    createdTo: z.string().optional().describe("ISO date 'YYYY-MM-DD'. created_on <= value"),
    pinnedOnly: z.boolean().optional().describe('Only pinned notes when true'),
    page: z.number().int().positive().optional(),
    pageSize: z.number().int().positive().max(MAX_PAGESIZE).optional(),
  },
  stEndpoint: { method: 'GET', path: '/crm/v2/tenant/{tid}/customers/notes', source: 'd1' },
  async handler(env, args, { correlation }) {
    const page = args.page ?? 1;
    const pageSize = Math.min(args.pageSize ?? DEFAULT_PAGESIZE, MAX_PAGESIZE);
    const where: string[] = ['text LIKE ?'];
    const params: unknown[] = [`%${args.query}%`];
    if (args.customerId !== undefined) { where.push('customer_id = ?'); params.push(args.customerId); }
    if (args.createdFrom !== undefined) { where.push('created_on >= ?'); params.push(args.createdFrom); }
    if (args.createdTo !== undefined) { where.push('created_on <= ?'); params.push(args.createdTo); }
    if (args.pinnedOnly) { where.push('is_pinned = 1'); }

    const offset = (page - 1) * pageSize;
    const sql =
      `SELECT id, customer_id, text, is_pinned, created_by_id, created_on FROM customer_notes ` +
      `WHERE ${where.join(' AND ')} ORDER BY created_on DESC LIMIT ? OFFSET ?`;
    try {
      const { rows } = await readD1<Record<string, unknown>>(env, sql, [...params, pageSize + 1, offset]);
      const hasMore = rows.length > pageSize;
      const slice = hasMore ? rows.slice(0, pageSize) : rows;
      return { count: slice.length, notes: slice, has_more: hasMore, _source: 'd1' };
    } catch (err) {
      throw new McpError('upstream_error', `search_notes failed: ${(err as Error).message}`, { correlation });
    }
  },
  transformResult: defaultShaper,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/tools/__tests__/search_notes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/crm/search_notes.ts src/tools/__tests__/search_notes.test.ts
git commit -m "feat(tools): search_notes — keyword search over customer notes"
```

### Task 5: Register the 4 Phase-1 tools + verify the coverage gate

**Files:**
- Modify: `src/tools/index.ts`

- [ ] **Step 1: Add imports** (after the `get_job_history` import block, ~line 118)

```ts
// Front-office coverage (2026-06-25)
import { list_jobs } from './jobs/list_jobs';
import { list_estimates } from './estimates/list_estimates';
import { search_notes } from './crm/search_notes';
import { job_360 } from './composites/job_360';
```

- [ ] **Step 2: Add to the TOOLS array** (append a labelled block before the closing `] as const;`)

```ts
  // Front-office coverage (2026-06-25) — D1 list/full-context reads
  list_jobs, list_estimates, search_notes, job_360,
```

- [ ] **Step 3: Run the coverage + full suite to verify no gate breakage**

Run: `npx vitest run`
Expected: PASS, including `coverage_gate.test.ts` (all four new tools declare `stEndpoint`) and `readonly_connector.test.ts` / `lockdown.test.ts` (the four new read tools have no `isWrite`, so they auto-appear in the readonly set and the no-write invariant still holds).

- [ ] **Step 4: Verify the new tools register at runtime**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/tools/index.ts
git commit -m "feat(tools): register list_jobs, list_estimates, search_notes, job_360"
```

### Task 6: Hot-table indexes on taylor-ai D1

**Files:**
- Create (taylor-ai repo): `migrations/NNNN_front_office_indexes.sql` and `migrations/NNNN_front_office_indexes_down.sql`

The number `NNNN` must be the next free taylor-ai migration number — check `ls /home/taylor/work/taylor-ai/migrations/ | sort | tail` and `git -C /home/taylor/work/taylor-ai fetch && git -C /home/taylor/work/taylor-ai log --oneline origin/main..HEAD` for in-flight collisions (per cloudflare.md migration etiquette) BEFORE naming the file.

- [ ] **Step 1: Confirm columns are unindexed (baseline)**

Run (via Cloudflare MCP `d1_database_query`, database_id `ba02a8c6-bcff-4119-b797-0b4250a3edcf`):
```sql
SELECT name, tbl_name FROM sqlite_master WHERE type='index' AND tbl_name IN ('jobs','appointments','appointment_assignments','invoices','invoice_items','estimates','customer_notes') ORDER BY tbl_name;
```
Expected: note which target columns already have indexes; only create the missing ones.

- [ ] **Step 2: Write the migration (only indexes not already present)**

```sql
-- migrations/NNNN_front_office_indexes.sql
-- Hot-path indexes for front-office coverage tools (list_jobs, job_360, list_estimates, search_notes).
CREATE INDEX IF NOT EXISTS idx_jobs_technician_id      ON jobs(technician_id);
CREATE INDEX IF NOT EXISTS idx_jobs_scheduled_date     ON jobs(scheduled_date);
CREATE INDEX IF NOT EXISTS idx_jobs_business_unit_id   ON jobs(business_unit_id);
CREATE INDEX IF NOT EXISTS idx_jobs_job_type_id        ON jobs(job_type_id);
CREATE INDEX IF NOT EXISTS idx_jobs_customer_id        ON jobs(customer_id);
CREATE INDEX IF NOT EXISTS idx_jobs_job_status         ON jobs(job_status);
CREATE INDEX IF NOT EXISTS idx_appointments_job_id     ON appointments(job_id);
CREATE INDEX IF NOT EXISTS idx_appt_assign_job_id      ON appointment_assignments(job_id);
CREATE INDEX IF NOT EXISTS idx_invoices_job_id         ON invoices(job_id);
CREATE INDEX IF NOT EXISTS idx_invoice_items_job_id    ON invoice_items(job_id);
CREATE INDEX IF NOT EXISTS idx_job_timesheets_job_id   ON job_timesheets(job_id);
CREATE INDEX IF NOT EXISTS idx_estimates_status        ON estimates(status);
CREATE INDEX IF NOT EXISTS idx_estimates_business_unit ON estimates(business_unit);
CREATE INDEX IF NOT EXISTS idx_estimates_created_date  ON estimates(created_date);
CREATE INDEX IF NOT EXISTS idx_customer_notes_customer ON customer_notes(customer_id);
```

```sql
-- migrations/NNNN_front_office_indexes_down.sql
DROP INDEX IF EXISTS idx_jobs_technician_id;
DROP INDEX IF EXISTS idx_jobs_scheduled_date;
DROP INDEX IF EXISTS idx_jobs_business_unit_id;
DROP INDEX IF EXISTS idx_jobs_job_type_id;
DROP INDEX IF EXISTS idx_jobs_customer_id;
DROP INDEX IF EXISTS idx_jobs_job_status;
DROP INDEX IF EXISTS idx_appointments_job_id;
DROP INDEX IF EXISTS idx_appt_assign_job_id;
DROP INDEX IF EXISTS idx_invoices_job_id;
DROP INDEX IF EXISTS idx_invoice_items_job_id;
DROP INDEX IF EXISTS idx_job_timesheets_job_id;
DROP INDEX IF EXISTS idx_estimates_status;
DROP INDEX IF EXISTS idx_estimates_business_unit;
DROP INDEX IF EXISTS idx_estimates_created_date;
DROP INDEX IF EXISTS idx_customer_notes_customer;
```

- [ ] **Step 3: Apply on DEV first and verify a representative plan uses an index**

Apply the migration body to dev (`d1_database_query`, database_id `28848a36-3210-4584-830b-fb1508b7503b`), then:
```sql
EXPLAIN QUERY PLAN SELECT * FROM jobs WHERE technician_id = 1 ORDER BY scheduled_date DESC LIMIT 50;
```
Expected: plan shows `SEARCH jobs USING INDEX idx_jobs_technician_id` (not `SCAN jobs`). Measure elapsed `sql_duration_ms` before/after; record both in the commit message.

- [ ] **Step 4: Apply on PROD**

Apply the same body to prod (`ba02a8c6-bcff-4119-b797-0b4250a3edcf`). Re-run the EXPLAIN to confirm index use on prod.

- [ ] **Step 5: Commit (taylor-ai repo) + catalog**

```bash
cd /home/taylor/work/taylor-ai
git add migrations/NNNN_front_office_indexes.sql migrations/NNNN_front_office_indexes_down.sql
git commit -m "perf(d1): front-office hot-path indexes (jobs/appointments/invoices/estimates/notes)"
```
Add a one-line row to `qsc-infra/.claude/rules/protected-modules.md` noting the new index migration.

---

## PHASE 2 — `query_operations` ask-anything

### Task 7: Port the AST allow-list gate (operational scope + PII denylist)

**Files:**
- Create: `src/tools/query/operations_allowlist.ts`
- Test: `src/tools/__tests__/operations_allowlist.test.ts`

Ports `qsc-hopper/src/gateway/allowlist.ts` (read it for the canonical shape). Differences: the allow-list is the operational table set; a `COLUMN_DENYLIST` regex blocks genuinely sensitive columns (none exist in scope today — this is forward-proofing; office PII like name/phone/email/address stays allowed); config mirrors hopper's `DEFAULT_CONFIG`.

- [ ] **Step 1: Write the failing test**

```ts
// src/tools/__tests__/operations_allowlist.test.ts
import { describe, it, expect } from 'vitest';
import { gateOperationsSql, OPERATIONAL_TABLES } from '../query/operations_allowlist';

describe('gateOperationsSql', () => {
  it('allows a single SELECT over an allow-listed table', () => {
    const r = gateOperationsSql('SELECT job_id, job_status FROM jobs WHERE technician_id = 5');
    expect(r.ok).toBe(true);
  });
  it('rejects a non-SELECT verb', () => {
    expect(gateOperationsSql('DELETE FROM jobs').ok).toBe(false);
    expect(gateOperationsSql('UPDATE jobs SET x=1').ok).toBe(false);
  });
  it('rejects multi-statement input', () => {
    expect(gateOperationsSql('SELECT 1 FROM jobs; SELECT 2 FROM jobs').ok).toBe(false);
  });
  it('rejects a table not on the allow-list', () => {
    expect(gateOperationsSql('SELECT * FROM mcp_roles').ok).toBe(false);
    expect(gateOperationsSql('SELECT * FROM sqlite_master').ok).toBe(false);
  });
  it('rejects a lookalike table name (anchored)', () => {
    expect(gateOperationsSql('SELECT * FROM jobs_secret').ok).toBe(false);
  });
  it('rejects SQL exceeding maxSqlLength', () => {
    expect(gateOperationsSql('SELECT * FROM jobs WHERE summary = ' + "'a'".repeat(5000)).ok).toBe(false);
  });
  it('exports the operational allow-list including jobs and invoices', () => {
    expect(OPERATIONAL_TABLES).toContain('jobs');
    expect(OPERATIONAL_TABLES).toContain('invoices');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tools/__tests__/operations_allowlist.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the gate**

```ts
// src/tools/query/operations_allowlist.ts
// AST allow-list gate for the office ad-hoc SELECT surface. Ported from
// qsc-hopper/src/gateway/allowlist.ts (node-sql-parser whiteListCheck), scoped to the
// operational taylor-ai mirror tables. Fail-closed default-deny.
import { Parser } from 'node-sql-parser';

/** Enumerated operational read surface. Anything not here is denied by omission. */
export const OPERATIONAL_TABLES: readonly string[] = [
  'jobs', 'appointments', 'appointment_assignments', 'invoices', 'invoice_items',
  'estimates', 'customer_notes', 'customers', 'locations', 'memberships',
  'technicians', 'technician_skills', 'job_timesheets', 'installed_equipment',
  'job_types', 'pb_services', 'pb_materials', 'pb_equipment', 'pb_categories', 'calls',
] as const;

/** Genuinely-sensitive column name patterns to reject even if a table is allowed.
 *  Office PII (name/phone/email/address) is intentionally NOT here — internal CSRs need it. */
const COLUMN_DENYLIST = /\b(ssn|social_security|card_number|cc_num|cvv|routing_number|bank_account|password|secret|api[_-]?key|token_hash)\b/i;

export interface GateConfig { rowCap: number; maxSqlLength: number; maxAstDepth: number }
export const DEFAULT_GATE_CONFIG: GateConfig = { rowCap: 1000, maxSqlLength: 8000, maxAstDepth: 12 };

function escapeRe(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
const AUTHORITIES = [`^select::(?:null|.*)::(?:${OPERATIONAL_TABLES.map(escapeRe).join('|')})$`];

export interface GateResult { ok: boolean; reason?: string }

export function gateOperationsSql(sql: string, cfg: GateConfig = DEFAULT_GATE_CONFIG): GateResult {
  const trimmed = (sql ?? '').trim();
  if (!trimmed) return { ok: false, reason: 'empty SQL' };
  if (trimmed.length > cfg.maxSqlLength) return { ok: false, reason: 'SQL too long' };
  if (COLUMN_DENYLIST.test(trimmed)) return { ok: false, reason: 'denied column referenced' };

  const parser = new Parser();
  let asts: unknown;
  try {
    asts = parser.astify(trimmed, { database: 'sqlite' });
  } catch {
    return { ok: false, reason: 'unparseable SQL' };
  }
  // astify returns an array for multi-statement input; reject anything but one statement.
  if (Array.isArray(asts)) {
    if (asts.length !== 1) return { ok: false, reason: 'only a single SELECT statement is allowed' };
  }
  const ast = Array.isArray(asts) ? asts[0] : asts;
  if (!ast || (ast as { type?: string }).type !== 'select') {
    return { ok: false, reason: 'only SELECT is allowed' };
  }
  // whiteListCheck throws if any (verb::db::table) tuple is not authorized.
  try {
    parser.whiteListCheck(trimmed, AUTHORITIES, { database: 'sqlite' });
  } catch {
    return { ok: false, reason: 'table not on the operational allow-list' };
  }
  return { ok: true };
}

/** Clamp a hard LIMIT onto the query so result sets can't exceed rowCap. */
export function clampLimit(sql: string, cfg: GateConfig = DEFAULT_GATE_CONFIG): string {
  return `SELECT * FROM (${sql.trim().replace(/;+\s*$/, '')}) LIMIT ${cfg.rowCap}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/tools/__tests__/operations_allowlist.test.ts`
Expected: PASS (7 tests). If `whiteListCheck`'s tuple format differs for SQLite, adjust the authority regex against the node-sql-parser version installed in Task 0 (it returns `select::null::jobs` for SQLite) — keep the test as the contract.

- [ ] **Step 5: Commit**

```bash
git add src/tools/query/operations_allowlist.ts src/tools/__tests__/operations_allowlist.test.ts
git commit -m "feat(query): AST allow-list gate for the office ad-hoc SELECT surface"
```

### Task 8: `query_operations` tool

**Files:**
- Create: `src/tools/query/query_operations.ts`
- Test: `src/tools/__tests__/query_operations.test.ts`

Runs the gate, clamps the row cap, then executes via `readD1` (which adds the proxy-side SELECT-only defense-in-depth). Rejected SQL never reaches `readD1`.

- [ ] **Step 1: Write the failing test**

```ts
// src/tools/__tests__/query_operations.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../../d1', () => ({ readD1: vi.fn() }));
import { readD1 } from '../../d1';
import { query_operations } from '../query/query_operations';

const ctx = { actor: 'office', correlation: 'c1' };

describe('query_operations', () => {
  beforeEach(() => vi.mocked(readD1).mockReset());

  it('runs an allow-listed SELECT and returns rows', async () => {
    vi.mocked(readD1).mockResolvedValue({ rows: [{ n: 3 }] } as any);
    const r: any = await query_operations.handler({} as any,
      { sql: 'SELECT COUNT(*) AS n FROM jobs WHERE job_status = "Hold"' }, ctx);
    expect(r.rows).toEqual([{ n: 3 }]);
    expect(vi.mocked(readD1)).toHaveBeenCalledTimes(1);
    // the executed SQL is wrapped with the row cap
    expect(vi.mocked(readD1).mock.calls[0][1] as string).toContain('LIMIT 1000');
  });

  it('rejects a disallowed table without calling readD1', async () => {
    await expect(query_operations.handler({} as any, { sql: 'SELECT * FROM mcp_roles' }, ctx))
      .rejects.toThrow(/allow-list|not allowed|denied/i);
    expect(vi.mocked(readD1)).not.toHaveBeenCalled();
  });

  it('rejects a mutation without calling readD1', async () => {
    await expect(query_operations.handler({} as any, { sql: 'DELETE FROM jobs' }, ctx))
      .rejects.toThrow();
    expect(vi.mocked(readD1)).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tools/__tests__/query_operations.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the tool**

```ts
// src/tools/query/query_operations.ts
import { z } from 'zod';
import { McpError } from '../../errors';
import { readD1 } from '../../d1';
import type { ToolDef } from '../index';
import { gateOperationsSql, clampLimit, OPERATIONAL_TABLES, DEFAULT_GATE_CONFIG } from './operations_allowlist';

interface Args { sql: string }

export const query_operations: ToolDef<Args> = {
  name: 'query_operations',
  description:
    'Run a read-only SQL SELECT over QSC operational ServiceTitan data when no other tool fits ' +
    '("just general things"). ALLOWED TABLES: ' + OPERATIONAL_TABLES.join(', ') + '. ' +
    'Rules: a single SELECT only (no INSERT/UPDATE/DELETE, no multiple statements); ' +
    `results are capped at ${DEFAULT_GATE_CONFIG.rowCap} rows. Prefer the named tools ` +
    '(list_jobs, job_360, list_estimates, search_notes, customer_snapshot) when one fits. Source: D1.',
  // Maps to no single ST endpoint — declared computed; add to the coverage-gate exemption set.
  stEndpoint: { method: 'GET', path: '/internal/query-operations', source: 'computed' },
  zodSchema: {
    sql: z.string().min(1).max(DEFAULT_GATE_CONFIG.maxSqlLength)
      .describe('A single read-only SELECT over the allowed operational tables.'),
  },
  async handler(env, args, { correlation }) {
    const gate = gateOperationsSql(args.sql);
    if (!gate.ok) {
      throw new McpError('validation_error', `query_operations rejected: ${gate.reason}`, { correlation });
    }
    const capped = clampLimit(args.sql);
    try {
      const { rows } = await readD1<Record<string, unknown>>(env, capped, []);
      return { count: rows.length, rows, row_cap: DEFAULT_GATE_CONFIG.rowCap, _source: 'd1' };
    } catch (err) {
      throw new McpError('upstream_error', `query_operations failed: ${(err as Error).message}`, { correlation });
    }
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/tools/__tests__/query_operations.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/tools/query/query_operations.ts src/tools/__tests__/query_operations.test.ts
git commit -m "feat(query): query_operations — guarded ad-hoc SELECT over operational D1"
```

### Task 9: Register `query_operations` + coverage-gate exemption

**Files:**
- Modify: `src/tools/index.ts`
- Modify: the coverage-gate exemption set (find it: `grep -rn "exempt" src/`; the gate lives behind `/admin/endpoints/coverage` with a vitest invariant — add `query_operations` to the same exemption list that currently holds `st_call` + the 3 Siro tools).

- [ ] **Step 1: Import + register**

```ts
import { query_operations } from './query/query_operations';
```
Append to TOOLS:
```ts
  // Front-office ad-hoc query (2026-06-25)
  query_operations,
```

- [ ] **Step 2: Add the exemption** so the coverage invariant passes (it maps to no real ST endpoint). Edit the exemption set discovered above to include `'query_operations'`.

- [ ] **Step 3: Run the full suite**

Run: `npx vitest run`
Expected: PASS — `coverage_gate.test.ts` passes with the exemption; `readonly`/`lockdown` sets include `query_operations` (no `isWrite`); all gate tests green.

- [ ] **Step 4: Commit**

```bash
git add src/tools/index.ts src/<coverage-exemption-file>
git commit -m "feat(query): register query_operations + coverage-gate exemption"
```

---

## PHASE 3 — Office connector deploy + adoption

### Task 10: Apply `mcp_auth_tokens` to prod + mint office tokens

**Files:** none new — uses existing `migrations/0004_mcp_auth_tokens.sql`.

- [ ] **Step 1: Confirm the table is absent on prod qsc-mcp-st**

Via `d1_database_query`, database_id `5380b37c-132c-4f21-a294-d99b7e05e6cf`:
```sql
SELECT name FROM sqlite_master WHERE type='table' AND name='mcp_auth_tokens';
```
Expected: empty (not yet applied) — if present, skip Step 2.

- [ ] **Step 2: Apply the migration to prod qsc-mcp-st**

Apply the contents of `migrations/0004_mcp_auth_tokens.sql` via `d1_database_query` against `5380b37c-132c-4f21-a294-d99b7e05e6cf`. Verify the table + its index exist afterward.

- [ ] **Step 3: Mint one office token (decision: per-user vs shared — see Open Q)**

Generate a high-entropy token locally (`openssl rand -hex 24`), SHA-256 it, and insert the hash (the raw token is the credential, never stored):
```sql
INSERT INTO mcp_auth_tokens (token_hash, role, owner, created_at, expires_at)
VALUES ('<sha256-hex-of-token>', 'readonly', 'front-office', <now-ms>, NULL);
```
Hand the raw `https://mcp-servicetitan.lpeluso.workers.dev/c/<token>/mcp` URL to the office out-of-band. Confirm `verifyConnectorToken` is satisfied with a probe (the `/c/<token>/mcp` initialize handshake returns a session id).

- [ ] **Step 4: Record the token owner mapping** in `qsc-infra` (not the raw token) so rotation is possible.

### Task 11: Deploy + verify the readonly office connector end-to-end

- [ ] **Step 1: Reconcile branches** — the `feat/front-office-st-coverage` branch already carries the connector code (it is on `main`). Confirm `lab-fields-v170`'s uncommitted `auth.ts`/`env.ts` are not required for the connector (they are pricebook lab-fields, unrelated). If any connector fix lives only on `lab-fields-v170`, cherry-pick it; otherwise proceed from this branch.

- [ ] **Step 2: Open a PR `feat/front-office-st-coverage` → `main`** (direct main push is classifier-gated). CI runs the suite.

- [ ] **Step 3: After merge, CI auto-deploys mcp-servicetitan from `main`.** Verify the live tool count rose by 5 and the `readonly` set excludes writes:
```bash
curl -s https://mcp-servicetitan.lpeluso.workers.dev/health | grep -o '"toolCount":[0-9]*'
```
Expected: default tool count increased by 5 (4 list/composite + query_operations).

- [ ] **Step 4: Office-path smoke test** — run the 3-step Streamable-HTTP MCP probe (from the mcp-servicetitan SKILL) against `/c/<token>/mcp`, then `tools/call` `list_jobs` with a real `technicianId`. Expected: rows returned; `audit_log` shows the call under actor `front-office`; NO write tool is listed in `tools/list`.

- [ ] **Step 5: Adoption tag check** — confirm `audit_log` (qsc-mcp-st) rows carry the `front-office` actor so usage is measurable. Document the "what you can ask" one-pager for the office (the four named tools + query_operations examples).

- [ ] **Step 6: Acceptance note + catalog update**

Write `docs/audit/front-office-coverage-acceptance-2026-06-25.md` (tool list, test count, deploy version, smoke-test evidence). Update `qsc-infra/.claude/rules/protected-modules.md` mcp-servicetitan row (new tools + connector now deployed) and `SECURITY` note for the `query_operations` gate.

```bash
git add docs/audit/front-office-coverage-acceptance-2026-06-25.md
git commit -m "docs: front-office coverage acceptance + catalog update"
```

---

## SELF-REVIEW

**Spec coverage:**
- Goal 1 (list/cross-record) → Task 1 `list_jobs`, Task 8 `query_operations`. ✓
- Goal 2 (full context one shot) → Task 2 `job_360`. ✓
- Goal 3 (general lookups: jobs/times/pricebook/materials/invoice/notes/location/history) → `job_360` (times/materials/invoice/notes), `list_jobs`, `search_notes`, existing `search_pricebook_*`/`list_customer_jobs`, `query_operations` for the rest. ✓
- Goal 4 (long tail) → Task 8 `query_operations`. ✓
- Phase-1 tools committed → Tasks 1–5. ✓ (spec's 6 → 4 net-new; deltas documented above, two already exist.)
- Phase-2 guarded query → Tasks 7–9, AST allow-list / fail-closed / single-statement / row cap / PII denylist. ✓
- Indexes → Task 6. ✓
- Read-only connector deploy → Tasks 10–11. ✓
- Adoption measurement → Task 11 Step 5. ✓
- Security review of the gate → Tasks 7–9 tests + Task 11 acceptance. ✓

**Placeholder scan:** No "TBD"/"similar to"/"add error handling" — every code step has full code; the two intentional runtime lookups (`NNNN` migration number in Task 6; the coverage-exemption file path in Task 9) include the exact command to resolve them. ✓

**Type consistency:** All tools use `ToolDef<Args>`, `readD1<T>(env, sql, params) => {rows}`, `McpError(code, msg, {correlation})`, `defaultShaper`. Gate exports (`gateOperationsSql`, `clampLimit`, `OPERATIONAL_TABLES`, `DEFAULT_GATE_CONFIG`) are used consistently in Task 8. ✓

## OPEN QUESTIONS (carry to execution)

1. **Office token model** — one shared `front-office` token vs per-user tokens (per-user = better audit granularity + revocability; shared = less to hand out). Default: one shared token now, split later if audit needs it.
2. **Connector surface** — confirm whether the office connects via Claude Desktop (`/c/<token>/mcp`) or the claude.ai TAI-ST connector; the tools land in both, but the token/deploy step targets the Desktop route.
3. **`whiteListCheck` tuple format** — verify against the installed `node-sql-parser` version that SQLite emits `select::null::<table>`; the Task 7 test is the contract and the authority regex already allows the `null` db segment.
