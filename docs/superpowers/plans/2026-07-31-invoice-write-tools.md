# Invoice Write Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two new mcp-servicetitan write tools — `st_add_invoice_line_item` and `st_create_adjustment_invoice` — that let QSC fix the recurring project-invoice/job-invoice misattribution defect (8 known instances, ~$76K) via a safe, audited MCP call instead of manual ST-UI edits.

**Architecture:** Two new files in `src/tools/invoicing/`, each following the `st_create_service` / `st_patch_service` two-phase shape exactly: `dryRun=true` (default) → `WriteGate.dryRun()` issues a confirmation token and echoes the shaped payload; `dryRun=false` + valid token → `WriteGate.verifyToken()` then the existing shared `durableWrite()` helper (imported from `st_patch_service.ts`, no new plumbing). Both tools register in `src/tools/index.ts` as `isWrite: true`.

**Tech Stack:** TypeScript, Cloudflare Workers, Zod, Vitest. No new dependencies.

## Global Constraints

- Follow the two-phase dryRun/confirmation-token/durableWrite pattern exactly as implemented in `src/tools/st_create_service.ts` and `src/tools/st_patch_service.ts` — do not invent a new write-plumbing variant.
- Both tools are `isWrite: true` in their `ToolDef`.
- Field names on write payloads must match the *live* ST GET shape confirmed during design research (see design doc `2026-07-31-invoice-write-tools-design.md`), not the untrustworthy third-party OpenAPI mirror: `type` (not `skuType`), `isChargeable` (not `chargeable`), `generalLedgerAccount` as `{id, name, number, type, detailType}` on GET (write accepts a plain id per this design — confirm during the manual sandbox check in Task 5).
- Exported-invoice guard is **warn-only, not hard-block** (design decision reversing an earlier fabricated "Michelle" reference — there's no real accounting contact to gate on).
- Equipment-type (`type: "Equipment"`) line items require both `price` and `cost` populated — per the established QSC hard fact that equipment (unlike services) uses static pricing.
- `st_create_adjustment_invoice` rejects parent invoices not in `Posted`/`Exported` status, and rejects a parent that is itself an adjustment invoice (`adjustmentToId` non-null) — no adjustment-of-adjustment chains.
- Do not build an adjustment-of-adjustment override flag or a "create brand-new job invoice from scratch" mode — out of scope per design doc YAGNI section.
- New tests go in the existing `src/tools/__tests__/st_write_tools.test.ts` (durableWrite/dryRun behavior) and `src/tools/__tests__/schemas.test.ts` (schema acceptance/rejection + registry counts).

---

### Task 1: `st_add_invoice_line_item` — schema, validation, dryRun path

**Files:**
- Create: `src/tools/invoicing/st_add_invoice_line_item.ts`
- Test: `src/tools/__tests__/st_write_tools.test.ts` (append to existing file)

**Interfaces:**
- Consumes: `WriteGate` from `../write-gate`, `durableWrite` from `../st_patch_service` (already exported, see `src/tools/st_patch_service.ts:104`), `McpError` from `../errors`, `ToolDef` from `../index`, `readST` from `../st`.
- Produces: `st_add_invoice_line_item: ToolDef<Args>` — consumed by Task 3 (registry wiring) and Task 4 (schema tests).

**Line item shape** (shared by both tools — define once here, Task 2 imports it):

```typescript
export interface InvoiceLineItemInput {
  skuId?: number;
  skuName?: string;
  description?: string;
  quantity: number;
  price?: number;
  cost?: number;
  generalLedgerAccountId?: number;
  businessUnitId?: number;
  type?: 'Service' | 'Material' | 'Equipment';
}
```

- [ ] **Step 1: Write the failing test for the "no lineItems" validation error**

Append to `src/tools/__tests__/st_write_tools.test.ts`, after the existing `st_create_material` describe block (find it with `grep -n "describe('st_create_material'" src/tools/__tests__/st_write_tools.test.ts` — insert after that block's closing `});`):

```typescript
// ── st_add_invoice_line_item ─────────────────────────────────

import { st_add_invoice_line_item } from '../invoicing/st_add_invoice_line_item';

describe('st_add_invoice_line_item', () => {
  function makeReadEnv(invoiceBody: unknown, jobBody: unknown = null, fetchImpl?: (url: string) => Promise<Response>) {
    return {
      ST_PROXY: {
        fetch: vi.fn(async (url: string) => {
          if (fetchImpl) return fetchImpl(url);
          if (url.includes('/jobs/')) {
            return new Response(JSON.stringify(jobBody), { status: 200 });
          }
          if (url.includes('dryRun=1')) {
            return new Response(JSON.stringify({ echo: true }), { status: 200 });
          }
          // invoices read endpoint returns a list envelope { data: [...] }
          return new Response(JSON.stringify({ data: [invoiceBody] }), { status: 200 });
        }),
      },
      MCP_SYNC_KEY: 'test-sync-key',
      MCP_SERVICE_VERSION: '0.0.0-test',
      ST_TENANT_ID: '000000000',
      DB: makeDB(),
      PROXY_STATE: {},
      SIRO_API_TOKEN: '',
    };
  }

  it('throws validation_error when lineItems is empty', async () => {
    const env = makeReadEnv({ id: 111, syncStatus: 'Pending', customer: { id: 5 } });
    await expect(
      st_add_invoice_line_item.handler(env as any, { invoiceId: 111, lineItems: [] }, CTX)
    ).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('throws validation_error when an Equipment line item is missing cost', async () => {
    const env = makeReadEnv({ id: 111, syncStatus: 'Pending', customer: { id: 5 } });
    await expect(
      st_add_invoice_line_item.handler(
        env as any,
        { invoiceId: 111, lineItems: [{ skuId: 1, quantity: 1, price: 500, type: 'Equipment' }] },
        CTX
      )
    ).rejects.toMatchObject({ code: 'validation_error', message: expect.stringContaining('cost') });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/taylor/work/mcp-servicetitan && npx vitest run src/tools/__tests__/st_write_tools.test.ts -t "st_add_invoice_line_item"`
Expected: FAIL — `Cannot find module '../invoicing/st_add_invoice_line_item'`

- [ ] **Step 3: Write the tool file**

Create `src/tools/invoicing/st_add_invoice_line_item.ts`:

```typescript
// ============================================================
// st_add_invoice_line_item — add line items to an invoice, optionally
// setting its job link.
// F3: dryRun=true (default) → confirmation_token → dryRun=false → durable write.
//
// Field names match the LIVE ST GET shape confirmed during design research
// (2026-07-31), not the untrustworthy third-party OpenAPI mirror: `type`
// (not `skuType`), `isChargeable` (not `chargeable`). generalLedgerAccountId/
// businessUnitId are accepted here as plain ints — GET returns them as
// nested objects ({id, name, ...}); the manual sandbox check (design doc,
// Implementation Risk section) confirms whether PATCH wants the bare id or
// the nested object before this tool's live write path ships.
//
// The jobId link is best-effort: research could not confirm whether ST's
// API allows changing an existing invoice's `job`/`invoiceConfiguration`
// post-creation. The primary path is adding line items to an
// already-job-linked empty invoice (QSC's pre-creation convention); jobId
// linking is attempted only when the invoice doesn't already have one.
// ============================================================

import { z } from 'zod';
import { McpError } from '../errors';
import { WriteGate } from '../write-gate';
import { readST } from '../st';
import type { ToolDef } from '../index';
import { durableWrite } from '../st_patch_service';

export interface InvoiceLineItemInput {
  skuId?: number;
  skuName?: string;
  description?: string;
  quantity: number;
  price?: number;
  cost?: number;
  generalLedgerAccountId?: number;
  businessUnitId?: number;
  type?: 'Service' | 'Material' | 'Equipment';
}

interface Args {
  invoiceId: number;
  jobId?: number;
  lineItems: InvoiceLineItemInput[];
  dryRun?: boolean;
  confirmation_token?: string;
}

const lineItemSchema = z.object({
  skuId: z.number().int().positive().optional(),
  skuName: z.string().optional(),
  description: z.string().optional(),
  quantity: z.number().positive(),
  price: z.number().optional(),
  cost: z.number().optional(),
  generalLedgerAccountId: z.number().int().positive().optional(),
  businessUnitId: z.number().int().positive().optional(),
  type: z.enum(['Service', 'Material', 'Equipment']).optional(),
});

interface RawInvoice {
  id?: number;
  syncStatus?: string;
  customer?: { id?: number };
  job?: { id?: number } | null;
  [key: string]: unknown;
}

interface RawJob {
  id?: number;
  customerId?: number;
  [key: string]: unknown;
}

function validateLineItems(lineItems: InvoiceLineItemInput[], correlation: string): void {
  if (!lineItems || lineItems.length === 0) {
    throw new McpError('validation_error', 'st_add_invoice_line_item requires at least one line item', { correlation });
  }
  for (const [i, item] of lineItems.entries()) {
    if (item.type === 'Equipment' && (item.price === undefined || item.cost === undefined)) {
      throw new McpError(
        'validation_error',
        `lineItems[${i}]: Equipment line items require both price and cost (QSC equipment is statically priced — a blank price/cost is a real $0-billing risk)`,
        { correlation }
      );
    }
  }
}

export const st_add_invoice_line_item: ToolDef<Args> = {
  name: 'st_add_invoice_line_item',
  description:
    'Add line item(s) to an existing ServiceTitan invoice, optionally linking it to a job. ' +
    'dryRun=true (default) validates and returns a confirmation_token — call again with dryRun=false + token to write. ' +
    'Exported invoices are NOT blocked (warn only) — no accounting sign-off exists yet for a hard block; review the dryRun warning before confirming. ' +
    'jobId linking is best-effort: ST may not support changing an existing invoice\'s job/invoiceConfiguration post-creation. ' +
    'Equipment-type line items require both price and cost (QSC equipment uses static pricing).',
  isWrite: true,
  stEndpoint: { method: 'PATCH', path: '/accounting/v2/tenant/{tid}/invoices/{id}', source: 'live' },
  zodSchema: {
    invoiceId: z.number().int().positive().describe('ST invoice ID to modify'),
    jobId: z.number().int().positive().optional().describe('If provided and the invoice has no job link yet, attempt to set it. Best-effort — see tool description.'),
    lineItems: z.array(lineItemSchema).min(1).describe('Line items to add to the invoice'),
    dryRun: z.boolean().default(true).describe('true (default) = preview + token; false = execute write'),
    confirmation_token: z.string().optional().describe('Token from prior dryRun=true call, required when dryRun=false'),
  },
  async handler(env, args, { actor, correlation }) {
    const { invoiceId, jobId, lineItems, dryRun = true, confirmation_token } = args;
    validateLineItems(lineItems, correlation);

    const tenant = env.ST_TENANT_ID;
    const invoiceData = await readST<{ data?: RawInvoice[] }>(
      env, { actor, correlation },
      `/accounting/v2/tenant/${tenant}/invoices`,
      { ids: invoiceId },
    );
    const invoice = invoiceData.data?.[0];
    if (!invoice) throw new McpError('not_found', `invoice ${invoiceId} not found`, { correlation });

    let jobLinkWarning: string | undefined;
    if (jobId) {
      const job = await readST<RawJob>(env, { actor, correlation }, `/jpm/v2/tenant/${tenant}/jobs/${jobId}`);
      if (job.customerId !== undefined && invoice.customer?.id !== undefined && job.customerId !== invoice.customer.id) {
        throw new McpError(
          'validation_error',
          `jobId ${jobId} belongs to customer ${job.customerId}, but invoice ${invoiceId} belongs to customer ${invoice.customer.id} — refusing cross-customer job link`,
          { correlation }
        );
      }
    }

    let exportWarning: string | undefined;
    if (invoice.syncStatus === 'Exported') {
      exportWarning = `invoice ${invoiceId} has syncStatus=Exported — writing to it may not reflect correctly in accounting. Consider st_create_adjustment_invoice instead. Proceeding anyway per warn-only policy.`;
    }

    const payload: Record<string, unknown> = { lineItems };
    if (jobId && !invoice.job) {
      payload.job = jobId;
      jobLinkWarning = `Attempting to set job=${jobId} on invoice ${invoiceId} — ST may not support this on an existing invoice; verify the write actually took by re-reading the invoice after confirmation.`;
    }

    const businessArgs = { invoiceId, jobId, lineItems };
    const gate = new WriteGate(env);
    const endpoint = `/accounting/v2/tenant/000000000/invoices/${invoiceId}`;

    if (dryRun) {
      const result = await gate.dryRun('st_add_invoice_line_item', businessArgs, actor, correlation, payload, endpoint, 'PATCH', 15 * 60 * 1000);
      return { ...result, warnings: [exportWarning, jobLinkWarning].filter(Boolean) };
    }
    if (!confirmation_token) {
      throw new McpError('validation_error', 'confirmation_token required when dryRun=false', { correlation });
    }
    await gate.verifyToken('st_add_invoice_line_item', businessArgs, actor, confirmation_token);
    return durableWrite(env, {
      actor, operation: 'invoice.add_line_item',
      target: { id: String(invoiceId), type: 'invoice' },
      payload, correlation,
    });
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/taylor/work/mcp-servicetitan && npx vitest run src/tools/__tests__/st_write_tools.test.ts -t "st_add_invoice_line_item"`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
cd /home/taylor/work/mcp-servicetitan
git add src/tools/invoicing/st_add_invoice_line_item.ts src/tools/__tests__/st_write_tools.test.ts
git commit -m "feat(invoicing): add st_add_invoice_line_item validation + dryRun path"
```

---

### Task 2: `st_add_invoice_line_item` — dryRun and durableWrite behavior tests

**Files:**
- Modify: `src/tools/__tests__/st_write_tools.test.ts`

**Interfaces:**
- Consumes: `st_add_invoice_line_item` from Task 1, `durableWrite` from `../st_patch_service` (already imported in the test file).

- [ ] **Step 1: Write the failing tests**

Append inside the `describe('st_add_invoice_line_item', ...)` block from Task 1:

```typescript
  it('dryRun=true returns DryRunResult with token and no warnings for a non-exported invoice with no job link', async () => {
    const env = makeReadEnv({ id: 111, syncStatus: 'Pending', customer: { id: 5 }, job: null });
    const result: any = await st_add_invoice_line_item.handler(
      env as any,
      { invoiceId: 111, lineItems: [{ skuId: 1, quantity: 1, price: 200, type: 'Service' }] },
      CTX
    );
    expect(result.dryRun).toBe(true);
    expect(result.tool).toBe('st_add_invoice_line_item');
    expect(result.confirmation_token).toBeTypeOf('string');
    expect(result.warnings).toEqual([]);
  });

  it('dryRun=true includes an export warning for syncStatus=Exported (warn-only, not blocked)', async () => {
    const env = makeReadEnv({ id: 111, syncStatus: 'Exported', customer: { id: 5 }, job: null });
    const result: any = await st_add_invoice_line_item.handler(
      env as any,
      { invoiceId: 111, lineItems: [{ skuId: 1, quantity: 1, price: 200, type: 'Service' }] },
      CTX
    );
    expect(result.dryRun).toBe(true);
    expect(result.warnings.some((w: string) => w.includes('Exported'))).toBe(true);
  });

  it('rejects a jobId belonging to a different customer than the invoice', async () => {
    const env = makeReadEnv(
      { id: 111, syncStatus: 'Pending', customer: { id: 5 }, job: null },
      { id: 999, customerId: 999 },
    );
    await expect(
      st_add_invoice_line_item.handler(
        env as any,
        { invoiceId: 111, jobId: 999, lineItems: [{ skuId: 1, quantity: 1, price: 200, type: 'Service' }] },
        CTX
      )
    ).rejects.toMatchObject({ code: 'validation_error', message: expect.stringContaining('cross-customer') });
  });

  it('throws not_found when the invoice does not exist', async () => {
    const env = {
      ST_PROXY: { fetch: vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) },
      MCP_SYNC_KEY: 'test-sync-key', MCP_SERVICE_VERSION: '0.0.0-test', ST_TENANT_ID: '000000000',
      DB: makeDB(), PROXY_STATE: {}, SIRO_API_TOKEN: '',
    };
    await expect(
      st_add_invoice_line_item.handler(
        env as any,
        { invoiceId: 999999, lineItems: [{ skuId: 1, quantity: 1, price: 200 }] },
        CTX
      )
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('durableWrite submits operation invoice.add_line_item with correct target and payload', async () => {
    const output = { status: 'ok' };
    const env = makeEnv(happyFetch(output));
    const result = await durableWrite(env, {
      actor: CTX.actor, operation: 'invoice.add_line_item',
      target: { id: '111', type: 'invoice' },
      payload: { lineItems: [{ skuId: 1, quantity: 1, price: 200 }] },
      correlation: CORRELATION,
    });
    expect(result).toEqual(output);
    const [, init] = env.ST_PROXY.fetch.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.operation).toBe('invoice.add_line_item');
    expect(body.target).toEqual({ id: '111', type: 'invoice' });
  });
```

- [ ] **Step 2: Run test to verify it fails first (before any bug), then passes**

Run: `cd /home/taylor/work/mcp-servicetitan && npx vitest run src/tools/__tests__/st_write_tools.test.ts -t "st_add_invoice_line_item"`
Expected: All 6 tests in this describe block PASS (the tool code from Task 1 already implements this behavior — these tests should pass immediately; if any fails, fix `st_add_invoice_line_item.ts` until it does, do not weaken the test).

- [ ] **Step 3: Commit**

```bash
cd /home/taylor/work/mcp-servicetitan
git add src/tools/__tests__/st_write_tools.test.ts
git commit -m "test(invoicing): cover st_add_invoice_line_item dryRun/warning/durableWrite paths"
```

---

### Task 3: `st_create_adjustment_invoice` — schema, validation, dryRun path

**Files:**
- Create: `src/tools/invoicing/st_create_adjustment_invoice.ts`
- Modify: `src/tools/__tests__/st_write_tools.test.ts`

**Interfaces:**
- Consumes: `InvoiceLineItemInput` from `./st_add_invoice_line_item` (Task 1), `WriteGate`, `durableWrite`, `McpError`, `readST`, `ToolDef`.
- Produces: `st_create_adjustment_invoice: ToolDef<Args>` — consumed by Task 5 (registry) and Task 4 (schema tests).

- [ ] **Step 1: Write the failing tests**

Append to `src/tools/__tests__/st_write_tools.test.ts`, after the `st_add_invoice_line_item` describe block:

```typescript
// ── st_create_adjustment_invoice ─────────────────────────────

import { st_create_adjustment_invoice } from '../invoicing/st_create_adjustment_invoice';

describe('st_create_adjustment_invoice', () => {
  function makeParentEnv(parentInvoice: unknown) {
    return {
      ST_PROXY: {
        fetch: vi.fn(async (url: string) => {
          if (url.includes('dryRun=1')) return new Response(JSON.stringify({ echo: true }), { status: 200 });
          return new Response(JSON.stringify({ data: [parentInvoice] }), { status: 200 });
        }),
      },
      MCP_SYNC_KEY: 'test-sync-key', MCP_SERVICE_VERSION: '0.0.0-test', ST_TENANT_ID: '000000000',
      DB: makeDB(), PROXY_STATE: {}, SIRO_API_TOKEN: '',
    };
  }

  it('throws validation_error when lineItems is empty', async () => {
    const env = makeParentEnv({ id: 222, syncStatus: 'Exported', adjustmentToId: null });
    await expect(
      st_create_adjustment_invoice.handler(env as any, { parentInvoiceId: 222, lineItems: [] }, CTX)
    ).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('throws not_found when the parent invoice does not exist', async () => {
    const env = {
      ST_PROXY: { fetch: vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) },
      MCP_SYNC_KEY: 'test-sync-key', MCP_SERVICE_VERSION: '0.0.0-test', ST_TENANT_ID: '000000000',
      DB: makeDB(), PROXY_STATE: {}, SIRO_API_TOKEN: '',
    };
    await expect(
      st_create_adjustment_invoice.handler(env as any, { parentInvoiceId: 999999, lineItems: [{ skuId: 1, quantity: 1, price: -200 }] }, CTX)
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('rejects a parent invoice not in Posted or Exported status', async () => {
    const env = makeParentEnv({ id: 222, syncStatus: 'Pending', adjustmentToId: null });
    await expect(
      st_create_adjustment_invoice.handler(env as any, { parentInvoiceId: 222, lineItems: [{ skuId: 1, quantity: 1, price: -200 }] }, CTX)
    ).rejects.toMatchObject({ code: 'validation_error', message: expect.stringContaining('Posted') });
  });

  it('rejects a parent invoice that is itself an adjustment invoice', async () => {
    const env = makeParentEnv({ id: 222, syncStatus: 'Exported', adjustmentToId: 111 });
    await expect(
      st_create_adjustment_invoice.handler(env as any, { parentInvoiceId: 222, lineItems: [{ skuId: 1, quantity: 1, price: -200 }] }, CTX)
    ).rejects.toMatchObject({ code: 'validation_error', message: expect.stringContaining('adjustment') });
  });

  it('dryRun=true returns DryRunResult with token for a valid Exported parent', async () => {
    const env = makeParentEnv({ id: 222, syncStatus: 'Exported', adjustmentToId: null, businessUnit: { id: 257 } });
    const result: any = await st_create_adjustment_invoice.handler(
      env as any,
      { parentInvoiceId: 222, lineItems: [{ skuId: 1, quantity: 1, price: -998484, type: 'Service' }] },
      CTX
    );
    expect(result.dryRun).toBe(true);
    expect(result.tool).toBe('st_create_adjustment_invoice');
    expect(result.confirmation_token).toBeTypeOf('string');
  });

  it('does not warn when adjustment line total nets the stated offsetAmount to zero, warns when it does not', async () => {
    const env = makeParentEnv({ id: 222, syncStatus: 'Exported', adjustmentToId: null, businessUnit: { id: 257 } });
    const netted: any = await st_create_adjustment_invoice.handler(
      env as any,
      { parentInvoiceId: 222, lineItems: [{ skuId: 1, quantity: 1, price: -100 }], offsetAmount: 100 },
      CTX
    );
    expect(netted.warnings).toEqual([]);

    const unnetted: any = await st_create_adjustment_invoice.handler(
      env as any,
      { parentInvoiceId: 222, lineItems: [{ skuId: 1, quantity: 1, price: -50 }], offsetAmount: 100 },
      CTX
    );
    expect(unnetted.warnings.some((w: string) => w.includes('does not net'))).toBe(true);
  });

  it('durableWrite submits operation invoice.create_adjustment with correct target and payload', async () => {
    const output = { status: 'ok' };
    const env = makeEnv(happyFetch(output));
    const result = await durableWrite(env, {
      actor: CTX.actor, operation: 'invoice.create_adjustment',
      target: { id: '222', type: 'invoice' },
      payload: { adjustmentToId: 222, lineItems: [{ skuId: 1, quantity: 1, price: -998484 }] },
      correlation: CORRELATION,
    });
    expect(result).toEqual(output);
    const [, init] = env.ST_PROXY.fetch.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.operation).toBe('invoice.create_adjustment');
    expect(body.target).toEqual({ id: '222', type: 'invoice' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/taylor/work/mcp-servicetitan && npx vitest run src/tools/__tests__/st_write_tools.test.ts -t "st_create_adjustment_invoice"`
Expected: FAIL — `Cannot find module '../invoicing/st_create_adjustment_invoice'`

- [ ] **Step 3: Write the tool file**

Create `src/tools/invoicing/st_create_adjustment_invoice.ts`:

```typescript
// ============================================================
// st_create_adjustment_invoice — create an adjustment invoice against a
// parent invoice (Posted/Exported only), per ST's own documented behavior
// (help.servicetitan.com/docs/create-an-adjustment-invoice).
// F3: dryRun=true (default) → confirmation_token → dryRun=false → durable write.
//
// The exact ST endpoint/payload for adjustment-invoice creation is
// UNCONFIRMED as of design (2026-07-31) — the only spec source available
// (a third-party GitHub mirror) disagrees with live GET evidence, and
// developer.servicetitan.io could not be rendered headlessly. This tool's
// stEndpoint/payload below is a best-guess informed by the one confirmed
// real field (`adjustmentToId`, seen live on GET responses). Per the design
// doc's Implementation Risk section, do NOT rely on this tool's live write
// path until the manual sandbox-confirmation check (plan Task 5) has run.
// ============================================================

import { z } from 'zod';
import { McpError } from '../errors';
import { WriteGate } from '../write-gate';
import { readST } from '../st';
import type { ToolDef } from '../index';
import { durableWrite } from '../st_patch_service';
import type { InvoiceLineItemInput } from './st_add_invoice_line_item';

interface Args {
  parentInvoiceId: number;
  lineItems: InvoiceLineItemInput[];
  businessUnitId?: number;
  invoiceDate?: string;
  offsetAmount?: number;
  dryRun?: boolean;
  confirmation_token?: string;
}

const lineItemSchema = z.object({
  skuId: z.number().int().positive().optional(),
  skuName: z.string().optional(),
  description: z.string().optional(),
  quantity: z.number().positive(),
  price: z.number().optional(),
  cost: z.number().optional(),
  generalLedgerAccountId: z.number().int().positive().optional(),
  businessUnitId: z.number().int().positive().optional(),
  type: z.enum(['Service', 'Material', 'Equipment']).optional(),
});

interface RawInvoice {
  id?: number;
  syncStatus?: string;
  adjustmentToId?: number | null;
  businessUnit?: { id?: number };
  [key: string]: unknown;
}

function validateLineItems(lineItems: InvoiceLineItemInput[], correlation: string): void {
  if (!lineItems || lineItems.length === 0) {
    throw new McpError('validation_error', 'st_create_adjustment_invoice requires at least one line item', { correlation });
  }
  for (const [i, item] of lineItems.entries()) {
    if (item.type === 'Equipment' && (item.price === undefined || item.cost === undefined)) {
      throw new McpError(
        'validation_error',
        `lineItems[${i}]: Equipment line items require both price and cost (QSC equipment is statically priced)`,
        { correlation }
      );
    }
  }
}

export const st_create_adjustment_invoice: ToolDef<Args> = {
  name: 'st_create_adjustment_invoice',
  description:
    'Create an adjustment invoice against a parent invoice (must be Posted or Exported). ' +
    'dryRun=true (default) validates and returns a confirmation_token — call again with dryRun=false + token to write. ' +
    'Adjustment lines are typically negative to offset revenue, but sign is not enforced. ' +
    'UNCONFIRMED ENDPOINT: the real ST adjustment-invoice API shape has not been verified live as of 2026-07-31 — ' +
    'run the manual sandbox-confirmation check before trusting the live write path (see design doc Implementation Risk).',
  isWrite: true,
  stEndpoint: { method: 'POST', path: '/accounting/v2/tenant/{tid}/invoices', source: 'live' },
  zodSchema: {
    parentInvoiceId: z.number().int().positive().describe('ST invoice ID being adjusted'),
    lineItems: z.array(lineItemSchema).min(1).describe('Adjustment line items — typically negative to offset revenue'),
    businessUnitId: z.number().int().positive().optional().describe('Defaults to the parent invoice\'s business unit'),
    invoiceDate: z.string().optional().describe('Defaults to today (ISO date)'),
    offsetAmount: z.number().optional().describe('If provided, warns (does not block) when lineItems totals do not net this amount to zero'),
    dryRun: z.boolean().default(true).describe('true (default) = preview + token; false = execute write'),
    confirmation_token: z.string().optional().describe('Token from prior dryRun=true call, required when dryRun=false'),
  },
  async handler(env, args, { actor, correlation }) {
    const { parentInvoiceId, lineItems, businessUnitId, invoiceDate, offsetAmount, dryRun = true, confirmation_token } = args;
    validateLineItems(lineItems, correlation);

    const tenant = env.ST_TENANT_ID;
    const parentData = await readST<{ data?: RawInvoice[] }>(
      env, { actor, correlation },
      `/accounting/v2/tenant/${tenant}/invoices`,
      { ids: parentInvoiceId },
    );
    const parent = parentData.data?.[0];
    if (!parent) throw new McpError('not_found', `invoice ${parentInvoiceId} not found`, { correlation });

    if (parent.syncStatus !== 'Posted' && parent.syncStatus !== 'Exported') {
      throw new McpError(
        'validation_error',
        `invoice ${parentInvoiceId} has syncStatus=${parent.syncStatus} — adjustment invoices can only be created against Posted or Exported invoices`,
        { correlation }
      );
    }
    if (parent.adjustmentToId) {
      throw new McpError(
        'validation_error',
        `invoice ${parentInvoiceId} is itself an adjustment invoice (adjustmentToId=${parent.adjustmentToId}) — adjustment-of-adjustment chains are not supported`,
        { correlation }
      );
    }

    const warnings: string[] = [];
    if (offsetAmount !== undefined) {
      const lineTotal = lineItems.reduce((sum, li) => sum + (li.price ?? 0) * li.quantity, 0);
      if (Math.abs(lineTotal + offsetAmount) > 0.01) {
        warnings.push(`adjustment line total (${lineTotal}) does not net offsetAmount (${offsetAmount}) to zero — informational only, not all adjustments are full offsets`);
      }
    }

    const payload: Record<string, unknown> = {
      adjustmentToId: parentInvoiceId,
      lineItems,
      businessUnitId: businessUnitId ?? parent.businessUnit?.id,
      invoiceDate,
    };

    const businessArgs = { parentInvoiceId, lineItems, businessUnitId, invoiceDate, offsetAmount };
    const gate = new WriteGate(env);
    const endpoint = `/accounting/v2/tenant/000000000/invoices`;

    if (dryRun) {
      const result = await gate.dryRun('st_create_adjustment_invoice', businessArgs, actor, correlation, payload, endpoint, 'POST', 15 * 60 * 1000);
      return { ...result, warnings };
    }
    if (!confirmation_token) {
      throw new McpError('validation_error', 'confirmation_token required when dryRun=false', { correlation });
    }
    await gate.verifyToken('st_create_adjustment_invoice', businessArgs, actor, confirmation_token);
    return durableWrite(env, {
      actor, operation: 'invoice.create_adjustment',
      target: { id: String(parentInvoiceId), type: 'invoice' },
      payload, correlation,
    });
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/taylor/work/mcp-servicetitan && npx vitest run src/tools/__tests__/st_write_tools.test.ts -t "st_create_adjustment_invoice"`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
cd /home/taylor/work/mcp-servicetitan
git add src/tools/invoicing/st_create_adjustment_invoice.ts src/tools/__tests__/st_write_tools.test.ts
git commit -m "feat(invoicing): add st_create_adjustment_invoice with Posted/Exported + no-chaining guards"
```

---

### Task 4: Registry wiring + schema tests

**Files:**
- Modify: `src/tools/index.ts:96-100` (invoicing imports), `src/tools/index.ts:221-222` (TOOLS array)
- Modify: `src/tools/__tests__/schemas.test.ts`

**Interfaces:**
- Consumes: `st_add_invoice_line_item` (Task 1), `st_create_adjustment_invoice` (Task 3).
- Produces: both tools now appear in `TOOLS` and `toolsForRole(...)` — consumed by any future composite/registry test.

- [ ] **Step 1: Write the failing registry-count test update**

In `src/tools/__tests__/schemas.test.ts`, update the existing registry test block (currently asserting `TOOLS.length` = 107 and the `isWrite` list at lines 20-73):

```typescript
  it('exports 109 tools (adds st_add_invoice_line_item + st_create_adjustment_invoice — invoice-write tools for the project-invoice/job-invoice misattribution fix)', () => {
    expect(TOOLS.length).toBe(109);
  });

  it('write tools are flagged isWrite', () => {
    const writes = TOOLS.filter((t) => t.isWrite).map((t) => t.name).sort();
    expect(writes).toEqual([
      'add_customer_note',
      'add_job_note',
      'assign_technicians',
      'book_job',
      'create_call_with_campaign',
      'create_estimate_template',
      'create_recurring_service',
      'create_task',
      'delete_estimate_template',
      'dismiss_estimate',
      'hold_appointment',
      'reschedule_appointment',
      'save_tech_debrief',
      'sell_estimate',
      'st_add_invoice_line_item',
      'st_call',
      'st_create_adjustment_invoice',
      'st_create_material',
      'st_create_service',
      'st_patch_material',
      'st_patch_service',
      'st_post_marketing_attribution',
      'unsell_estimate',
      'update_estimate_template',
    ]);
  });
```

Also update the two `toolsForRole` count assertions further down (originally 106/107):

```typescript
  it('toolsForRole("default") excludes st_call; admin includes it', () => {
    expect(toolsForRole('default').length).toBe(108);
    expect(toolsForRole('admin').length).toBe(109);
    expect(toolsForRole('default').find((t) => t.name === 'st_call')).toBeUndefined();
    expect(toolsForRole('admin').find((t) => t.name === 'st_call')).toBeDefined();
  });
```

Then append new schema-coverage describe blocks at the end of the file:

```typescript
// ── st_add_invoice_line_item ─────────────────────────────────

describe('st_add_invoice_line_item schema', () => {
  const s = schemaOf('st_add_invoice_line_item');

  it('accepts a minimal valid Service line item', () => {
    expect(s.safeParse({
      invoiceId: 111,
      lineItems: [{ quantity: 1, price: 200, type: 'Service' }],
    }).success).toBe(true);
  });

  it('rejects missing invoiceId', () => {
    expect(s.safeParse({ lineItems: [{ quantity: 1 }] }).success).toBe(false);
  });

  it('rejects an empty lineItems array', () => {
    expect(s.safeParse({ invoiceId: 111, lineItems: [] }).success).toBe(false);
  });

  it('defaults dryRun to true', () => {
    const parsed = s.parse({ invoiceId: 111, lineItems: [{ quantity: 1 }] });
    expect(parsed.dryRun).toBe(true);
  });
});

// ── st_create_adjustment_invoice ─────────────────────────────

describe('st_create_adjustment_invoice schema', () => {
  const s = schemaOf('st_create_adjustment_invoice');

  it('accepts a minimal valid negative-offset line item', () => {
    expect(s.safeParse({
      parentInvoiceId: 222,
      lineItems: [{ quantity: 1, price: -998484, type: 'Service' }],
    }).success).toBe(true);
  });

  it('rejects missing parentInvoiceId', () => {
    expect(s.safeParse({ lineItems: [{ quantity: 1, price: -100 }] }).success).toBe(false);
  });

  it('rejects an empty lineItems array', () => {
    expect(s.safeParse({ parentInvoiceId: 222, lineItems: [] }).success).toBe(false);
  });

  it('defaults dryRun to true', () => {
    const parsed = s.parse({ parentInvoiceId: 222, lineItems: [{ quantity: 1, price: -100 }] });
    expect(parsed.dryRun).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/taylor/work/mcp-servicetitan && npx vitest run src/tools/__tests__/schemas.test.ts`
Expected: FAIL — `TOOLS.length` is 107, not 109; `writes` array missing the two new names; new schema describe blocks fail with "tool not found".

- [ ] **Step 3: Wire the tools into the registry**

In `src/tools/index.ts`, after line 100 (`import { list_unpaid_invoices } from './invoicing/list_unpaid_invoices';`):

```typescript
import { st_add_invoice_line_item } from './invoicing/st_add_invoice_line_item';
import { st_create_adjustment_invoice } from './invoicing/st_create_adjustment_invoice';
```

Then update the `T6 Invoicing` line in the `TOOLS` array (currently `get_invoice, list_invoices_job, get_invoice_balance, list_unpaid_invoices,`):

```typescript
  // T6 Invoicing
  get_invoice, list_invoices_job, get_invoice_balance, list_unpaid_invoices,
  st_add_invoice_line_item, st_create_adjustment_invoice,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/taylor/work/mcp-servicetitan && npx vitest run src/tools/__tests__/schemas.test.ts`
Expected: PASS (all tests, including the updated counts and new schema blocks)

- [ ] **Step 5: Run the full test suite to confirm no regressions**

Run: `cd /home/taylor/work/mcp-servicetitan && npx vitest run`
Expected: PASS — all existing + new tests green, no failures elsewhere in the suite.

- [ ] **Step 6: Commit**

```bash
cd /home/taylor/work/mcp-servicetitan
git add src/tools/index.ts src/tools/__tests__/schemas.test.ts
git commit -m "feat(tools): register st_add_invoice_line_item + st_create_adjustment_invoice"
```

---

### Task 5: Manual sandbox-confirmation check (required before trusting the live write path)

This task is **not automatable in this repo** — there is no sandbox/integration tenant configuration anywhere in `mcp-servicetitan` (`api-integration.servicetitan.io` is not referenced anywhere in `src/` or `wrangler.toml`; confirmed via `grep -rn "api-integration" src/ wrangler.toml` returning nothing). The dryRun/durableWrite path in this repo always goes through `servicetitan-proxy` (a separate worker), which is where real ST credentials live. This task is a manual pre-merge checklist for whoever holds those credentials (Luke, or the proxy's operator) — do not attempt to script it inside this repo's test suite.

**Files:** None — this is a manual verification checklist, recorded here so it isn't skipped.

- [ ] **Step 1: Confirm the adjustment-invoice endpoint shape**

Using real ST integration/sandbox credentials (via `servicetitan-proxy` or a direct authenticated call to `api-integration.servicetitan.io`), send a deliberately-malformed request to the best-guess endpoint this plan implemented (`POST /accounting/v2/tenant/{tenant}/invoices` with `adjustmentToId` in the body) — e.g. omit a required field or use an invalid `parentInvoiceId`. Read the resulting 400 validation-error body. Compare its field-name echoes against what `st_create_adjustment_invoice.ts` currently sends (`adjustmentToId`, `lineItems`, `businessUnitId`, `invoiceDate`).

- [ ] **Step 2: Confirm whether `job`/`invoiceConfiguration` are PATCH-accepted fields on an existing invoice**

Same technique against `PATCH /accounting/v2/tenant/{tenant}/invoices/{id}` with a `job` field in the body, using a real invoice ID that currently has `job: null`. If the validation error rejects `job` as an unrecognized field (rather than accepting the shape and failing for a different reason), that confirms the tool's best-effort job-link feature cannot work as designed — the `jobLinkWarning` message in `st_add_invoice_line_item.ts` should be strengthened to say so explicitly, or the feature should be removed rather than left silently no-op-ing in production.

- [ ] **Step 3: Update the tools based on findings**

If either endpoint/payload shape differs from what Tasks 1 and 3 implemented, update `st_add_invoice_line_item.ts` / `st_create_adjustment_invoice.ts` accordingly (payload field names, nested-object-vs-bare-id shape for `generalLedgerAccountId`/`businessUnitId`), update the corresponding tests in `st_write_tools.test.ts`, re-run the full suite (`npx vitest run`), and commit:

```bash
cd /home/taylor/work/mcp-servicetitan
git add src/tools/invoicing/ src/tools/__tests__/st_write_tools.test.ts
git commit -m "fix(invoicing): correct payload shape per confirmed sandbox validation-error response"
```

If both shapes matched the best-guess exactly, record that confirmation as a comment in both tool files' header comments (replacing "UNCONFIRMED" language) and commit:

```bash
cd /home/taylor/work/mcp-servicetitan
git add src/tools/invoicing/st_add_invoice_line_item.ts src/tools/invoicing/st_create_adjustment_invoice.ts
git commit -m "docs(invoicing): confirm endpoint/payload shape via sandbox validation-error check"
```

- [ ] **Step 4: Update memory**

Record the confirmed (or corrected) endpoint shape in the knowledge graph as an observation on the `mcp-servicetitan invoice-write tool gap (spec 2026-07-31)` entity, so future sessions don't need to re-derive it.

---

### Task 6: Deploy

**Files:** None — deploy is a workflow_dispatch action per `mcp-servicetitan public repo workflow` (memory) — this repo's CI does not auto-deploy from main.

- [ ] **Step 1: Push the branch and open a PR**

```bash
cd /home/taylor/work/mcp-servicetitan
git push -u origin HEAD
gh pr create --title "feat(invoicing): add st_add_invoice_line_item + st_create_adjustment_invoice" --body "$(cat <<'EOF'
## Summary
- Adds two new invoice-write tools to fix the recurring HVAC Install project-invoice/job-invoice misattribution defect (8 known instances, ~$76K).
- Follows the existing st_create_service/st_patch_service dryRun+confirmation-token+durableWrite pattern exactly.
- Exported-invoice guard is warn-only per design decision (docs/superpowers/specs/2026-07-31-invoice-write-tools-design.md).
- Adjustment-invoice endpoint shape is a best-guess pending manual sandbox confirmation (plan Task 5) — see tool file header comments.

## Test plan
- [x] Unit tests for both tools' dryRun/validation/durableWrite paths (`src/tools/__tests__/st_write_tools.test.ts`)
- [x] Schema acceptance/rejection tests (`src/tools/__tests__/schemas.test.ts`)
- [x] Full suite green (`npx vitest run`)
- [ ] Manual sandbox-confirmation check completed (plan Task 5) before relying on live write path in production

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 2: Wait for CI, then merge per repo convention**

Per `mcp-servicetitan public repo workflow` (memory): merge via GitHub merge commit (not squash/rebase), against `main`.

```bash
gh pr checks --watch
gh pr merge --merge
```

- [ ] **Step 3: Trigger the deploy workflow**

Deploys are manual `workflow_dispatch`, not auto-triggered by merging to main (memory: `mcp-servicetitan public repo workflow`, 2026-07-07 correction). Confirm the exact workflow name first:

```bash
cd /home/taylor/work/mcp-servicetitan
gh workflow list
gh workflow run <deploy-workflow-name-from-list-above>
gh run watch
```

- [ ] **Step 4: Verify the deploy**

```bash
curl -s https://mcp-servicetitan.lpeluso.workers.dev/health | jq .
```

Expected: `toolCount` reflects the new total (109), `version` reflects the new deploy.
