# mcp-servicetitan v1.4 — Three-Track Improvement Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three independently-shippable improvements to the worker — (1) a centralized response-shaping module that strips ST noise from tool outputs, (2) an inventory + payroll tool pack (8 new read tools), and (3) a typed allowlist + per-event metric for the webhook ingest endpoint.

**Architecture:** Each track is additive and lives behind existing seams. Track 1 introduces an optional `transformResult` field on `ToolDef` and a `src/response-shape.ts` module — zero existing tools change semantics until they opt in. Track 2 follows the existing typed-read pattern (mirror of `find_customer`) under `src/tools/inventory/` and `src/tools/payroll/`. Track 3 adds an `ACCEPTED_EVENT_TYPES` allowlist to the existing `webhook-ingest.ts`, a per-event metric, and a D1 index migration.

**Tech Stack:** TypeScript, Cloudflare Workers, Zod schemas, vitest, D1, Hono. Existing patterns enforced: typed `ToolDef<Args>`, `env.ST_PROXY.fetch()` for live reads, audit/error/heartbeat wrapping via `tool-registry.registerTool()`.

**Branch + worktree:** Run this on a feature branch (`feat/v1.4-shape-inventory-webhooks`). Push after every commit per qsc-infra deploy discipline. Do NOT `wrangler deploy` until all three tracks are green and `bash scripts/preflight.sh` passes.

---

## Pre-flight

- [ ] **Step P.1: Confirm clean repo + branch**

```bash
cd /home/taylor/work/mcp-servicetitan
git status                       # expect: clean
git checkout main && git pull
git checkout -b feat/v1.4-shape-inventory-webhooks
```

- [ ] **Step P.2: Confirm baseline tests pass**

```bash
npm run check
```

Expected: typecheck clean + 316 tests passing.

- [ ] **Step P.3: Note current tool count**

```bash
curl -s https://mcp-servicetitan.lpeluso.workers.dev/health | jq '.tools | length'
```

Expected: `66`. Record this — Track 2 will move it to `74`.

---

## Track 1 — Response-shaping module (~1 day)

Adds a centralized shaper applied between handler return and audit/serialize. Tools opt in via an optional `transformResult` field. Zero impact on tools that don't set it. Default exclusion set strips ST pagination noise (`paginationToken`, `requestId`, `eTag`, `_links`, `_meta`).

**Self-rule baked in** (copy from Rowvyn): never abbreviate or strip `id`, `type`, `active`, `status` — these are semantic fields that callers branch on. The module hard-codes a `RESERVED_KEYS` set that abbreviation skips.

### Task 1.1 — Create response-shape module with tests

**Files:**
- Create: `src/response-shape.ts`
- Create: `src/__tests__/response-shape.test.ts`

- [ ] **Step 1: Write the failing test file**

```typescript
// src/__tests__/response-shape.test.ts
import { describe, it, expect } from 'vitest';
import {
  excludeFields,
  limitArrays,
  abbreviateKeys,
  defaultShaper,
  DEFAULT_EXCLUDED_FIELDS,
  RESERVED_KEYS,
} from '../response-shape';

describe('excludeFields', () => {
  it('strips default excluded fields recursively', () => {
    const input = {
      data: [{ id: 1, paginationToken: 'abc' }],
      requestId: 'req-1',
      _meta: { foo: 1 },
      keep: 'me',
    };
    expect(excludeFields(input)).toEqual({
      data: [{ id: 1 }],
      keep: 'me',
    });
  });

  it('respects custom field set', () => {
    const input = { a: 1, b: 2, c: 3 };
    expect(excludeFields(input, new Set(['b']))).toEqual({ a: 1, c: 3 });
  });

  it('passes through primitives and null', () => {
    expect(excludeFields(null)).toBe(null);
    expect(excludeFields(42)).toBe(42);
    expect(excludeFields('s')).toBe('s');
  });

  it('handles arrays of primitives', () => {
    expect(excludeFields([1, 2, 3])).toEqual([1, 2, 3]);
  });
});

describe('limitArrays', () => {
  it('caps a top-level array and adds a truncation marker', () => {
    const input = { items: [1, 2, 3, 4, 5], other: 'x' };
    expect(limitArrays(input, { items: 2 })).toEqual({
      items: [1, 2],
      items_truncated: { original_length: 5, returned: 2 },
      other: 'x',
    });
  });

  it('leaves arrays under the cap untouched', () => {
    const input = { items: [1, 2] };
    expect(limitArrays(input, { items: 5 })).toEqual({ items: [1, 2] });
  });

  it('ignores non-array values', () => {
    const input = { items: 'not-an-array' };
    expect(limitArrays(input, { items: 5 })).toEqual({ items: 'not-an-array' });
  });
});

describe('abbreviateKeys', () => {
  it('renames keys per map but never abbreviates reserved keys', () => {
    const input = { businessUnit: 'BU1', averageTicket: 100, id: 7, status: 'ok' };
    expect(abbreviateKeys(input, { businessUnit: 'bu', averageTicket: 'avgTicket', id: 'X', status: 'Y' }))
      .toEqual({ bu: 'BU1', avgTicket: 100, id: 7, status: 'ok' });
  });

  it('leaves keys without a mapping untouched', () => {
    const input = { foo: 1, bar: 2 };
    expect(abbreviateKeys(input, { foo: 'f' })).toEqual({ f: 1, bar: 2 });
  });
});

describe('defaultShaper', () => {
  it('strips DEFAULT_EXCLUDED_FIELDS by default', () => {
    expect(defaultShaper({ paginationToken: 'x', id: 1 })).toEqual({ id: 1 });
  });
});

describe('module constants', () => {
  it('DEFAULT_EXCLUDED_FIELDS includes ST pagination noise', () => {
    expect(DEFAULT_EXCLUDED_FIELDS.has('paginationToken')).toBe(true);
    expect(DEFAULT_EXCLUDED_FIELDS.has('requestId')).toBe(true);
    expect(DEFAULT_EXCLUDED_FIELDS.has('_meta')).toBe(true);
  });

  it('RESERVED_KEYS protects semantic fields', () => {
    expect(RESERVED_KEYS.has('id')).toBe(true);
    expect(RESERVED_KEYS.has('type')).toBe(true);
    expect(RESERVED_KEYS.has('active')).toBe(true);
    expect(RESERVED_KEYS.has('status')).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npx vitest run src/__tests__/response-shape.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the module**

```typescript
// src/response-shape.ts

// Fields stripped from any response that opts into the default shaper.
// These are ST-API noise that LLM callers never need.
// NOTE: never strip semantic fields like id/type/active/status — those
// drive caller branching. See RESERVED_KEYS.
export const DEFAULT_EXCLUDED_FIELDS: ReadonlySet<string> = new Set([
  'paginationToken',
  'requestId',
  'eTag',
  '_links',
  '_meta',
]);

// Keys that abbreviateKeys() refuses to rename, even if a caller asks.
export const RESERVED_KEYS: ReadonlySet<string> = new Set([
  'id',
  'type',
  'active',
  'status',
]);

export function excludeFields<T>(value: T, fields: ReadonlySet<string> = DEFAULT_EXCLUDED_FIELDS): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((v) => excludeFields(v, fields)) as unknown as T;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (fields.has(k)) continue;
    out[k] = excludeFields(v, fields);
  }
  return out as T;
}

export function limitArrays<T extends Record<string, unknown>>(
  value: T,
  limits: Record<string, number>,
): T {
  const out: Record<string, unknown> = { ...value };
  for (const [k, n] of Object.entries(limits)) {
    const v = out[k];
    if (Array.isArray(v) && v.length > n) {
      out[k] = v.slice(0, n);
      out[`${k}_truncated`] = { original_length: v.length, returned: n };
    }
  }
  return out as T;
}

export function abbreviateKeys<T extends Record<string, unknown>>(
  value: T,
  abbrev: Record<string, string>,
): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    const target = RESERVED_KEYS.has(k) ? k : (abbrev[k] ?? k);
    out[target] = v;
  }
  return out as T;
}

// Convenience: the most common shape a tool wants — strip ST noise, leave everything else.
export function defaultShaper<T>(value: T): T {
  return excludeFields(value);
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npx vitest run src/__tests__/response-shape.test.ts
```

Expected: PASS — 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/response-shape.ts src/__tests__/response-shape.test.ts
git commit -m "feat(response-shape): add module for stripping ST noise + capping arrays"
git push -u origin feat/v1.4-shape-inventory-webhooks
```

### Task 1.2 — Wire transformResult into ToolDef

**Files:**
- Modify: `src/tools/index.ts` (the `ToolDef` interface)
- Modify: `src/tool-registry.ts` (the registerTool result branch)

- [ ] **Step 1: Add `transformResult` field to ToolDef**

In `src/tools/index.ts`, find the `ToolDef` interface and add the optional field:

```typescript
export interface ToolDef<Args = unknown> {
  name: string;
  description: string;
  zodSchema: Record<string, z.ZodTypeAny>;
  handler: (env: Env, args: Args, ctx: ToolContext) => Promise<unknown>;
  /**
   * Optional response shaper applied AFTER handler returns and BEFORE
   * audit/serialize. Use it to strip ST noise (`paginationToken`, `_meta`),
   * cap big arrays, or abbreviate verbose keys. See src/response-shape.ts.
   */
  transformResult?: (result: unknown) => unknown;
  // ... keep all existing fields below this point untouched
}
```

- [ ] **Step 2: Apply transformResult in registerTool**

In `src/tool-registry.ts`, find the line that calls the handler:

```typescript
const result = await tool.handler(env, args, { actor: reqCtx.actor, correlation });
```

Replace it with:

```typescript
const rawResult = await tool.handler(env, args, { actor: reqCtx.actor, correlation });
const result = tool.transformResult ? tool.transformResult(rawResult) : rawResult;
```

Keep everything below (the `isPartial` check, audit calls, return statement) referencing `result` — no other changes.

- [ ] **Step 3: Add a test that transformResult runs in the wrap path**

Append to `src/tools/__tests__/tool-registry.test.ts` (or create it if it doesn't exist — mirror the style of `webhook-ingest.test.ts`):

```typescript
import { describe, it, expect, vi } from 'vitest';
import { registerTool } from '../../tool-registry';
import type { ToolDef } from '../index';

describe('registerTool — transformResult', () => {
  it('applies transformResult before serialize', async () => {
    const tool: ToolDef<{ q: string }> = {
      name: 'fixture_tool',
      description: 'fixture',
      zodSchema: {},
      async handler() {
        return { paginationToken: 'noise', id: 1, name: 'x' };
      },
      transformResult: (r: any) => {
        const { paginationToken, ...rest } = r;
        return rest;
      },
    };

    const captured: any[] = [];
    const server = {
      tool: (_n: string, _d: string, _s: any, fn: any) => {
        captured.push(fn);
      },
    } as any;
    const env = { DB: { prepare: vi.fn() }, MCP_METRICS: { writeDataPoint: vi.fn() } } as any;
    const execCtx = { waitUntil: () => undefined } as any;
    const reqCtx = { actor: 'test', role: 'default' } as const;

    registerTool(server, tool as any, env, execCtx, reqCtx);
    const wrapped = captured[0];
    const out = await wrapped({ q: 'hi' });
    const text = out.content[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.paginationToken).toBeUndefined();
    expect(parsed.id).toBe(1);
  });
});
```

- [ ] **Step 4: Run all tests**

```bash
npm run check
```

Expected: typecheck clean + 316 → 318+ tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/tools/index.ts src/tool-registry.ts src/tools/__tests__/tool-registry.test.ts
git commit -m "feat(tool-registry): wire optional transformResult into registerTool"
git push
```

### Task 1.3 — Adopt shaper on three smoke-test tools

Pick three tools with the highest payload weight (composites + a list tool). Apply `transformResult: (r) => excludeFields(r)`. Verify token reduction.

**Files (modify each):**
- `src/tools/composites/customer_snapshot.ts`
- `src/tools/composites/job_closeout_report.ts`
- `src/tools/st_list_customers.ts`

- [ ] **Step 1: Add shaper to customer_snapshot**

At the top of `src/tools/composites/customer_snapshot.ts`, add the import:

```typescript
import { excludeFields, limitArrays } from '../../response-shape';
```

At the bottom of the exported `customer_snapshot` ToolDef (after `async handler()`), add:

```typescript
  transformResult: (r) => limitArrays(excludeFields(r as Record<string, unknown>), {
    jobs: 25,
    invoices: 25,
    estimates: 25,
    locations: 10,
  }),
```

- [ ] **Step 2: Add shaper to job_closeout_report**

Same pattern — import + `transformResult` field. For job_closeout_report, only `excludeFields(r)` is needed (no big arrays at the top level).

- [ ] **Step 3: Add shaper to st_list_customers**

Same pattern — `excludeFields(r)` only.

- [ ] **Step 4: Run tests**

```bash
npm run check
```

Expected: PASS. The three tools' existing tests should still pass — shaper only strips ST noise that wasn't being asserted on.

- [ ] **Step 5: Smoke-test against deployed worker**

```bash
# After local typecheck + tests pass, deploy to dev:
npm run deploy:dev

# Then probe the dev worker (use your dev MCP_SYNC_KEY)
SESSION=$(curl -sD - --max-time 8 -X POST \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "X-Sync-Key: $MCP_SYNC_KEY_DEV" \
  -d '{"jsonrpc":"2.0","method":"initialize","id":1,"params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"0.1"}}}' \
  https://mcp-servicetitan-dev.lpeluso.workers.dev/mcp \
  | tr -d '\r' | grep -i 'mcp-session-id:' | awk '{print $2}')

curl -s -X POST \
  -H "mcp-session-id: $SESSION" \
  -H "Accept: application/json, text/event-stream" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  https://mcp-servicetitan-dev.lpeluso.workers.dev/mcp

# Use a known-active customerId in your tenant — replace 1234 below.
RESP=$(curl -s -X POST \
  -H "mcp-session-id: $SESSION" \
  -H "Accept: application/json, text/event-stream" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/call","id":2,"params":{"name":"customer_snapshot","arguments":{"customerId":1234}}}' \
  https://mcp-servicetitan-dev.lpeluso.workers.dev/mcp)

echo "$RESP" | wc -c
echo "$RESP" | jq '.result.content[0].text | fromjson | keys'
```

Expected: response no longer contains `paginationToken`, `requestId`, `_meta`. Byte count smaller than baseline.

- [ ] **Step 6: Commit**

```bash
git add src/tools/composites/customer_snapshot.ts \
        src/tools/composites/job_closeout_report.ts \
        src/tools/st_list_customers.ts
git commit -m "feat(tools): adopt response shaper on top-3 high-payload tools"
git push
```

**Track 1 done.** Independently shippable — open PR + merge, or continue to Track 2 first and bundle.

---

## Track 2 — Inventory + payroll tool pack (~2–3 days)

Adds 8 new typed read tools that close the surface gap competitors expose:

| Tool | ST endpoint | Returns |
|---|---|---|
| `inventory_purchase_orders_list` | `GET /inventory/v2/tenant/{tid}/purchase-orders` | id, number, status, total, vendor_id, business_unit_id, date |
| `inventory_purchase_order_get` | `GET /inventory/v2/tenant/{tid}/purchase-orders/{id}` | full PO + items |
| `inventory_vendors_list` | `GET /inventory/v2/tenant/{tid}/vendors` | id, name, active, contact |
| `inventory_warehouses_list` | `GET /inventory/v2/tenant/{tid}/warehouses` | id, name, address |
| `payroll_timesheets_list` | `GET /payroll/v2/tenant/{tid}/timesheets` | id, employee_id, hours, date |
| `payroll_gross_pay_items_list` | `GET /payroll/v2/tenant/{tid}/gross-pay-items` | id, employee_id, amount, payroll_id, type |
| `payroll_adjustments_list` | `GET /payroll/v2/tenant/{tid}/payroll-adjustments` | id, employee_id, amount, reason |
| `payroll_settings_get` | `GET /payroll/v2/tenant/{tid}/settings` | configuration object |

All tools opt into `transformResult: defaultShaper` (Track 1's module).

> **Verify endpoint paths against ST docs first.** ST's docs at `developer.servicetitan.io` change quarterly. Run the probe in Step 2.1 against one endpoint before writing all eight.

### Task 2.1 — Verify endpoints with a probe

- [ ] **Step 1: Probe inventory PO endpoint via the existing st_call admin tool**

```bash
# Replace SESSION with a fresh init session id, X-MCP-Role: admin
curl -s -X POST \
  -H "mcp-session-id: $SESSION" \
  -H "X-Sync-Key: $MCP_SYNC_KEY" \
  -H "X-MCP-Role: admin" \
  -H "Accept: application/json, text/event-stream" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/call","id":3,"params":{"name":"st_call","arguments":{"method":"GET","path":"/inventory/v2/tenant/431848990/purchase-orders?pageSize=1"}}}' \
  https://mcp-servicetitan.lpeluso.workers.dev/mcp \
  | jq '.result.content[0].text | fromjson | (.data | length), (.data[0] | keys)'
```

Expected: `1` row + key list. Confirms path. **If 404**, consult ST docs and adjust path before proceeding. Repeat for `vendors`, `warehouses`, `timesheets`, `gross-pay-items`, `payroll-adjustments`, `settings`.

- [ ] **Step 2: Record verified paths**

Note any deviations from the table above in this plan as a note before continuing.

### Task 2.2 — First inventory tool with full TDD

**Files:**
- Create: `src/tools/inventory/inventory_purchase_orders_list.ts`
- Create: `src/tools/__tests__/inventory_purchase_orders_list.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/tools/__tests__/inventory_purchase_orders_list.test.ts
import { describe, it, expect, vi } from 'vitest';
import { inventory_purchase_orders_list } from '../inventory/inventory_purchase_orders_list';

function fakeEnv() {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({
    data: [
      {
        id: 1, number: 'PO-001', status: 'Sent', total: 250,
        vendorId: 99, businessUnitId: 7, date: '2026-04-01',
        paginationToken: 'noise', // shaper should strip
      },
    ],
    hasMore: false,
  }), { status: 200 }));
  return {
    ST_TENANT_ID: '431848990',
    ST_PROXY: { fetch: fetcher },
    MCP_SYNC_KEY: 'k',
  } as any;
}

describe('inventory_purchase_orders_list', () => {
  it('returns slim records and forwards filters', async () => {
    const env = fakeEnv();
    const out = await inventory_purchase_orders_list.handler(env, { status: 'Sent', pageSize: 1 }, { actor: 'test', correlation: 'c1' }) as any;
    expect(out.count).toBe(1);
    expect(out.purchase_orders[0]).toEqual({
      id: 1, number: 'PO-001', status: 'Sent', total: 250,
      vendor_id: 99, business_unit_id: 7, date: '2026-04-01',
    });
    const calledUrl = (env.ST_PROXY.fetch as any).mock.calls[0][0];
    expect(calledUrl).toContain('purchase-orders');
    expect(calledUrl).toContain('status%3DSent');
    expect(out._source).toBe('live');
  });

  it('throws McpError on upstream failure', async () => {
    const env = {
      ST_TENANT_ID: '431848990',
      ST_PROXY: { fetch: vi.fn(async () => new Response('', { status: 502 })) },
      MCP_SYNC_KEY: 'k',
    } as any;
    await expect(
      inventory_purchase_orders_list.handler(env, {}, { actor: 'test', correlation: 'c1' }),
    ).rejects.toThrow(/inventory_purchase_orders_list failed: 502/);
  });
});
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
npx vitest run src/tools/__tests__/inventory_purchase_orders_list.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the tool**

```typescript
// src/tools/inventory/inventory_purchase_orders_list.ts
import { z } from 'zod';
import { McpError } from '../../errors';
import { authHeaders } from '../../auth';
import { defaultShaper } from '../../response-shape';
import type { ToolDef } from '../index';

interface Args {
  status?: 'Pending' | 'Sent' | 'Received' | 'Canceled';
  fromDate?: string;
  toDate?: string;
  page?: number;
  pageSize?: number;
}

interface RawPO {
  id: number;
  number?: string;
  status?: string;
  total?: number;
  vendorId?: number;
  businessUnitId?: number;
  date?: string;
}

interface SlimPO {
  id: number;
  number: string;
  status: string;
  total: number;
  vendor_id: number | null;
  business_unit_id: number | null;
  date: string | null;
}

function slim(po: RawPO): SlimPO {
  return {
    id: po.id,
    number: po.number ?? '',
    status: po.status ?? '',
    total: po.total ?? 0,
    vendor_id: po.vendorId ?? null,
    business_unit_id: po.businessUnitId ?? null,
    date: po.date ?? null,
  };
}

const DEFAULT_PAGESIZE = 25;
const MAX_PAGESIZE = 100;

export const inventory_purchase_orders_list: ToolDef<Args> = {
  name: 'inventory_purchase_orders_list',
  description: 'List ST purchase orders. Filter by status (Pending|Sent|Received|Canceled) or date range. Returns slim records (id, number, status, total, vendor_id, business_unit_id, date). Source: live ST.',
  zodSchema: {
    status: z.enum(['Pending', 'Sent', 'Received', 'Canceled']).optional(),
    fromDate: z.string().optional().describe('ISO date, PO date >= this'),
    toDate: z.string().optional().describe('ISO date, PO date <= this'),
    page: z.number().int().positive().optional(),
    pageSize: z.number().int().positive().max(MAX_PAGESIZE).optional(),
  },
  async handler(env, args, { actor, correlation }) {
    const page = args.page ?? 1;
    const pageSize = Math.min(args.pageSize ?? DEFAULT_PAGESIZE, MAX_PAGESIZE);
    const qs = new URLSearchParams();
    if (args.status) qs.set('status', args.status);
    if (args.fromDate) qs.set('dateFrom', args.fromDate);
    if (args.toDate) qs.set('dateTo', args.toDate);
    qs.set('page', String(page));
    qs.set('pageSize', String(pageSize));

    const path = `/inventory/v2/tenant/${env.ST_TENANT_ID}/purchase-orders?${qs}`;
    const resp = await env.ST_PROXY.fetch(
      `https://servicetitan-proxy/api/st/read?endpoint=${encodeURIComponent(path)}`,
      { headers: authHeaders(env, correlation, actor) },
    );
    if (!resp.ok) {
      throw new McpError('upstream_error', `inventory_purchase_orders_list failed: ${resp.status}`, { correlation });
    }
    const data = (await resp.json()) as { data?: RawPO[]; hasMore?: boolean };
    return {
      count: (data.data ?? []).length,
      purchase_orders: (data.data ?? []).map(slim),
      has_more: !!data.hasMore,
      _source: 'live',
    };
  },
  transformResult: defaultShaper,
};
```

- [ ] **Step 4: Run test to confirm it passes**

```bash
npx vitest run src/tools/__tests__/inventory_purchase_orders_list.test.ts
```

Expected: PASS — 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/tools/inventory/inventory_purchase_orders_list.ts \
        src/tools/__tests__/inventory_purchase_orders_list.test.ts
git commit -m "feat(inventory): add inventory_purchase_orders_list tool"
git push
```

### Task 2.3 — Remaining 7 tools (mirror Task 2.2 pattern)

For each tool below, create the source file with a slim type, slim function, handler, and `transformResult: defaultShaper`. Then write a 1-test smoke file (just the happy path — error path is covered by the registry wrapper). Commit each individually.

For brevity, only the slim shape + endpoint differs between tools — copy `inventory_purchase_orders_list.ts` and adjust:

#### 2.3a — `src/tools/inventory/inventory_purchase_order_get.ts`

```typescript
import { z } from 'zod';
import { McpError } from '../../errors';
import { authHeaders } from '../../auth';
import { defaultShaper } from '../../response-shape';
import type { ToolDef } from '../index';

interface Args { id: number }

export const inventory_purchase_order_get: ToolDef<Args> = {
  name: 'inventory_purchase_order_get',
  description: 'Get full ST purchase order by ID, including line items. Source: live ST.',
  zodSchema: { id: z.number().int().positive() },
  async handler(env, args, { actor, correlation }) {
    const path = `/inventory/v2/tenant/${env.ST_TENANT_ID}/purchase-orders/${args.id}`;
    const resp = await env.ST_PROXY.fetch(
      `https://servicetitan-proxy/api/st/read?endpoint=${encodeURIComponent(path)}`,
      { headers: authHeaders(env, correlation, actor) },
    );
    if (!resp.ok) throw new McpError('upstream_error', `inventory_purchase_order_get failed: ${resp.status}`, { correlation });
    return { ...((await resp.json()) as Record<string, unknown>), _source: 'live' };
  },
  transformResult: defaultShaper,
};
```

#### 2.3b — `src/tools/inventory/inventory_vendors_list.ts`

```typescript
import { z } from 'zod';
import { McpError } from '../../errors';
import { authHeaders } from '../../auth';
import { defaultShaper } from '../../response-shape';
import type { ToolDef } from '../index';

interface Args { active?: boolean; page?: number; pageSize?: number }
interface RawVendor { id: number; name?: string; active?: boolean; phone?: string; email?: string }
interface SlimVendor { id: number; name: string; active: boolean; phone: string | null; email: string | null }

const slim = (v: RawVendor): SlimVendor => ({
  id: v.id, name: v.name ?? '', active: v.active ?? true, phone: v.phone ?? null, email: v.email ?? null,
});

export const inventory_vendors_list: ToolDef<Args> = {
  name: 'inventory_vendors_list',
  description: 'List ST inventory vendors. Optionally filter by active flag. Returns slim records (id, name, active, phone, email). Source: live ST.',
  zodSchema: {
    active: z.boolean().optional(),
    page: z.number().int().positive().optional(),
    pageSize: z.number().int().positive().max(100).optional(),
  },
  async handler(env, args, { actor, correlation }) {
    const qs = new URLSearchParams();
    if (args.active !== undefined) qs.set('active', String(args.active));
    qs.set('page', String(args.page ?? 1));
    qs.set('pageSize', String(Math.min(args.pageSize ?? 25, 100)));
    const path = `/inventory/v2/tenant/${env.ST_TENANT_ID}/vendors?${qs}`;
    const resp = await env.ST_PROXY.fetch(
      `https://servicetitan-proxy/api/st/read?endpoint=${encodeURIComponent(path)}`,
      { headers: authHeaders(env, correlation, actor) },
    );
    if (!resp.ok) throw new McpError('upstream_error', `inventory_vendors_list failed: ${resp.status}`, { correlation });
    const data = (await resp.json()) as { data?: RawVendor[]; hasMore?: boolean };
    return { count: (data.data ?? []).length, vendors: (data.data ?? []).map(slim), has_more: !!data.hasMore, _source: 'live' };
  },
  transformResult: defaultShaper,
};
```

#### 2.3c — `src/tools/inventory/inventory_warehouses_list.ts`

Identical pattern. Slim shape: `{ id, name, address: string, active }`. Endpoint: `/inventory/v2/tenant/{tid}/warehouses`. Tool description: "List ST warehouses. Returns slim records (id, name, address, active). Source: live ST."

#### 2.3d — `src/tools/payroll/payroll_timesheets_list.ts`

```typescript
import { z } from 'zod';
import { McpError } from '../../errors';
import { authHeaders } from '../../auth';
import { defaultShaper } from '../../response-shape';
import type { ToolDef } from '../index';

interface Args {
  employeeId?: number;
  jobId?: number;
  fromDate?: string;
  toDate?: string;
  page?: number;
  pageSize?: number;
}
interface RawTS {
  id: number; employeeId?: number; jobId?: number;
  date?: string; hours?: number; activity?: string;
}
interface SlimTS {
  id: number; employee_id: number | null; job_id: number | null;
  date: string | null; hours: number; activity: string;
}
const slim = (t: RawTS): SlimTS => ({
  id: t.id, employee_id: t.employeeId ?? null, job_id: t.jobId ?? null,
  date: t.date ?? null, hours: t.hours ?? 0, activity: t.activity ?? '',
});

export const payroll_timesheets_list: ToolDef<Args> = {
  name: 'payroll_timesheets_list',
  description: 'List ST payroll timesheets. Filter by employee, job, or date range. Returns slim records (id, employee_id, job_id, date, hours, activity). Source: live ST.',
  zodSchema: {
    employeeId: z.number().int().positive().optional(),
    jobId: z.number().int().positive().optional(),
    fromDate: z.string().optional(),
    toDate: z.string().optional(),
    page: z.number().int().positive().optional(),
    pageSize: z.number().int().positive().max(100).optional(),
  },
  async handler(env, args, { actor, correlation }) {
    const qs = new URLSearchParams();
    if (args.employeeId) qs.set('employeeId', String(args.employeeId));
    if (args.jobId) qs.set('jobId', String(args.jobId));
    if (args.fromDate) qs.set('startsOnOrAfter', args.fromDate);
    if (args.toDate) qs.set('endsOnOrBefore', args.toDate);
    qs.set('page', String(args.page ?? 1));
    qs.set('pageSize', String(Math.min(args.pageSize ?? 25, 100)));
    const path = `/payroll/v2/tenant/${env.ST_TENANT_ID}/timesheets?${qs}`;
    const resp = await env.ST_PROXY.fetch(
      `https://servicetitan-proxy/api/st/read?endpoint=${encodeURIComponent(path)}`,
      { headers: authHeaders(env, correlation, actor) },
    );
    if (!resp.ok) throw new McpError('upstream_error', `payroll_timesheets_list failed: ${resp.status}`, { correlation });
    const data = (await resp.json()) as { data?: RawTS[]; hasMore?: boolean };
    return { count: (data.data ?? []).length, timesheets: (data.data ?? []).map(slim), has_more: !!data.hasMore, _source: 'live' };
  },
  transformResult: defaultShaper,
};
```

#### 2.3e — `src/tools/payroll/payroll_gross_pay_items_list.ts`

Same pattern. Slim shape: `{ id, employee_id, amount, payroll_id, type, date }`. Endpoint: `/payroll/v2/tenant/{tid}/gross-pay-items`. Filters: `employeeId`, `payrollId`, `fromDate`, `toDate`.

#### 2.3f — `src/tools/payroll/payroll_adjustments_list.ts`

Same pattern. Slim shape: `{ id, employee_id, amount, reason, date }`. Endpoint: `/payroll/v2/tenant/{tid}/payroll-adjustments`. Filters: `employeeId`, `fromDate`, `toDate`.

#### 2.3g — `src/tools/payroll/payroll_settings_get.ts`

Single-call, no list. Endpoint: `/payroll/v2/tenant/{tid}/settings`. Args: none. Returns the raw settings object (passed through `defaultShaper`).

```typescript
import { McpError } from '../../errors';
import { authHeaders } from '../../auth';
import { defaultShaper } from '../../response-shape';
import type { ToolDef } from '../index';

export const payroll_settings_get: ToolDef<Record<string, never>> = {
  name: 'payroll_settings_get',
  description: 'Get the tenant payroll settings (pay period, overtime rules, etc). Source: live ST.',
  zodSchema: {},
  async handler(env, _args, { actor, correlation }) {
    const path = `/payroll/v2/tenant/${env.ST_TENANT_ID}/settings`;
    const resp = await env.ST_PROXY.fetch(
      `https://servicetitan-proxy/api/st/read?endpoint=${encodeURIComponent(path)}`,
      { headers: authHeaders(env, correlation, actor) },
    );
    if (!resp.ok) throw new McpError('upstream_error', `payroll_settings_get failed: ${resp.status}`, { correlation });
    return { ...((await resp.json()) as Record<string, unknown>), _source: 'live' };
  },
  transformResult: defaultShaper,
};
```

- [ ] **Steps 1–7: For each of 2.3a–2.3g, create the source file, write a 1-test happy-path smoke file (mirror 2.2 Step 1), run vitest, commit.** Use commit messages: `feat(inventory): add <tool_name> tool` or `feat(payroll): add <tool_name> tool`.

### Task 2.4 — Register all 8 in TOOLS array

**File:** `src/tools/index.ts`

- [ ] **Step 1: Add imports**

After the existing `T6 — Pricebook` import block, add:

```typescript
// T8 — Inventory (4 tools)
import { inventory_purchase_orders_list } from './inventory/inventory_purchase_orders_list';
import { inventory_purchase_order_get } from './inventory/inventory_purchase_order_get';
import { inventory_vendors_list } from './inventory/inventory_vendors_list';
import { inventory_warehouses_list } from './inventory/inventory_warehouses_list';
// T9 — Payroll (4 tools)
import { payroll_timesheets_list } from './payroll/payroll_timesheets_list';
import { payroll_gross_pay_items_list } from './payroll/payroll_gross_pay_items_list';
import { payroll_adjustments_list } from './payroll/payroll_adjustments_list';
import { payroll_settings_get } from './payroll/payroll_settings_get';
```

- [ ] **Step 2: Add to TOOLS array**

Inside the `export const TOOLS` array, after the composite block, before the closing `] as const`, add:

```typescript
  // T8 Inventory
  inventory_purchase_orders_list,
  inventory_purchase_order_get,
  inventory_vendors_list,
  inventory_warehouses_list,
  // T9 Payroll
  payroll_timesheets_list,
  payroll_gross_pay_items_list,
  payroll_adjustments_list,
  payroll_settings_get,
```

- [ ] **Step 3: Run typecheck**

```bash
npm run typecheck
```

Expected: clean.

- [ ] **Step 4: Add a count-assertion test**

Append to `src/tools/__tests__/tool-registry.test.ts`:

```typescript
import { TOOLS } from '../index';
describe('TOOLS catalog', () => {
  it('has 73 tools registered (65 baseline default + 8 new = 73; admin st_call adds 1 → 74 visible to admin)', () => {
    expect(TOOLS.length).toBe(73);
  });
  it('includes all new inventory + payroll tools', () => {
    const names = TOOLS.map((t) => t.name);
    for (const n of [
      'inventory_purchase_orders_list', 'inventory_purchase_order_get',
      'inventory_vendors_list', 'inventory_warehouses_list',
      'payroll_timesheets_list', 'payroll_gross_pay_items_list',
      'payroll_adjustments_list', 'payroll_settings_get',
    ]) {
      expect(names).toContain(n);
    }
  });
});
```

> Note: if `TOOLS.length` differs from 73 because of recent admin-only / role-gated additions, adjust the number. The point of the test is the **invariant** that all 8 names land in TOOLS.

- [ ] **Step 5: Run all tests**

```bash
npm run check
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add src/tools/index.ts src/tools/__tests__/tool-registry.test.ts
git commit -m "feat(tools): register inventory + payroll tool pack (8 tools)"
git push
```

### Task 2.5 — Verify against /health

- [ ] **Step 1: Deploy to dev**

```bash
npm run deploy:dev
```

- [ ] **Step 2: Probe `/health`**

```bash
curl -s https://mcp-servicetitan-dev.lpeluso.workers.dev/health | jq '.tools | length, (.tools[] | select(. | startswith("inventory") or startswith("payroll")))'
```

Expected: `74` (or whatever your baseline + 8 was) and a list of all 8 new tool names.

- [ ] **Step 3: Live-fire one read**

```bash
# init session, then:
curl -s -X POST -H "mcp-session-id: $SESSION" -H "Accept: application/json, text/event-stream" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/call","id":2,"params":{"name":"inventory_vendors_list","arguments":{"pageSize":3}}}' \
  https://mcp-servicetitan-dev.lpeluso.workers.dev/mcp \
  | jq '.result.content[0].text | fromjson | .vendors[] | {id, name}'
```

Expected: 3 vendor records.

**Track 2 done.** Independently shippable.

---

## Track 3 — Webhook event allowlist + per-event metric (~1 day)

Today `webhook-ingest.ts` accepts any `eventType`. Track 3 adds:

1. An `ACCEPTED_EVENT_TYPES` Set sourced from Velocity's n8n trigger node (verified 2026-05-06):
   - `appointmentScheduled` — Miss Dawn booking confirmation
   - `jobCompleted` — debrief / reporting trigger
   - `paymentReceived` — payment confirmation
   - `customerCreated` — new lead alerting
2. An ST-canonical-header read (`x-servicetitan-event`) before falling back to body fields. Velocity's node confirms ST sends the header.
3. Per-event metric emission via `obs.metric()` so distribution shows up in CF Analytics Engine.
4. Migration `0003_webhook_event_index.sql` adding an index on `webhook_events.event_type` for query efficiency.

### Task 3.1 — Migration: index event_type

**File:** `migrations/0003_webhook_event_index.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 0003_webhook_event_index.sql
-- Adds index on webhook_events.event_type so type-filtered queries (e.g.
-- "all jobCompleted events from last 24h") don't full-scan the table.
CREATE INDEX IF NOT EXISTS idx_webhook_events_event_type
  ON webhook_events (event_type, received_at);
```

- [ ] **Step 2: Apply to dev D1**

```bash
wrangler d1 execute qsc-mcp-st --env dev --remote --file migrations/0003_webhook_event_index.sql
```

Expected: success.

- [ ] **Step 3: Apply to prod D1 (after Track 3 fully merges; document in PR)**

```bash
# Don't run this until all of Track 3 lands on main.
wrangler d1 execute qsc-mcp-st --remote --file migrations/0003_webhook_event_index.sql
```

- [ ] **Step 4: Commit**

```bash
git add migrations/0003_webhook_event_index.sql
git commit -m "feat(webhook): add 0003 index on webhook_events.event_type"
git push
```

### Task 3.2 — Allowlist + header read + metric (TDD)

**Files:**
- Modify: `src/webhook-ingest.ts`
- Modify: `src/tools/__tests__/webhook-ingest.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `src/tools/__tests__/webhook-ingest.test.ts`:

```typescript
describe('webhook-ingest — event allowlist', () => {
  async function sign(secret: string, message: string): Promise<string> {
    const enc = new TextEncoder();
    const k = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const s = await crypto.subtle.sign('HMAC', k, enc.encode(message));
    return Array.from(new Uint8Array(s)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  function makeEnv() {
    const stmt = { bind: vi.fn().mockReturnThis(), run: vi.fn().mockResolvedValue({ success: true }) };
    return {
      ST_WEBHOOK_SECRET: 'sec',
      DB: { prepare: vi.fn().mockReturnValue(stmt) },
      MCP_METRICS: { writeDataPoint: vi.fn() },
    } as any;
  }

  it('rejects unknown event types with 400', async () => {
    const env = makeEnv();
    const body = JSON.stringify({ eventId: 'e-1', eventType: 'nonsense' });
    const sig = await sign('sec', body);
    const req = new Request('http://x/webhooks/st', {
      method: 'POST',
      headers: { 'X-ST-Signature': sig },
      body,
    });
    const r = await (await import('../../webhook-ingest')).handleWebhook(env, req);
    expect(r.status).toBe(400);
    const j = await r.json() as any;
    expect(j.error).toBe('unknown_event_type');
    expect(j.received).toBe('nonsense');
  });

  it('reads x-servicetitan-event header in preference to body', async () => {
    const env = makeEnv();
    const body = JSON.stringify({ eventId: 'e-2', eventType: 'thiswillbeoverridden', data: {} });
    const sig = await sign('sec', body);
    const req = new Request('http://x/webhooks/st', {
      method: 'POST',
      headers: { 'X-ST-Signature': sig, 'x-servicetitan-event': 'jobCompleted' },
      body,
    });
    const r = await (await import('../../webhook-ingest')).handleWebhook(env, req);
    expect(r.status).toBe(200);
    const stmtCall = (env.DB.prepare as any).mock.results[0].value.bind.mock.calls[0];
    expect(stmtCall[1]).toBe('jobCompleted'); // event_type column
  });

  it('emits a metric on accepted event', async () => {
    const env = makeEnv();
    const body = JSON.stringify({ eventId: 'e-3', eventType: 'paymentReceived' });
    const sig = await sign('sec', body);
    const req = new Request('http://x/webhooks/st', {
      method: 'POST',
      headers: { 'X-ST-Signature': sig },
      body,
    });
    await (await import('../../webhook-ingest')).handleWebhook(env, req);
    expect(env.MCP_METRICS.writeDataPoint).toHaveBeenCalledTimes(1);
    const point = (env.MCP_METRICS.writeDataPoint as any).mock.calls[0][0];
    expect(point.indexes).toContain('paymentReceived');
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npx vitest run src/tools/__tests__/webhook-ingest.test.ts
```

Expected: 3 new failures.

- [ ] **Step 3: Update webhook-ingest.ts**

Replace `src/webhook-ingest.ts` with:

```typescript
import type { Env } from './env';

// ST event types we accept. Source: Velocity n8n trigger node, verified
// 2026-05-06. Add to this set when subscribing to a new event in the ST
// portal. Adding a name here without a portal subscription is a no-op;
// removing one will start rejecting live events with 400.
const ACCEPTED_EVENT_TYPES: ReadonlySet<string> = new Set([
  'appointmentScheduled', // Miss Dawn booking confirmation
  'jobCompleted',         // debrief / reporting trigger
  'paymentReceived',      // payment confirmation
  'customerCreated',      // new lead alerting
]);

async function verifyHmacSha256(secret: string, message: string, signature: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const computed = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  const computedHex = Array.from(new Uint8Array(computed))
    .map((b) => b.toString(16).padStart(2, '0')).join('');
  let xorSum = 0;
  const minLen = Math.min(computedHex.length, signature.length);
  for (let i = 0; i < minLen; i++) {
    xorSum |= computedHex.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  xorSum |= computedHex.length ^ signature.length;
  return xorSum === 0;
}

export async function handleWebhook(env: Env, req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'method_not_allowed' }), { status: 405 });
  }

  const signature = req.headers.get('X-ST-Signature');
  if (!signature) {
    return new Response(JSON.stringify({ error: 'missing_signature' }), { status: 401 });
  }

  const body = await req.text();
  if (!(await verifyHmacSha256(env.ST_WEBHOOK_SECRET, body, signature))) {
    return new Response(JSON.stringify({ error: 'invalid_signature' }), { status: 401 });
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return new Response(JSON.stringify({ error: 'invalid_json' }), { status: 400 });
  }

  const eventId = payload.eventId ?? payload.event_id ?? payload.id;
  // Header takes precedence over body — ST's canonical signal per their portal.
  const headerEvent = req.headers.get('x-servicetitan-event');
  const eventType = String(headerEvent ?? payload.eventType ?? payload.event_type ?? payload.type ?? 'unknown');

  if (!eventId) {
    return new Response(JSON.stringify({ error: 'missing_event_id' }), { status: 400 });
  }
  if (!ACCEPTED_EVENT_TYPES.has(eventType)) {
    return new Response(JSON.stringify({ error: 'unknown_event_type', received: eventType }), { status: 400 });
  }

  const receivedAt = Date.now();
  try {
    const stmt = env.DB.prepare(
      'INSERT OR IGNORE INTO webhook_events (event_id, event_type, payload, received_at) VALUES (?, ?, ?, ?)',
    ).bind(String(eventId), eventType, body, receivedAt);
    await stmt.run();

    // Per-event metric so distribution is queryable in CF Analytics Engine.
    // Index by eventType keeps cardinality low (4 values).
    if (env.MCP_METRICS) {
      env.MCP_METRICS.writeDataPoint({
        indexes: [eventType],
        blobs: ['webhook'],
        doubles: [1],
      });
    }

    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error';
    return new Response(JSON.stringify({ error: msg }), { status: 500 });
  }
}
```

- [ ] **Step 4: Run tests**

```bash
npm run check
```

Expected: all webhook tests pass (existing 7 + new 3 = 10).

- [ ] **Step 5: Commit**

```bash
git add src/webhook-ingest.ts src/tools/__tests__/webhook-ingest.test.ts
git commit -m "feat(webhook): add event-type allowlist + header read + per-event metric"
git push
```

### Task 3.3 — Verify against dev

- [ ] **Step 1: Deploy to dev**

```bash
npm run deploy:dev
```

- [ ] **Step 2: Send a fake webhook with allowed type**

```bash
SECRET=$(wrangler secret list --env dev | grep ST_WEBHOOK_SECRET || echo "set the secret first via wrangler secret put ST_WEBHOOK_SECRET --env dev")

# Compute test signature
BODY='{"eventId":"test-1","data":{}}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$ST_WEBHOOK_SECRET_VALUE" | awk '{print $2}')

curl -i -X POST \
  -H "X-ST-Signature: $SIG" \
  -H "x-servicetitan-event: jobCompleted" \
  -H "Content-Type: application/json" \
  -d "$BODY" \
  https://mcp-servicetitan-dev.lpeluso.workers.dev/webhooks/st
```

Expected: HTTP 200, `{"ok":true}`.

- [ ] **Step 3: Send with disallowed type → expect 400**

Repeat with `x-servicetitan-event: nonsense`. Expected: HTTP 400, `{"error":"unknown_event_type","received":"nonsense"}`.

- [ ] **Step 4: Verify D1 row**

```bash
wrangler d1 execute qsc-mcp-st --env dev --remote --command "SELECT event_id, event_type FROM webhook_events ORDER BY received_at DESC LIMIT 5"
```

Expected: most recent row has `event_type = jobCompleted`.

**Track 3 done.** Independently shippable.

---

## Closeout

### Task C.1 — Bundle PR + deploy

- [ ] **Step 1: Final preflight on the branch**

```bash
cd /home/taylor/work/mcp-servicetitan
git status                       # expect clean
git fetch && git diff --quiet origin/main..HEAD  # expect output (commits ahead)
npm run check                    # all tests + typecheck
bash scripts/preflight.sh        # gate on protected files, secrets
```

- [ ] **Step 2: Open PR**

```bash
gh pr create --title "v1.4: response shaper + inventory/payroll pack + webhook allowlist" --body "$(cat <<'EOF'
## Summary
- Track 1: `src/response-shape.ts` — opt-in shaper applied via new `ToolDef.transformResult`; adopted by `customer_snapshot`, `job_closeout_report`, `st_list_customers`.
- Track 2: 8 new tools — 4 inventory (purchase orders list/get, vendors, warehouses) + 4 payroll (timesheets, gross pay items, adjustments, settings). Tool count: 66 → 74.
- Track 3: webhook ingest gains `ACCEPTED_EVENT_TYPES` allowlist (4 events), reads `x-servicetitan-event` header, emits per-event metric, adds D1 index migration `0003_webhook_event_index.sql`.

## Test plan
- [x] `npm run check` — all tests + typecheck pass
- [x] `bash scripts/preflight.sh` — protected files intact
- [ ] Apply migration `0003_webhook_event_index.sql` to prod D1 after merge: `wrangler d1 execute qsc-mcp-st --remote --file migrations/0003_webhook_event_index.sql`
- [ ] Deploy via CI on merge to main
- [ ] Smoke-test against prod: `curl /health` shows 74 tools; call `inventory_vendors_list`; send fake `jobCompleted` webhook
- [ ] Update `qsc-infra/.claude/rules/protected-modules.md` mcp-servicetitan row to reflect v1.4 + new migration

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: After merge, run prod migration + verify**

```bash
wrangler d1 execute qsc-mcp-st --remote --file migrations/0003_webhook_event_index.sql
curl -s https://mcp-servicetitan.lpeluso.workers.dev/health | jq '.tools | length'  # expect 74
```

- [ ] **Step 4: Update qsc-infra**

In `/home/taylor/qsc-infra/.claude/rules/protected-modules.md`, update the `mcp-servicetitan` row:
- Bump version to v1.4.0
- Add note: "Track 1 response-shape module + Track 2 inventory/payroll pack (8 tools) + Track 3 webhook allowlist deployed YYYY-MM-DD"
- Add `migrations/0003_webhook_event_index.sql` to the protected-files list (only if you want it locked; optional)

Commit + push qsc-infra.

---

## Out-of-scope follow-ups (NOT in this plan)

- **Apply shaper to remaining ~63 tools.** Track 1 only adopts shaper on 3 smoke-test tools. The full rollout is a separate PR — pick batches of 5-10 tools, ensure their tests still pass, deploy. Intentionally deferred so this plan stays a 1-day Track-1 effort.
- **Additional webhook event types.** The 4 in Track 3 cover the highest-value flows. The full Velocity list adds 6 more (`appointmentCompleted`, `estimateApproved`, `invoiceCreated`, `jobCreated`, `leadCreated`, `membershipCreated`). Add when a downstream consumer needs them — adding without a consumer is dead weight.
- **Webhook consumers.** Track 3 only persists events. Wiring D1 → downstream (e.g., job.completed → trigger debrief PDF generation) is a separate plan.
- **MeltanoLabs/tap-service-titan stream coverage.** The wider GitHub search surfaced this Singer tap as the cleanest published map of stable ST endpoints. Worth a separate sweep against `taylor-ai`'s D1 sync to see which streams it covers that QSC doesn't (Customer Interactions, Service Agreements, Marketing Ads). Out of scope here — log as `OPEN-TASKS` follow-up.
- **`SpartanPlumbingJosh/spartan-core` call-scoring patterns.** Adjacent to Miss Dawn but lives in Retell flow / dawn-worker, not mcp-servicetitan.
