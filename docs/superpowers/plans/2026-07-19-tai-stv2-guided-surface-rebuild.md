# TAI-STV2 Guided-Surface Rebuild + Per-Role Scoping — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the TAI-STV2 connector's guided surface around QSC's real back-office workflows — 5 reworked MCP prompts, 2 new tools (`gold_margin_by_bu`, `tech_scorecard`), 3 reworked resources — and scope the exposed surface per Entra-group persona.

**Architecture:** All work is server-side in the `mcp-servicetitan` Worker plus one aggregation RPC in `qsc-vector`. Analytical margin sources from the Supabase `gold` warehouse via a new Postgres RPC; the tech scorecard sources from D1 (no gold labor grain exists). Per-role scoping adds a `persona` dimension to the request context, resolved from the OAuth'd Entra email, that narrows the tool/prompt/resource surface `buildServer()` registers — additive to (never wider than) the existing `Role` filter.

**Tech Stack:** TypeScript, Cloudflare Workers, `@modelcontextprotocol/sdk`, Zod, Vitest; Supabase PostgREST (gold schema) + Cloudflare D1; Postgres (qsc-vector migrations).

## Global Constraints

- **Design source of truth:** `docs/superpowers/specs/2026-07-19-tai-stv2-guided-surface-rebuild-design.md`.
- **Data-source rule:** gold where the grain exists, D1/live-ST where it doesn't. `gold_margin_by_bu` = gold only (item/material margin, NO labor); `tech_scorecard` + `drive-time` + `daily-review` = D1/live-ST.
- **Dynamic-pricing honesty:** never emit a `0`/`null` reference price as "unpriced" (reuse `shapePriceRow` / `price_basis`).
- **Persona narrows, never widens:** a persona filter is intersected with `toolsForRole(role)`; it can only remove surface, never add a write or admin tool. Unknown email → `env.DEFAULT_PERSONA` (default `'all'`) so the feature ships as a no-op until persona rows exist — the existing Jessica read-only connector must not change.
- **Gold column facts (verbatim, qsc-vector `migrations/0003_gold_tables.sql`):** revenue = `fct_job.job_total_cents`; per-line cost = `fct_invoice_line.total_cost_cents`; join `fct_job.invoice_id = fct_invoice_line.invoice_id`; BU key = `fct_job.business_unit_id`; job window column = `fct_job.completed_date` (text `YYYY-MM-DD`).
- **Supabase gold reads** need `Accept-Profile: gold` (read-side analogue of the `Content-Profile` header `sbRpc` already sets); RPC calls need `Content-Profile: gold` via `sbRpc(env, fn, body, 'gold')`.
- **Commit frequently**, one commit per completed task. Do not push or open PRs unless Luke asks. Branch off `main` before the first commit: `git checkout -b feat/tai-stv2-guided-surface`.

---

### Task 1: `gold.margin_by_bu` RPC (qsc-vector)

Cross-repo: this task is authored and applied in **`/home/taylor/work/qsc-vector`**, not `mcp-servicetitan`. It is a hard dependency of Task 3.

**Files:**
- Create: `/home/taylor/work/qsc-vector/migrations/0012_margin_by_bu_rpc.sql` (0011 is taken by an in-flight `0011_refresh_state.sql` on the current branch — de-conflicted to 0012)

> **Live-apply status (2026-07-19):** the Supabase MCP is currently deauthenticated, so the migration file is committed but **not yet applied/verified live** — that step is deferred to Luke (re-auth Supabase, apply, run the Step-3 verify). No downstream code task needs the live RPC (Task 3's tests mock `sbRpc`).

**Interfaces:**
- Produces: Postgres function `gold.margin_by_bu(p_from text, p_to text, p_bu_id bigint)` returning rows `(business_unit_id bigint, revenue_cents bigint, cost_cents bigint, gp_cents bigint, gp_pct numeric, job_count bigint)`. `p_bu_id` NULL = all BUs. Exposed on the `gold` PostgREST schema (already in `pgrst.db_schemas = 'public, gold, vec'`).

- [ ] **Step 1: Write the migration**

Create `/home/taylor/work/qsc-vector/migrations/0012_margin_by_bu_rpc.sql`:

```sql
-- 0012_margin_by_bu_rpc.sql
-- gold.margin_by_bu — item/material margin by business unit over a completed-date window.
-- Revenue = sum(fct_job.job_total_cents). Cost = sum of the job's invoice-line total_cost_cents
-- (joined fct_job.invoice_id = fct_invoice_line.invoice_id). This is ITEM/MATERIAL margin only:
-- it does NOT include labor burden (gold has no timesheet grain). p_bu_id NULL = all BUs.

create or replace function gold.margin_by_bu(p_from text, p_to text, p_bu_id bigint default null)
returns table (
  business_unit_id bigint,
  revenue_cents    bigint,
  cost_cents       bigint,
  gp_cents         bigint,
  gp_pct           numeric,
  job_count        bigint
)
language sql
stable
as $$
  with job_cost as (
    select j.job_id,
           j.business_unit_id,
           j.job_total_cents,
           coalesce(sum(il.total_cost_cents), 0) as job_cost_cents
    from gold.fct_job j
    left join gold.fct_invoice_line il on il.invoice_id = j.invoice_id
    where j.completed_date >= p_from
      and j.completed_date <= p_to
      and (p_bu_id is null or j.business_unit_id = p_bu_id)
    group by j.job_id, j.business_unit_id, j.job_total_cents
  )
  select business_unit_id,
         sum(job_total_cents)                                        as revenue_cents,
         sum(job_cost_cents)                                         as cost_cents,
         sum(job_total_cents) - sum(job_cost_cents)                  as gp_cents,
         case when sum(job_total_cents) > 0
              then round((sum(job_total_cents) - sum(job_cost_cents))::numeric
                         / sum(job_total_cents) * 100, 1)
              else null end                                          as gp_pct,
         count(*)                                                    as job_count
  from job_cost
  group by business_unit_id
  order by revenue_cents desc;
$$;

grant execute on function gold.margin_by_bu(text, text, bigint) to authenticator;
```

- [ ] **Step 2: Apply the migration to the dev/prod Supabase project**

Apply via the project's established migration path (Supabase MCP `apply_migration`, or the repo's migration runner). Project ref: `nlaaliehqpgskjmiuzze`.
Expected: migration applies with no error; function `gold.margin_by_bu` exists.

- [ ] **Step 3: Verify the RPC live**

Call the RPC over PostgREST with the `gold` profile and a known window (adjust dates to a period with completed jobs):

```bash
curl -s -X POST "$SUPABASE_URL/rest/v1/rpc/margin_by_bu" \
  -H "apikey: $SUPABASE_PB_KEY" -H "Authorization: Bearer $SUPABASE_PB_KEY" \
  -H "Content-Type: application/json" -H "Content-Profile: gold" \
  -d '{"p_from":"2026-06-01","p_to":"2026-06-30","p_bu_id":null}'
```

Expected: a JSON array of rows with `business_unit_id, revenue_cents, cost_cents, gp_cents, gp_pct, job_count`. Confirm `gp_cents = revenue_cents - cost_cents` on at least one row.

- [ ] **Step 4: Commit (in qsc-vector)**

```bash
cd /home/taylor/work/qsc-vector
git checkout -b feat/margin-by-bu-rpc
git add migrations/0012_margin_by_bu_rpc.sql
git commit -m "feat(gold): add margin_by_bu RPC for TAI-STV2 job-cost-margin prompt"
```

---

### Task 2: `sbSelect`/`sbRpc` gold-schema read support

**Files:**
- Modify: `src/supabase.ts`
- Test: `src/supabase.test.ts`

**Interfaces:**
- Consumes: existing `headers(env)`, `SUPABASE_FETCH_TIMEOUT_MS`.
- Produces: `sbSelect<T>(env, pathAndQuery, schema?)` — when `schema` is provided, adds header `Accept-Profile: <schema>` so a `GET /rest/v1/<table>` resolves against a non-public exposed schema. Existing 2-arg callers unchanged. (`sbRpc` already supports its 4th `schema` arg via `Content-Profile`.)

- [ ] **Step 1: Write the failing test**

Add to `src/supabase.test.ts`:

```ts
it('sbSelect sends Accept-Profile when a schema is given', async () => {
  const seen: Record<string, string> = {};
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    for (const [k, v] of Object.entries(init.headers as Record<string, string>)) seen[k.toLowerCase()] = v;
    return new Response(JSON.stringify([{ id: 1 }]), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  const env = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_PB_KEY: 'k' } as any;
  await sbSelect(env, 'dim_business_unit?select=*', 'gold');
  expect(seen['accept-profile']).toBe('gold');
});

it('sbSelect omits Accept-Profile when no schema is given (public)', async () => {
  const seen: Record<string, string> = {};
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    for (const [k, v] of Object.entries(init.headers as Record<string, string>)) seen[k.toLowerCase()] = v;
    return new Response(JSON.stringify([]), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  const env = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_PB_KEY: 'k' } as any;
  await sbSelect(env, 'pricebook_items?select=code');
  expect(seen['accept-profile']).toBeUndefined();
});
```

Ensure the test file imports `sbSelect` and `vi` (`import { sbSelect } from './supabase'; import { describe, it, expect, vi } from 'vitest';`).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/supabase.test.ts -t "Accept-Profile"`
Expected: FAIL (current `sbSelect` takes 2 args, sends no `Accept-Profile`).

- [ ] **Step 3: Implement**

In `src/supabase.ts`, replace the existing `sbSelect` with:

```ts
export async function sbSelect<T>(env: Env, pathAndQuery: string, schema?: string): Promise<T> {
  const h = headers(env);
  if (schema) h['Accept-Profile'] = schema;
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
    headers: h, signal: AbortSignal.timeout(SUPABASE_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => String(res.status));
    throw new Error(`supabase select failed ${res.status}: ${t}`);
  }
  return res.json() as Promise<T>;
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run src/supabase.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/supabase.ts src/supabase.test.ts
git commit -m "feat(supabase): sbSelect Accept-Profile for gold-schema reads"
```

---

### Task 3: `gold_margin_by_bu` tool

**Files:**
- Create: `src/tools/gold/gold_margin_by_bu.ts`
- Test: `src/tools/gold/__tests__/gold_margin_by_bu.test.ts`

**Interfaces:**
- Consumes: `sbRpc` (Task 2 file), `ToolDef`, `defaultShaper`.
- Produces: `export const gold_margin_by_bu: ToolDef<Args>` where `Args = { from: string; to: string; businessUnitId?: number }`. Handler returns `{ window, rows: Array<{ business_unit_id, revenue_$, cost_$, gp_$, gp_pct, job_count }>, _source: 'gold', _margin_basis: 'item/material only — excludes labor burden' }`.

- [ ] **Step 1: Write the failing test**

Create `src/tools/gold/__tests__/gold_margin_by_bu.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { gold_margin_by_bu } from '../gold_margin_by_bu';
import * as supa from '../../../supabase';

const ctx = { actor: 'test', correlation: 'c1' } as any;

describe('gold_margin_by_bu', () => {
  it('calls the gold.margin_by_bu RPC with the gold profile and maps cents→dollars', async () => {
    const spy = vi.spyOn(supa, 'sbRpc').mockResolvedValue([
      { business_unit_id: 10, revenue_cents: 100000, cost_cents: 40000, gp_cents: 60000, gp_pct: 60.0, job_count: 5 },
    ] as any);
    const out: any = await gold_margin_by_bu.handler({} as any, { from: '2026-06-01', to: '2026-06-30' }, ctx);
    expect(spy).toHaveBeenCalledWith(expect.anything(), 'margin_by_bu',
      { p_from: '2026-06-01', p_to: '2026-06-30', p_bu_id: null }, 'gold');
    expect(out.rows[0]).toMatchObject({ business_unit_id: 10, revenue_$: 1000, cost_$: 400, gp_$: 600, gp_pct: 60.0, job_count: 5 });
    expect(out._source).toBe('gold');
    expect(out._margin_basis).toMatch(/labor/i);
  });

  it('passes businessUnitId through as p_bu_id', async () => {
    const spy = vi.spyOn(supa, 'sbRpc').mockResolvedValue([] as any);
    await gold_margin_by_bu.handler({} as any, { from: '2026-06-01', to: '2026-06-30', businessUnitId: 42 }, ctx);
    expect(spy).toHaveBeenCalledWith(expect.anything(), 'margin_by_bu',
      { p_from: '2026-06-01', p_to: '2026-06-30', p_bu_id: 42 }, 'gold');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tools/gold/__tests__/gold_margin_by_bu.test.ts`
Expected: FAIL ("Cannot find module '../gold_margin_by_bu'").

- [ ] **Step 3: Implement the tool**

Create `src/tools/gold/gold_margin_by_bu.ts`:

```ts
// ============================================================
// gold_margin_by_bu — item/material margin by business unit over a window,
// sourced from the Supabase gold warehouse via the gold.margin_by_bu RPC
// (qsc-vector migration 0011). This is ITEM/MATERIAL margin only — it does
// NOT include labor burden, because gold has no timesheet grain. For a
// single job's labor-inclusive burden use job_cost_actuals (D1).
// ============================================================
import { z } from 'zod';
import { defaultShaper } from '../../response-shape';
import { sbRpc } from '../../supabase';
import type { ToolDef } from '../index';

interface Args {
  from: string;
  to: string;
  businessUnitId?: number;
}

interface RpcRow {
  business_unit_id: number;
  revenue_cents: number;
  cost_cents: number;
  gp_cents: number;
  gp_pct: number | null;
  job_count: number;
}

const cents = (v: number | null | undefined) => Number(((v ?? 0) / 100).toFixed(2));

export const gold_margin_by_bu: ToolDef<Args> = {
  name: 'gold_margin_by_bu',
  description:
    'Item/material margin by business unit over a completed-date window, from the Woz gold warehouse. ' +
    'Returns revenue, cost, GP$ and GP% per BU. IMPORTANT: this is item/material margin only — it does NOT ' +
    'include labor burden (gold has no timesheet grain). For one job with labor burden, use job_cost_actuals. ' +
    'Source: Supabase gold.margin_by_bu RPC.',
  stEndpoint: { method: 'GET', path: 'supabase://gold/margin_by_bu', source: 'computed' },
  zodSchema: {
    from: z.string().describe("Window start, ISO 'YYYY-MM-DD' (fct_job.completed_date >= from)."),
    to: z.string().describe("Window end, ISO 'YYYY-MM-DD' (fct_job.completed_date <= to)."),
    businessUnitId: z.coerce.number().int().positive().optional()
      .describe('Restrict to one ST business unit ID (optional; omitted = all BUs).'),
  },
  async handler(env, args) {
    const rows = await sbRpc<RpcRow[]>(env, 'margin_by_bu', {
      p_from: args.from,
      p_to: args.to,
      p_bu_id: args.businessUnitId ?? null,
    }, 'gold');
    return {
      window: { from: args.from, to: args.to },
      rows: rows.map((r) => ({
        business_unit_id: r.business_unit_id,
        revenue_$: cents(r.revenue_cents),
        cost_$: cents(r.cost_cents),
        gp_$: cents(r.gp_cents),
        gp_pct: r.gp_pct,
        job_count: r.job_count,
      })),
      count: rows.length,
      _source: 'gold',
      _margin_basis: 'item/material only — excludes labor burden (no gold timesheet grain)',
    };
  },
  transformResult: defaultShaper,
};
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run src/tools/gold/__tests__/gold_margin_by_bu.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/gold/gold_margin_by_bu.ts src/tools/gold/__tests__/gold_margin_by_bu.test.ts
git commit -m "feat(tools): add gold_margin_by_bu (gold-sourced BU margin)"
```

---

### Task 4: `tech_scorecard` tool

**Files:**
- Create: `src/tools/composites/tech_scorecard.ts`
- Test: `src/tools/composites/__tests__/tech_scorecard.test.ts`

**Interfaces:**
- Consumes: `readD1` (`../../d1`), `ToolDef`, `defaultShaper`. Reads D1 `job_timesheets` (`technician_id, job_id, arrived_on, drive_minutes, working_minutes, active`) and `technicians` (`technician_id, name, business_unit`).
- Produces: `export const tech_scorecard: ToolDef<Args>` where `Args = { technicianId?: number; weekStart: string; weekEnd: string; burdenRate?: number }`. Handler returns `{ window, techs: Array<{ technician_id, name, business_unit, jobs, drive_minutes, working_minutes, drive_pct, labor_burden_$ }>, _source: 'd1' }`.

Scope note: v1 sources jobs + drive/work + labor burden from `job_timesheets` (the grain that exists). Dispatch-pro utilization/ratio and assigned-vs-sold are exposed as their own tools already; the prompt (Task 6) chains them alongside this scorecard rather than this tool re-joining every source — keeps this tool a single-source D1 rollup like `tech_drive_time_summary`.

- [ ] **Step 1: Write the failing test**

Create `src/tools/composites/__tests__/tech_scorecard.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { tech_scorecard } from '../tech_scorecard';
import * as d1 from '../../../d1';

const ctx = { actor: 'test', correlation: 'c1' } as any;

describe('tech_scorecard', () => {
  it('rolls up per-tech jobs, drive/work minutes and labor burden for the week (all techs)', async () => {
    vi.spyOn(d1, 'readD1').mockResolvedValue({
      rows: [
        { technician_id: 1, name: 'Alice', business_unit: 'HVAC', jobs: 8, drive_minutes: 240, working_minutes: 1800 },
        { technician_id: 2, name: 'Bob', business_unit: 'Plumb', jobs: 5, drive_minutes: 300, working_minutes: 900 },
      ],
    } as any);
    const out: any = await tech_scorecard.handler({} as any, { weekStart: '2026-07-06', weekEnd: '2026-07-12' }, ctx);
    expect(out.techs).toHaveLength(2);
    // Alice: 240 drive of 2040 total = 11.8% ; burden (2040/60)*45 = 1530
    expect(out.techs[0]).toMatchObject({ technician_id: 1, jobs: 8, drive_pct: 11.8, labor_burden_$: 1530 });
    expect(out._source).toBe('d1');
  });

  it('filters to one technician when technicianId is given', async () => {
    const spy = vi.spyOn(d1, 'readD1').mockResolvedValue({ rows: [] } as any);
    await tech_scorecard.handler({} as any, { technicianId: 7, weekStart: '2026-07-06', weekEnd: '2026-07-12' }, ctx);
    const sql = String(spy.mock.calls[0][1]);
    expect(sql).toMatch(/technician_id\s*=\s*\?/i);
    expect(spy.mock.calls[0][2]).toContain(7);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tools/composites/__tests__/tech_scorecard.test.ts`
Expected: FAIL ("Cannot find module '../tech_scorecard'").

- [ ] **Step 3: Implement the tool**

Create `src/tools/composites/tech_scorecard.ts`:

```ts
// ============================================================
// tech_scorecard — per-tech weekly rollup (one tech or all) from D1.
// jobs, drive/working minutes, drive%, labor burden. Pure SQL, no live ST.
// Source: D1 job_timesheets joined to technicians. Sourced from D1 (not gold)
// because gold has no timesheet/labor grain. Mirrors tech_drive_time_summary.
// ============================================================
import { z } from 'zod';
import { defaultShaper } from '../../response-shape';
import { readD1 } from '../../d1';
import type { ToolDef } from '../index';

interface Args {
  technicianId?: number;
  weekStart: string;
  weekEnd: string;
  burdenRate?: number;
}

interface Row {
  technician_id: number;
  name: string | null;
  business_unit: string | null;
  jobs: number;
  drive_minutes: number;
  working_minutes: number;
}

const DEFAULT_BURDEN_RATE = 45;

export const tech_scorecard: ToolDef<Args> = {
  name: 'tech_scorecard',
  description:
    'Weekly per-technician scorecard (one tech or all): jobs completed, drive/working minutes, drive%, and ' +
    'labor burden ($) over a week. Source: D1 job_timesheets + technicians (gold has no timesheet grain). ' +
    'For dispatch-pro utilization/ratio and assigned-vs-sold gaps, pair with dispatch_pro_utilization_list, ' +
    'dispatch_pro_ratio_list and assigned_vs_sold_estimate_audit.',
  stEndpoint: { method: 'GET', path: 'd1://job_timesheets+technicians', source: 'd1' },
  zodSchema: {
    technicianId: z.coerce.number().int().positive().optional()
      .describe('One ST technician ID (optional; omitted = all techs).'),
    weekStart: z.string().describe("Week start, ISO 'YYYY-MM-DD' (arrived_on >= weekStart)."),
    weekEnd: z.string().describe("Week end, ISO 'YYYY-MM-DD' (arrived_on <= weekEnd, inclusive)."),
    burdenRate: z.coerce.number().positive().optional()
      .describe(`Loaded labor cost per hour for the burden total (default $${DEFAULT_BURDEN_RATE}).`),
  },
  async handler(env, args) {
    const burdenRate = args.burdenRate ?? DEFAULT_BURDEN_RATE;
    const startTs = args.weekStart.length === 10 ? `${args.weekStart}T00:00:00` : args.weekStart;
    const endTs = args.weekEnd.length === 10 ? `${args.weekEnd}T23:59:59` : args.weekEnd;

    const where = ['ts.active = 1', 'ts.arrived_on IS NOT NULL', 'ts.arrived_on >= ?', 'ts.arrived_on <= ?'];
    const binds: unknown[] = [startTs, endTs];
    if (args.technicianId !== undefined) {
      where.push('ts.technician_id = ?');
      binds.push(args.technicianId);
    }

    const { rows } = await readD1<Row>(
      env,
      `SELECT ts.technician_id,
              t.name          AS name,
              t.business_unit AS business_unit,
              COUNT(DISTINCT ts.job_id)          AS jobs,
              COALESCE(SUM(ts.drive_minutes), 0)  AS drive_minutes,
              COALESCE(SUM(ts.working_minutes), 0) AS working_minutes
         FROM job_timesheets ts
         LEFT JOIN technicians t ON t.technician_id = ts.technician_id
        WHERE ${where.join(' AND ')}
        GROUP BY ts.technician_id, t.name, t.business_unit
        ORDER BY jobs DESC`,
      binds,
    );

    const techs = rows.map((r) => {
      const total = r.drive_minutes + r.working_minutes;
      return {
        technician_id: r.technician_id,
        name: r.name,
        business_unit: r.business_unit,
        jobs: r.jobs,
        drive_minutes: r.drive_minutes,
        working_minutes: r.working_minutes,
        drive_pct: total > 0 ? Number(((r.drive_minutes / total) * 100).toFixed(1)) : 0,
        labor_burden_$: Number(((total / 60) * burdenRate).toFixed(2)),
      };
    });

    return {
      window: { weekStart: args.weekStart, weekEnd: args.weekEnd },
      count: techs.length,
      techs,
      _composite: 'tech_scorecard',
      _source: 'd1',
    };
  },
  transformResult: defaultShaper,
};
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run src/tools/composites/__tests__/tech_scorecard.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/composites/tech_scorecard.ts src/tools/composites/__tests__/tech_scorecard.test.ts
git commit -m "feat(tools): add tech_scorecard (D1 weekly per-tech rollup)"
```

---

### Task 5: Register the two new tools

**Files:**
- Modify: `src/tools/index.ts`
- Test: `src/tools/__tests__/coverage_gate.test.ts` (only if it asserts a fixed tool count)

**Interfaces:**
- Consumes: `gold_margin_by_bu` (Task 3), `tech_scorecard` (Task 4).
- Produces: both tools present in `TOOLS`; both read-only (no `isWrite`, no `adminOnly`) so they appear for `readonly`/`lockdown` callers.

- [ ] **Step 1: Add imports and registry entries**

In `src/tools/index.ts`, add imports near the other composite/gold imports:

```ts
import { gold_margin_by_bu } from './gold/gold_margin_by_bu';
import { tech_scorecard } from './composites/tech_scorecard';
```

And append to the `TOOLS` array (near `semantic_search_gold` / the v1.5 composites):

```ts
  // TAI-STV2 rebuild — guided-surface backing tools
  gold_margin_by_bu, tech_scorecard,
```

- [ ] **Step 2: Run the schema + coverage gate tests**

Run: `npx vitest run src/tools/__tests__/schemas.test.ts src/tools/__tests__/coverage_gate.test.ts`
Expected: PASS. If `coverage_gate` asserts a hard tool count, bump the expected count by 2 in that test and re-run.

- [ ] **Step 3: Verify both tools are visible to a readonly caller**

Add to `src/tools/__tests__/readonly_connector.test.ts` (or the nearest tool-visibility test):

```ts
it('exposes gold_margin_by_bu and tech_scorecard to a readonly caller', () => {
  const names = toolsForRole('readonly').map((t) => t.name);
  expect(names).toContain('gold_margin_by_bu');
  expect(names).toContain('tech_scorecard');
});
```

Run: `npx vitest run src/tools/__tests__/readonly_connector.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/tools/index.ts src/tools/__tests__/
git commit -m "feat(tools): register gold_margin_by_bu + tech_scorecard"
```

---

### Task 6: Rewrite the 5 prompts

**Files:**
- Modify: `src/prompts/index.ts` (replace the `PROMPTS` array; keep the `completableOptional` / completion machinery and `registerPrompts` — see Task 9 for the persona filter)
- Test: `src/__tests__/prompts.test.ts`

**Interfaces:**
- Produces: `PROMPTS` = exactly these 5 names in order: `job-cost-margin`, `daily-review`, `pricebook-health`, `weekly-tech-review`, `drive-time`.

- [ ] **Step 1: Update the failing tests first**

In `src/__tests__/prompts.test.ts`, replace the "exactly 5 prompts" name list and the per-prompt orchestration assertions:

```ts
it('has exactly 5 prompts with the expected names', () => {
  expect(PROMPTS.length).toBe(5);
  expect(PROMPTS.map((p) => p.name)).toEqual([
    'job-cost-margin', 'daily-review', 'pricebook-health', 'weekly-tech-review', 'drive-time',
  ]);
});

it('job-cost-margin job mode names job_cost_actuals; BU mode names gold_margin_by_bu', () => {
  const p = PROMPTS.find((p) => p.name === 'job-cost-margin')!;
  expect(p.build({ jobId: 123 })[0].content.text).toContain('job_cost_actuals');
  const bu = p.build({ businessUnitId: 10, from: '2026-06-01', to: '2026-06-30' })[0].content.text;
  expect(bu).toContain('gold_margin_by_bu');
});

it('daily-review orchestrates list_jobs_today, get_capacity, dispatch_pro_alerts_list', () => {
  const t = PROMPTS.find((p) => p.name === 'daily-review')!.build({ date: '2026-07-09' })[0].content.text;
  expect(t).toContain('list_jobs_today');
  expect(t).toContain('get_capacity');
  expect(t).toContain('dispatch_pro_alerts_list');
  expect(t).toContain('2026-07-09');
});

it('pricebook-health orchestrates the four pricebook composites', () => {
  const t = PROMPTS.find((p) => p.name === 'pricebook-health')!.build({})[0].content.text;
  for (const tool of ['pricebook_health_check_services', 'pricebook_markup_drift', 'pricebook_cost_drift', 'pricebook_vendor_part_gaps'])
    expect(t).toContain(tool);
});

it('weekly-tech-review names tech_scorecard', () => {
  expect(PROMPTS.find((p) => p.name === 'weekly-tech-review')!.build({})[0].content.text).toContain('tech_scorecard');
});

it('drive-time names tech_drive_time_summary and includes the tech id', () => {
  const t = PROMPTS.find((p) => p.name === 'drive-time')!
    .build({ technicianId: 7, startDate: '2026-07-01', endDate: '2026-07-07' })[0].content.text;
  expect(t).toContain('tech_drive_time_summary');
  expect(t).toContain('7');
});
```

(Keep the generic "every prompt has non-empty description + build() returns messages" test — it still applies.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/__tests__/prompts.test.ts`
Expected: FAIL (old prompt names/orchestration).

- [ ] **Step 3: Replace the `PROMPTS` array**

In `src/prompts/index.ts`, replace the entire `export const PROMPTS: readonly PromptDef[] = [ ... ] as const;` block with the 5 prompts below. Keep the `userText` helper, `PromptDef` interface, and everything below `PROMPTS` (completions + `registerPrompts`) intact.

```ts
export const PROMPTS: readonly PromptDef[] = [
  // ── 1. job-cost-margin ──────────────────────────────────────────────────
  {
    name: 'job-cost-margin',
    title: 'Job / BU Margin',
    description:
      'Real margin for one job (labor-inclusive) or a business unit over a window (item/material margin from gold).',
    argsSchema: {
      jobId: z.coerce.number().optional().describe('Single job to margin-review (labor-inclusive).'),
      businessUnitId: z.coerce.number().optional().describe('Business unit ID for a windowed roll-up.'),
      from: z.string().optional().describe('Window start YYYY-MM-DD (BU mode).'),
      to: z.string().optional().describe('Window end YYYY-MM-DD (BU mode).'),
    },
    build(args: { jobId?: number; businessUnitId?: number; from?: string; to?: string }) {
      if (args.jobId !== undefined) {
        return userText(
          `Produce a labor-inclusive margin review for job ${args.jobId}. Call:\n` +
            `1. job_cost_actuals (jobId=${args.jobId}) — revenue, invoice, and computed labor burden ` +
            `(drive+work minutes × rate) plus material/equipment cost lines.\n\n` +
            `Report: revenue, total actual cost (labor + material), GP$ and GP% for job ${args.jobId}. ` +
            `Note if any cost line looks incomplete. If the TAI-QBO connector is also connected, you may layer ` +
            `in QBO-posted vendor/overhead cost for a fuller picture — otherwise report ST/D1 cost only.`,
        );
      }
      const from = args.from ?? '(start of month)';
      const to = args.to ?? '(today)';
      const buClause = args.businessUnitId !== undefined ? `businessUnitId=${args.businessUnitId}` : '(all business units)';
      return userText(
        `Produce an item/material margin roll-up for ${buClause} from ${from} to ${to}. Call:\n` +
          `1. gold_margin_by_bu (from=${from}, to=${to}${args.businessUnitId !== undefined ? `, businessUnitId=${args.businessUnitId}` : ''}) ` +
          `— gold-sourced revenue, cost, GP$ and GP% by business unit.\n\n` +
          `Report a table sorted by revenue descending: BU, revenue, cost, GP$, GP%. ` +
          `IMPORTANT: this margin is item/material only — it EXCLUDES labor burden (gold has no timesheet grain). ` +
          `Say so explicitly. For a single job's labor-inclusive margin, use the jobId form of this prompt instead.`,
      );
    },
  },

  // ── 2. daily-review ─────────────────────────────────────────────────────
  {
    name: 'daily-review',
    title: 'Daily Review',
    description: "Today's job load, capacity, holds, dispatch-pro alerts and a quick AR glance for the day.",
    argsSchema: { date: z.string().optional().describe('ISO date (default: "today").') },
    build(args: { date?: string }) {
      const date = args.date ?? 'today';
      return userText(
        `Produce a daily operations review for ${date}. Call in order:\n` +
          `1. list_jobs_today (date=${date}) — the day's job load.\n` +
          `2. get_capacity — capacity for the BUs with jobs on ${date}.\n` +
          `3. dispatch_pro_alerts_list — open Dispatch Pro alerts for ${date}.\n` +
          `4. jobs_hold_reasons_list — any jobs on hold and why.\n` +
          `5. list_unpaid_invoices — a brief top-balances glance (top 5 only).\n\n` +
          `Produce a scannable brief: jobs by BU, capacity gaps, open alerts (severity + affected job/tech), ` +
          `held jobs, and the 5 largest open balances. Read in under a minute before the day starts.`,
      );
    },
  },

  // ── 3. pricebook-health ─────────────────────────────────────────────────
  {
    name: 'pricebook-health',
    title: 'Pricebook Health',
    description: 'Pricebook margin-discipline sweep: health check + markup/cost drift + vendor part gaps.',
    argsSchema: { businessUnitId: z.coerce.number().optional().describe('Restrict to one BU (optional).') },
    build(args: { businessUnitId?: number }) {
      const bu = args.businessUnitId !== undefined ? ` (businessUnitId=${args.businessUnitId})` : '';
      return userText(
        `Run a pricebook health + margin-discipline sweep${bu}. Call:\n` +
          `1. pricebook_health_check_services — structural health of the services catalog.\n` +
          `2. pricebook_markup_drift — items whose markup has drifted from policy.\n` +
          `3. pricebook_cost_drift — items whose cost has drifted.\n` +
          `4. pricebook_vendor_part_gaps — items missing vendor part links.\n\n` +
          `Summarize the worst offenders by category. DYNAMIC PRICING: a 0/null reference price does NOT mean ` +
          `"unpriced" — QSC uses Pricebook Pro dynamic pricing, so never flag an item as unpriced from a 0 price ` +
          `field; report the price_basis instead.`,
      );
    },
  },

  // ── 4. weekly-tech-review ───────────────────────────────────────────────
  {
    name: 'weekly-tech-review',
    title: 'Weekly Tech Review',
    description: "A technician's week: jobs, drive%, labor burden, dispatch-pro utilization and assigned-vs-sold gap.",
    argsSchema: {
      technicianId: z.coerce.number().optional().describe('One tech (optional; omitted = all techs).'),
      weekStart: z.string().optional().describe('Week start YYYY-MM-DD.'),
      weekEnd: z.string().optional().describe('Week end YYYY-MM-DD.'),
    },
    build(args: { technicianId?: number; weekStart?: string; weekEnd?: string }) {
      const ws = args.weekStart ?? '(Monday of the target week)';
      const we = args.weekEnd ?? '(Sunday of the target week)';
      const techClause = args.technicianId !== undefined ? `technicianId=${args.technicianId}, ` : '';
      return userText(
        `Build a weekly technician review for ${ws}..${we}. Call:\n` +
          `1. tech_scorecard (${techClause}weekStart=${ws}, weekEnd=${we}) — jobs, drive%, labor burden per tech.\n` +
          `2. dispatch_pro_utilization_list and dispatch_pro_ratio_list — utilization + booked/available ratio.\n` +
          `3. assigned_vs_sold_estimate_audit — estimates assigned to the tech that never sold.\n\n` +
          `Produce a per-tech scorecard sorted by jobs descending: tech, jobs, drive%, labor burden, utilization, ` +
          `assigned-vs-sold gap. Flag high drive% (>25%) and large unsold-estimate gaps for a coaching conversation.`,
      );
    },
  },

  // ── 5. drive-time ───────────────────────────────────────────────────────
  {
    name: 'drive-time',
    title: 'Drive Time',
    description: 'Per-tech drive/working-time rollup + windshield cost over a date window.',
    argsSchema: {
      technicianId: z.coerce.number().describe('ST technician ID (required).'),
      startDate: z.string().describe('Window start YYYY-MM-DD.'),
      endDate: z.string().describe('Window end YYYY-MM-DD.'),
    },
    build(args: { technicianId: number; startDate: string; endDate: string }) {
      return userText(
        `Produce a drive-time rollup for technician ${args.technicianId} from ${args.startDate} to ${args.endDate}. Call:\n` +
          `1. tech_drive_time_summary (technicianId=${args.technicianId}, startDate=${args.startDate}, endDate=${args.endDate}).\n\n` +
          `Report the window totals: days worked, jobs/day, drive vs working minutes, drive%, avg first-call drive, ` +
          `and windshield cost. Call out days with unusually high drive%.`,
      );
    },
  },
] as const;
```

- [ ] **Step 4: Fix the completions block for the new arg names**

In `registerPrompts` (bottom of the file), the old completion branches referenced `ar-chase`/`quote-follow-up`/`membership-outreach`. Replace those three `if` branches with completions for the new enumerable args:

```ts
    if (p.name === 'weekly-tech-review' && argsSchema.technicianId) {
      // no static completion — technician list is large; leave free-form
    }
    if (p.name === 'job-cost-margin' && argsSchema.businessUnitId) {
      argsSchema.businessUnitId = completableOptional(
        z.coerce.number(),
        businessUnitIdCompletion(env),
        argsSchema.businessUnitId.description ?? '',
      );
    }
    if (p.name === 'pricebook-health' && argsSchema.businessUnitId) {
      argsSchema.businessUnitId = completableOptional(
        z.coerce.number(),
        businessUnitIdCompletion(env),
        argsSchema.businessUnitId.description ?? '',
      );
    }
```

(Remove the now-dead `WINDOW_OPTIONS`/`DAYS_BACK_OPTIONS` `staticCompletion` branches only if nothing else references them; leaving the exported constants unused is harmless but prefer deleting the two dead `if` branches.)

- [ ] **Step 5: Run the prompt tests (unit + protocol)**

Run: `npx vitest run src/__tests__/prompts.test.ts`
Expected: PASS. If the protocol-path test enumerates old prompt names, update those expectations too.

- [ ] **Step 6: Commit**

```bash
git add src/prompts/index.ts src/__tests__/prompts.test.ts
git commit -m "feat(prompts): rebuild the 5 guided workflows around real QSC ops"
```

---

### Task 7: Rework the 3 resources

**Files:**
- Modify: `src/resources/catalogs.ts`
- Test: `src/__tests__/catalog-resources.test.ts`

**Interfaces:**
- Consumes: `sbSelect` with the `gold` profile (Task 2), existing `readD1`, `mapTechnician`.
- Produces: `registerCatalogResources` registers exactly three resources — `technicians` (D1, unchanged), `pricebook-categories` (repointed to `gold.dim_pb_category`), `business-units` (new, `gold.dim_business_unit`). The `reports` resource is removed.

- [ ] **Step 1: Update the failing tests**

In `src/__tests__/catalog-resources.test.ts`, assert the new resource set and the gold source. Replace the reports-resource assertions with:

```ts
it('registers exactly technicians, pricebook-categories, business-units (no reports)', () => {
  const uris = registered.map((r) => r.uri); // however the test captures registered resources
  expect(uris).toContain('mcp-st://catalog/technicians');
  expect(uris).toContain('mcp-st://catalog/pricebook-categories');
  expect(uris).toContain('mcp-st://catalog/business-units');
  expect(uris).not.toContain('mcp-st://catalog/reports');
});

it('business-units reads gold.dim_business_unit via the gold profile', async () => {
  const spy = vi.spyOn(supa, 'sbSelect').mockResolvedValue([
    { id: 10, name: 'HVAC Service', active: 1 },
  ] as any);
  const body = await readBusinessUnitsResource(); // invoke the registered handler
  expect(spy).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('dim_business_unit'), 'gold');
  expect(body.business_units[0]).toMatchObject({ id: 10, name: 'HVAC Service', active: 1 });
});
```

Match the existing test's harness for capturing registered resources / invoking handlers (mirror how the current reports test drives `registerCatalogResources`).

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/__tests__/catalog-resources.test.ts`
Expected: FAIL.

- [ ] **Step 3: Repoint pricebook-categories to gold, add business-units, drop reports**

In `src/resources/catalogs.ts`:

(a) Add the import: `import { sbSelect } from '../supabase';`

(b) Add a mapper next to `mapPbCategory`:

```ts
function mapBusinessUnit(row: Record<string, unknown>) {
  return { id: row.id ?? null, name: row.name ?? null, active: row.active ?? null };
}
```

(c) Replace the `pricebook-categories` handler body to read gold:

```ts
    async (uri) => {
      const rows = await sbSelect<Array<Record<string, unknown>>>(
        env,
        'dim_pb_category?select=id,name,parent_id,active,category_type&order=name',
        'gold',
      );
      const categories = rows.map(mapPbCategory);
      return jsonResourceContents(uri.href, { categories, count: categories.length });
    },
```

(d) Delete the entire `server.registerResource('reports', ...)` block and add:

```ts
  server.registerResource(
    'business-units',
    'mcp-st://catalog/business-units',
    {
      title: 'Business units',
      description: 'QSC ServiceTitan business units (id, name, active), from Woz gold dim_business_unit. Read-only reference.',
      mimeType: 'application/json',
    },
    async (uri) => {
      const rows = await sbSelect<Array<Record<string, unknown>>>(
        env,
        'dim_business_unit?select=id,name,active&order=name',
        'gold',
      );
      const business_units = rows.map(mapBusinessUnit);
      return jsonResourceContents(uri.href, { business_units, count: business_units.length });
    },
  );
```

(e) Remove the now-dead report-catalog helpers (`discoverReportCatalog`, `getReportCatalog`, the `REPORTS_*` constants, and the `ReportCatalog`/`ReportSummary`/`ReportCategoryCatalogEntry` interfaces) since nothing else references them. Confirm with `grep -rn "discoverReportCatalog\|getReportCatalog\|catalog/reports" src`.

(f) Update the file header comment to describe the new three-resource set.

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run src/__tests__/catalog-resources.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/resources/catalogs.ts src/__tests__/catalog-resources.test.ts
git commit -m "feat(resources): repoint pricebook-categories to gold, add business-units, drop reports"
```

---

### Task 8: Persona model + resolver

**Files:**
- Create: `src/personas.ts`
- Modify: `src/tool-registry.ts` (add `persona` to `RequestContext`)
- Test: `src/__tests__/personas.test.ts`

**Interfaces:**
- Produces:
  - `export type Persona = 'dispatch_csr' | 'sales' | 'accounting' | 'all';`
  - `export interface PersonaSurface { tools: ReadonlySet<string> | 'all'; prompts: ReadonlySet<string> | 'all'; resources: ReadonlySet<string> | 'all'; }`
  - `export const PERSONAS: Record<Persona, PersonaSurface>`
  - `export function personaAllows(surface, kind: 'tools'|'prompts'|'resources', name: string): boolean`
  - `export async function resolvePersona(env: Env, email: string | null): Promise<Persona>` — looks up `connector_personas(email → persona)` in D1; falls back to `env.DEFAULT_PERSONA` (default `'all'`); unknown value → `'all'`.
  - `RequestContext` gains `persona?: Persona`.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/personas.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { PERSONAS, personaAllows, resolvePersona } from '../personas';

describe('PERSONAS surface map', () => {
  it("'all' allows everything", () => {
    expect(personaAllows(PERSONAS.all, 'tools', 'anything_at_all')).toBe(true);
    expect(personaAllows(PERSONAS.all, 'prompts', 'job-cost-margin')).toBe(true);
  });
  it('dispatch_csr allows daily-review + drive-time prompts, not job-cost-margin', () => {
    expect(personaAllows(PERSONAS.dispatch_csr, 'prompts', 'daily-review')).toBe(true);
    expect(personaAllows(PERSONAS.dispatch_csr, 'prompts', 'drive-time')).toBe(true);
    expect(personaAllows(PERSONAS.dispatch_csr, 'prompts', 'job-cost-margin')).toBe(false);
  });
  it('accounting allows unpaid-invoice tools, not dispatch tools', () => {
    expect(personaAllows(PERSONAS.accounting, 'tools', 'list_unpaid_invoices')).toBe(true);
    expect(personaAllows(PERSONAS.accounting, 'tools', 'get_capacity')).toBe(false);
  });
});

describe('resolvePersona', () => {
  const mkEnv = (row: any, def?: string) => ({
    DEFAULT_PERSONA: def,
    DB: { prepare: () => ({ bind: () => ({ first: async () => row }) }) },
  } as any);

  it('returns the D1-mapped persona for a known email', async () => {
    expect(await resolvePersona(mkEnv({ persona: 'sales' }), 'x@qsc.net')).toBe('sales');
  });
  it('falls back to DEFAULT_PERSONA when email is unmapped', async () => {
    expect(await resolvePersona(mkEnv(null, 'dispatch_csr'), 'y@qsc.net')).toBe('dispatch_csr');
  });
  it("defaults to 'all' when nothing is configured", async () => {
    expect(await resolvePersona(mkEnv(null), null)).toBe('all');
  });
  it("coerces an unknown persona value to 'all'", async () => {
    expect(await resolvePersona(mkEnv({ persona: 'bogus' }), 'z@qsc.net')).toBe('all');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/__tests__/personas.test.ts`
Expected: FAIL ("Cannot find module '../personas'").

- [ ] **Step 3: Implement `src/personas.ts`**

```ts
// ============================================================
// personas.ts — per-role connector surface scoping (TAI-STV2).
// A persona NARROWS the surface buildServer registers; it can never widen
// what the caller's Role already permits. Resolved from the OAuth'd Entra
// email via the connector_personas D1 table (email → persona). Unknown /
// unmapped email → env.DEFAULT_PERSONA (default 'all') so the feature is a
// no-op until persona rows are added — the existing readonly connector is
// unaffected.
// ============================================================
import type { Env } from './env';

export type Persona = 'dispatch_csr' | 'sales' | 'accounting' | 'all';

export interface PersonaSurface {
  tools: ReadonlySet<string> | 'all';
  prompts: ReadonlySet<string> | 'all';
  resources: ReadonlySet<string> | 'all';
}

const set = (...xs: string[]): ReadonlySet<string> => new Set(xs);

export const PERSONAS: Record<Persona, PersonaSurface> = {
  all: { tools: 'all', prompts: 'all', resources: 'all' },

  dispatch_csr: {
    tools: set(
      'list_jobs_today', 'get_job', 'get_job_appointments', 'get_capacity',
      'list_technicians_available', 'get_technician_shifts', 'st_get_capacity_slots',
      'find_technician_by_name', 'dispatch_pro_utilization_list', 'dispatch_pro_ratio_list',
      'dispatch_pro_alerts_list', 'tech_drive_time_summary', 'jobs_hold_reasons_list',
      'find_customer', 'get_customer', 'customer_snapshot', 'list_memberships_expiring',
      'list_memberships_active', 'get_customer_membership', 'membership_outreach_list',
      'identify_tech_by_phone',
    ),
    prompts: set('daily-review', 'drive-time'),
    resources: set('mcp-st://catalog/technicians', 'mcp-st://catalog/business-units'),
  },

  sales: {
    tools: set(
      'list_estimates_job', 'get_estimate', 'opportunities_list', 'opportunity_get',
      'open_opportunities_pulitzer_feed', 'assigned_vs_sold_estimate_audit', 'get_proposal_tiers',
      'customer_snapshot', 'find_customer', 'get_customer', 'list_customer_jobs',
      'search_pricebook_all', 'search_pricebook_semantic', 'get_service_details',
    ),
    prompts: set(), // no dedicated sales prompt in the initial 5; scoped tools only
    resources: set('mcp-st://catalog/pricebook-categories', 'mcp-st://catalog/business-units'),
  },

  accounting: {
    tools: set(
      'list_unpaid_invoices', 'get_invoice', 'get_invoice_balance', 'list_invoices_job',
      'find_customer', 'get_customer', 'get_customer_locations', 'list_customer_jobs',
    ),
    prompts: set(), // AR is tool-driven; no dedicated prompt yet
    resources: set('mcp-st://catalog/business-units'),
  },
};

export function personaAllows(
  surface: PersonaSurface,
  kind: 'tools' | 'prompts' | 'resources',
  name: string,
): boolean {
  const s = surface[kind];
  return s === 'all' || s.has(name);
}

const VALID: readonly Persona[] = ['dispatch_csr', 'sales', 'accounting', 'all'];

export async function resolvePersona(env: Env, email: string | null): Promise<Persona> {
  const fallback: Persona = (VALID as readonly string[]).includes(env.DEFAULT_PERSONA ?? '')
    ? (env.DEFAULT_PERSONA as Persona)
    : 'all';
  if (!email) return fallback;
  try {
    const row = await env.DB.prepare('SELECT persona FROM connector_personas WHERE email = ?')
      .bind(email.toLowerCase())
      .first<{ persona: string }>();
    if (!row) return fallback;
    return (VALID as readonly string[]).includes(row.persona) ? (row.persona as Persona) : 'all';
  } catch {
    return fallback; // table missing / D1 error → fall back (never throw out of surface build)
  }
}
```

- [ ] **Step 4: Add `persona` to `RequestContext` and `DEFAULT_PERSONA` to `Env`**

In `src/tool-registry.ts`, extend the interface:

```ts
export interface RequestContext {
  actor: string;
  role: 'default' | 'admin' | 'lockdown' | 'readonly';
  persona?: import('./personas').Persona;
}
```

In `src/env.ts`, add `DEFAULT_PERSONA?: string;` to the `Env` interface (and document it as an optional wrangler var).

- [ ] **Step 5: Run tests to verify pass**

Run: `npx vitest run src/__tests__/personas.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/personas.ts src/tool-registry.ts src/env.ts src/__tests__/personas.test.ts
git commit -m "feat(auth): add persona model + resolver for per-role connector scoping"
```

---

### Task 9: Wire the persona filter into `buildServer`, prompts, resources, and the OAuth path

**Files:**
- Modify: `src/index.ts` (buildServer applies persona; OAuth path resolves persona from email)
- Modify: `src/prompts/index.ts` (`registerPrompts` takes a persona filter)
- Modify: `src/resources/catalogs.ts` (`registerCatalogResources` takes a persona filter)
- Test: `src/__tests__/persona-surface.test.ts` (new, protocol-path)

**Interfaces:**
- Consumes: `PERSONAS`, `personaAllows`, `resolvePersona` (Task 8).
- Produces: `buildServer` registers only the intersection of `toolsForRole(role)` and the persona's tool set; `registerPrompts(server, env, surface)` and `registerCatalogResources(server, env, surface)` register only persona-allowed prompts/resources. Persona defaults to `'all'` when `reqCtx.persona` is undefined (all non-OAuth paths), preserving current behavior.

- [ ] **Step 1: Write the failing protocol test**

Create `src/__tests__/persona-surface.test.ts` (mirror the InMemoryTransport + SDK Client pattern from `src/__tests__/prompts.test.ts` / `mcp-protocol.test.ts`):

```ts
import { describe, it, expect } from 'vitest';
import { buildServer } from '../index';
import { PERSONAS } from '../personas';
// ...set up InMemoryTransport + Client as the existing protocol tests do...

it('dispatch_csr persona exposes only its prompts', async () => {
  const server = buildServer(mockEnv, mockExecCtx, { actor: 'x@qsc.net', role: 'readonly', persona: 'dispatch_csr' });
  // connect a client, call prompts/list
  const names = (await client.listPrompts()).prompts.map((p) => p.name);
  expect(names.sort()).toEqual(['daily-review', 'drive-time']);
});

it("'all' persona (default) exposes all 5 prompts", async () => {
  const server = buildServer(mockEnv, mockExecCtx, { actor: 'x', role: 'readonly' }); // persona undefined → all
  const names = (await client.listPrompts()).prompts.map((p) => p.name);
  expect(names).toHaveLength(5);
});

it('accounting persona tools/list excludes get_capacity but includes list_unpaid_invoices', async () => {
  const server = buildServer(mockEnv, mockExecCtx, { actor: 'x', role: 'readonly', persona: 'accounting' });
  const names = (await client.listTools()).tools.map((t) => t.name);
  expect(names).toContain('list_unpaid_invoices');
  expect(names).not.toContain('get_capacity');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/__tests__/persona-surface.test.ts`
Expected: FAIL (persona filter not wired; all personas see everything).

- [ ] **Step 3: Thread the persona surface through `registerPrompts` and `registerCatalogResources`**

In `src/prompts/index.ts`, change the signature and gate registration:

```ts
import { PERSONAS, personaAllows, type Persona } from '../personas';

export function registerPrompts(server: McpServer, env: Env, persona: Persona = 'all'): void {
  const surface = PERSONAS[persona];
  for (const p of PROMPTS) {
    if (!personaAllows(surface, 'prompts', p.name)) continue;
    // ...existing per-prompt argsSchema + completion logic + server.registerPrompt(...) unchanged...
  }
}
```

In `src/resources/catalogs.ts`, change the signature and gate each `registerResource` by its URI:

```ts
import { PERSONAS, personaAllows, type Persona } from '../personas';

export function registerCatalogResources(server: McpServer, env: Env, persona: Persona = 'all'): void {
  const surface = PERSONAS[persona];
  const allow = (uri: string) => personaAllows(surface, 'resources', uri);
  if (allow('mcp-st://catalog/pricebook-categories')) server.registerResource('pricebook-categories', 'mcp-st://catalog/pricebook-categories', /* ...*/);
  if (allow('mcp-st://catalog/technicians'))          server.registerResource('technicians', 'mcp-st://catalog/technicians', /* ...*/);
  if (allow('mcp-st://catalog/business-units'))       server.registerResource('business-units', 'mcp-st://catalog/business-units', /* ...*/);
}
```

- [ ] **Step 4: Apply the persona tool filter in `buildServer`**

In `src/index.ts` `buildServer`, intersect the role-visible tools with the persona and pass the persona to prompts/resources:

```ts
export function buildServer(env: Env, execCtx: ExecutionContext, reqCtx: RequestContext): McpServer {
  const readonly = reqCtx.role === 'readonly';
  const server = new McpServer(/* ...unchanged... */);
  const persona = reqCtx.persona ?? 'all';
  const surface = PERSONAS[persona];
  const visible = toolsForRole(reqCtx.role).filter((t) => personaAllows(surface, 'tools', t.name));
  for (const tool of visible) registerTool(server, tool, env, execCtx, reqCtx);
  registerPrompts(server, env, persona);
  registerResultResource(server, env);
  registerCatalogResources(server, env, persona);
  return server;
}
```

Add the import: `import { PERSONAS, personaAllows } from './personas';`

- [ ] **Step 5: Resolve persona from the Entra email in the OAuth path**

In `src/index.ts`, the OAuth handler currently sets `reqCtx = { actor: props?.email ?? 'oauth', role: 'readonly' }`. Make it resolve the persona:

```ts
    const email = props?.email ?? null;
    const persona = await resolvePersona(runtimeEnv, email);
    const reqCtx: RequestContext = { actor: email ?? 'oauth', role: 'readonly', persona };
```

Add the import: `import { resolvePersona } from './personas';`. Leave the connector-token path (`/c/<token>/mcp`) and the X-Sync-Key path with `persona` undefined (→ `'all'`), preserving their current full surface.

- [ ] **Step 6: Run the whole suite**

Run: `npx vitest run`
Expected: PASS (all tests, including the new persona-surface protocol test).

- [ ] **Step 7: Add the `connector_personas` D1 table migration**

Create the migration in the repo's D1 migrations location (match the existing pattern — check `wrangler.toml` `[[d1_databases]]` + any `migrations/` dir):

```sql
-- connector_personas: maps an OAuth'd Entra email to a TAI-STV2 persona.
CREATE TABLE IF NOT EXISTS connector_personas (
  email   TEXT PRIMARY KEY,
  persona TEXT NOT NULL CHECK (persona IN ('dispatch_csr','sales','accounting','all')),
  note    TEXT,
  created_at INTEGER
);
```

(If this repo has no D1 migrations dir, document the `CREATE TABLE` in the deploy notes instead — the resolver already fail-closes to `DEFAULT_PERSONA` when the table is absent.)

- [ ] **Step 8: Commit**

```bash
git add src/index.ts src/prompts/index.ts src/resources/catalogs.ts src/__tests__/persona-surface.test.ts migrations/
git commit -m "feat(connector): scope tools/prompts/resources by Entra-group persona"
```

---

### Task 10: Full verification + typecheck + deploy notes

**Files:**
- Modify: `CHANGELOG.md`
- Create: deploy notes appended to the plan or a short `docs/` note (Cloudflare Access + Entra groups are ops, not code).

- [ ] **Step 1: Typecheck + full test run**

Run: `npm run typecheck` (or `npx tsc --noEmit`) then `npx vitest run`
Expected: no type errors; all tests pass. Capture the final summary line as evidence.

- [ ] **Step 2: Lint**

Run: `npm run lint` (if configured)
Expected: clean, or fix warnings the changed files introduced.

- [ ] **Step 3: Update CHANGELOG**

Add an entry summarizing: 5 reworked prompts, `gold_margin_by_bu` + `tech_scorecard` tools, 3 reworked resources (gold-sourced pricebook-categories + business-units; reports dropped), per-persona connector scoping, `gold.margin_by_bu` RPC dependency (qsc-vector 0011), and the `connector_personas` table.

- [ ] **Step 4: Write the ops handoff (not code)**

Document the manual ops steps that live outside the repos:
1. Create Entra security groups `QSC-Dispatch-CSR`, `QSC-Sales`, `QSC-Accounting`, `QSC-All`.
2. Cloudflare Access policy(ies) gating the connector on those groups (mirror the TAI-QBO Access app).
3. Seed `connector_personas` rows (email → persona) for each staff member; set `DEFAULT_PERSONA` (recommend `all` during rollout, tighten later).
4. Apply qsc-vector migration 0011 to the Supabase project (Task 1).

- [ ] **Step 5: Commit**

```bash
git add CHANGELOG.md docs/
git commit -m "docs: changelog + ops handoff for TAI-STV2 guided-surface rebuild"
```

---

## Self-Review

**Spec coverage:**
- 5 prompts → Task 6. ✔
- `gold_margin_by_bu` (gold RPC) → Tasks 1–3. ✔
- `tech_scorecard` (D1) → Task 4. ✔
- 3 resources (gold pricebook-categories, business-units, drop reports, keep technicians) → Task 7. ✔
- `sbSelect` Accept-Profile → Task 2. ✔
- Per-role scoping via Entra-group persona (4 personas) → Tasks 8–9. ✔
- QBO layering = option a (noted in prompt text, no dependency) → Task 6 job-cost-margin. ✔
- Data-source rule + dynamic-pricing honesty → Global Constraints + Tasks 3/4/6. ✔
- Ops (Access + Entra groups) out of code → Task 10. ✔

**Placeholder scan:** No "TBD"/"handle edge cases"/"similar to". The one deliberate flex point — the exact D1-migrations location in Task 9 Step 7 and Task 10 Step 4's Access config — are genuine environment/ops facts the implementer confirms against `wrangler.toml`, not un-specified logic; the resolver fail-closes if the table is absent, so this can't silently break.

**Type consistency:** `Persona` type used identically in `personas.ts`, `tool-registry.ts`, `prompts/index.ts`, `catalogs.ts`, `index.ts`. `RequestContext.persona?: Persona`. Tool names in `PERSONAS` match `TOOLS` entries (verified against `src/tools/index.ts`). Prompt names in tests, `PROMPTS`, and `PERSONAS` all use the 5 kebab-case names. RPC arg names (`p_from/p_to/p_bu_id`) match between Task 1 SQL and Task 3 handler. Gold columns (`job_total_cents`, `total_cost_cents`, `invoice_id`, `business_unit_id`, `completed_date`) match the qsc-vector schema.
