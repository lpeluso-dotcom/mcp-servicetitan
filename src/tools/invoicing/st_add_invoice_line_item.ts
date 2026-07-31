// ============================================================
// st_add_invoice_line_item — add or update line item(s) on an existing
// ServiceTitan invoice.
//
// ENDPOINT + BODY SHAPE are now CONFIRMED by live probing of prod tenant
// 431848990 (2026-07-31) — a 400 response leaked the controller signature:
//   InvoicesController.UpdateInvoiceItemsAsync(Int64 invoiceId, InvoiceItemUpdateRequest itemModel)
// i.e.
//   PATCH /accounting/v2/tenant/{tid}/invoices/{invoiceId}/items
// takes a FLAT SINGLE-ITEM object (`InvoiceItemUpdateRequest`) as its body —
// NOT `{ items: [...] }` and NOT an array. ONE item per HTTP call. Adding N
// line items means N sequential PATCH calls to the same endpoint.
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ WIRE CONTRACT — PATCH /accounting/v2/tenant/{tid}/invoices/{id}/items │
// │ ACCEPTED FIELDS (the ONLY ones ST binds):                            │
// │   id, skuId, skuName, description (REQUIRED), quantity (REQUIRED),   │
// │   cost, technicianId, unitPrice                                      │
// │                                                                      │
// │ DANGER: ASP.NET model binding SILENTLY DROPS any field not on that   │
// │ list and still returns HTTP 200. A misspelled or renamed field does  │
// │ not fail — it just doesn't happen. Do NOT add a field here without   │
// │ live-probing it first, and do NOT spread caller input onto the wire; │
// │ the outbound body is built from the explicit allow-list below.       │
// └──────────────────────────────────────────────────────────────────────┘
//
// THE MONETARY FIELD IS `unitPrice`, NOT `price`. Live-probed 2026-07-31.
// `price` is one of the silently-dropped fields: sending it produced a line
// item at $0.00 behind an HTTP 200 that looked like success (real damage:
// item 84402146 on invoice 83052705, since deleted). A prior rebuild of this
// file concluded from an incomplete probe that sell price was simply not
// settable here and removed the field entirely — that was wrong. `unitPrice`
// sets it, and it ACCEPTS NEGATIVE VALUES (that is how an offsetting line is
// expressed; cf. real invoice 84399973, unit price -13674.00 on sku HI1).
// NOTE the read/write asymmetry: on the READ side ST returns that value as
// `price`. The verify-read below reads `price`; the wire body writes
// `unitPrice`.
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ OMITTING unitPrice IS NOT SAFE ON AN APPEND — it lands at $0.00.     │
// │ This is the incident, not a theory: item 84402146 was appended with  │
// │ no monetary field on the wire (`price` having been dropped) and the  │
// │ line landed at $0.00. ServiceTitan does NOT compute Pricebook-Pro    │
// │ dynamic pricing on API-appended invoice items. An append therefore   │
// │ REQUIRES unitPrice and this tool rejects an append without it.       │
// │ Omitting is only meaningful on the UPDATE path (`id` present), where │
// │ the intent is "leave the existing price alone" — and see below, that │
// │ path is UNPROBED.                                                    │
// └──────────────────────────────────────────────────────────────────────┘
//
// UNPROBED — THE UPDATE PATH (`id` present → UpdateInvoiceItemAsync). The
// endpoint binds a whole `InvoiceItemUpdateRequest`; an ASP.NET handler that
// assigns every bound property writes null/0 over an existing value when the
// field is absent from the body. Whether omitting `unitPrice`/`cost` on an
// update leaves them untouched or zeroes them has NOT been live-probed. This
// tool therefore (a) WARNS at dryRun when an update omits them, and (b) makes
// the post-write verify-read compare the item's price/cost against the
// pre-write baseline and raise `amount_mismatch` if ST changed a field the
// caller never sent. Probe it on a throwaway item and record the result here
// to close this out.
//
// Confirmed NOT to exist on this model (silently ignored by ASP.NET model
// binding — no bind error even with an object/array value): price,
// generalLedgerAccountId, businessUnitId, type, itemType, taxable, inventory,
// isChargeable, order, serviceDate, installedEquipmentId, total, memberPrice,
// invoiceId. The line-item schema is `.strict()` so any of these arrives as a
// LOUD validation error instead of being silently stripped — `price` above
// all, since it is the single most likely field an LLM emits here and it is
// what caused the damage.
//
// NOTE THE ASYMMETRY vs. st_create_adjustment_invoice: THIS endpoint accepts
// `skuId`. The adjustment endpoint's items[] does NOT — it resolves lines by
// `skuName` only. The two item shapes are deliberately not shared.
//
// JOB-LINK REASSIGNMENT VIA THE API IS CONFIRMED IMPOSSIBLE. The parent
// invoice update endpoint, PATCH /accounting/v2/tenant/{tid}/invoices/{id},
// was also probed live: its update model contains ONLY `summary`, `dueDate`,
// `reviewStatus`. Fields like `job`, `jobId`, `invoiceConfiguration`,
// `businessUnitId`, `customerId` are NOT in that model — ST silently ignores
// them and returns HTTP 200 while doing nothing. There is therefore no API
// path to move an invoice onto a different job after creation. This tool
// dropped the jobId arg, the job lookup, the cross-customer check, and the
// second PATCH call entirely rather than ship a feature that reports success
// while silently no-op'ing. Callers need an invoice that is ALREADY linked
// to the target job.
//
// ONE THING REMAINS UNCONFIRMED about append: whether omitting `id` APPENDS a
// new line item was inferred from the field being nullable, then borne out in
// practice (item 84402146 was in fact appended). It stays reversible: ST
// exposes DELETE /accounting/v2/tenant/{tid}/invoices/{invoiceId}/items/{itemId}
// for cleanup.
//
// F3: dryRun=true (default) → confirmation_token → dryRun=false → N
// sequential live calls over /api/st/write (NOT durableWrite — the
// durable-write proxy only maps 4 pricebook operations; there is no
// proxy-side mapping for invoice line items, so that path would 404/no-op
// silently) → POST-WRITE VERIFY-READ (invoice-verify.ts). HTTP 200 from the
// proxy is NOT evidence the money landed; the re-read is.
// ============================================================

import { z } from 'zod';
import { McpError } from '../../errors';
import { WriteGate } from '../../write-gate';
import { readST } from '../../st';
import { rewriteTenantPlaceholders } from '../../tenant';
import {
  extractEntityId,
  intendedAmount,
  itemAmount,
  itemPrice,
  moneyEquals,
  proxyEnvelopeError,
  reReadInvoiceForVerify,
  type VerifyInvoiceItem,
} from './invoice-verify';
import type { ToolDef } from '../index';
import type { Env } from '../../env';

export interface InvoiceLineItemInput {
  id?: number;
  skuId?: number;
  skuName?: string;
  description: string;
  quantity: number;
  cost?: number;
  technicianId?: number;
  unitPrice?: number;
}

// Explicit allow-list of the fields ST actually binds on InvoiceItemUpdateRequest.
// The outbound body is BUILT from this list rather than spread from caller
// input, so a renamed/misspelled/extra field can never ride onto the wire and
// get silently dropped behind an HTTP 200. Adding a name here is a claim that
// it was live-probed.
// The `keyof` annotation is the cheap fail-loudly mechanism: renaming a field
// on InvoiceLineItemInput without updating this list is a COMPILE error, not a
// silent HTTP 200 that writes nothing.
const ST_INVOICE_ITEM_FIELDS: readonly (keyof InvoiceLineItemInput)[] = [
  'id', 'skuId', 'skuName', 'description', 'quantity', 'cost', 'technicianId', 'unitPrice',
];

// Deletion guard: `keyof` above catches RENAMES but not DELETIONS — removing a
// name from the list still typechecks and silently stops sending that field
// (the same silent-no-op class). This makes a deletion a compile error too.
type _ItemFieldsComplete =
  Exclude<keyof InvoiceLineItemInput, (typeof ST_INVOICE_ITEM_FIELDS)[number]> extends never ? true : never;
const _itemFieldsComplete: _ItemFieldsComplete = true;
void _itemFieldsComplete;

function toStInvoiceItemPayload(item: InvoiceLineItemInput): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of ST_INVOICE_ITEM_FIELDS) {
    const value = item[field];
    if (value !== undefined) out[field] = value;
  }
  return out;
}

interface Args {
  invoiceId: number;
  lineItems: InvoiceLineItemInput[];
  dryRun?: boolean;
  confirmation_token?: string;
}

// .strict(): an unknown key is a LOUD validation error, not a silent strip.
// `price` is the field an LLM reaches for by reflex (every pricebook tool in
// this repo uses it) and it is exactly what wrote the $0.00 line — accepting
// an input ST will silently drop is the pattern this file exists to repair.
const lineItemSchema = z.object({
  id: z.number().int().positive().optional().describe(
    'Existing ST invoice-item ID to UPDATE. Omit to APPEND a new line item (append requires skuId/skuName AND unitPrice).'
  ),
  skuId: z.number().int().positive().optional().describe('Pricebook SKU ID for this line item (accepted here; NOT accepted by the adjustment endpoint)'),
  skuName: z.string().min(1).optional().describe('SKU display name/code (empty string is rejected — ST would 500 mid-sequence on it)'),
  description: z.string().min(1).describe('Line item description (required by the ST update model)'),
  quantity: z.number().positive().describe('Line item quantity (required by the ST update model)'),
  cost: z.number().optional().describe('Line item cost basis (not the sell price — see unitPrice)'),
  technicianId: z.number().int().positive().optional().describe('Technician ID to attribute this line item to'),
  unitPrice: z.number().optional().describe(
    'Sell price per unit — THE monetary field on this endpoint. ServiceTitan silently IGNORES a field named ' +
    '`price` (it returns HTTP 200 and writes a $0.00 line), so unitPrice is the only way to set the amount. ' +
    'NEGATIVE values are allowed and are how an offsetting/credit line is expressed. REQUIRED when appending ' +
    '(no `id`): ST does NOT compute dynamic pricing on API-appended items, so an append without unitPrice lands ' +
    'at $0.00 — that is the confirmed incident behavior, and this tool rejects it. On an UPDATE (`id` present) ' +
    'you may omit it to leave the existing price alone, but that is UNPROBED — ST may bind the omitted field as ' +
    'null and zero the line; the tool warns at dryRun and the post-write verify-read raises amount_mismatch if ' +
    'the price moved.'
  ),
  // TOMBSTONE. `price` is declared only so it can be REJECTED with a message
  // that names the replacement. Left undeclared it would still be rejected by
  // .strict(), but with an opaque "unrecognized key" error — and `price` is
  // the one field an LLM emits here by reflex (every pricebook tool in this
  // repo uses that name) and the one that wrote the $0.00 line.
  price: z.any().optional().refine((v) => v === undefined, {
    message:
      '`price` is NOT a field on ServiceTitan\'s InvoiceItemUpdateRequest — ST silently drops it and writes a $0.00 line behind an HTTP 200 (real damage: item 84402146 on invoice 83052705). Use `unitPrice` instead.',
  }),
}).strict();

interface RawInvoice {
  id?: number;
  syncStatus?: string;
  customer?: { id?: number };
  items?: VerifyInvoiceItem[] | null;
  [key: string]: unknown;
}

/**
 * Validates the line items and returns any non-blocking warnings.
 * Blocking rules (validation_error):
 *   - at least one line item
 *   - APPEND (no `id`) needs skuId or skuName — ST 500s "Sku (Name:) is not found." otherwise
 *   - APPEND needs unitPrice — no dynamic pricing on API-appended items → $0.00 line
 * Warning rules (surfaced in the dryRun result, not blocking):
 *   - UPDATE omitting unitPrice / cost — unprobed null-overwrite risk
 */
function validateLineItems(lineItems: InvoiceLineItemInput[], correlation: string): string[] {
  if (!lineItems || lineItems.length === 0) {
    throw new McpError('validation_error', 'st_add_invoice_line_item requires at least one line item', { correlation });
  }
  const warnings: string[] = [];
  // CONFIRMED by live probe 2026-07-31 (invoice 82555119): omitting `id` routes
  // to ST's UpdateInvoiceItemHandler.CreateInvoiceItemAsync — the append path —
  // which requires a SKU to resolve the item. Without skuId/skuName ST returns
  // HTTP 500 "Sku (Name:) is not found." Reject locally rather than let a 500
  // through; an item WITH `id` is an update and needs no sku.
  for (const [i, item] of lineItems.entries()) {
    const isAppend = item.id === undefined;
    if (isAppend && item.skuId === undefined && item.skuName === undefined) {
      throw new McpError(
        'validation_error',
        `lineItems[${i}]: appending a new invoice item (no \`id\`) requires skuId or skuName — ST resolves the item by SKU and returns 500 "Sku (Name:) is not found." otherwise. Pass \`id\` instead to update an existing item.`,
        { correlation }
      );
    }
    // CONFIRMED by incident 2026-07-31 (item 84402146 on invoice 83052705):
    // an API-appended item with no monetary field on the wire lands at $0.00.
    // ST does not run Pricebook Pro dynamic pricing on API-appended items, so
    // "omit it and let ST price it" is false for this path — it is how the
    // $0.00 line got written behind an HTTP 200.
    if (isAppend && item.unitPrice === undefined) {
      throw new McpError(
        'validation_error',
        `lineItems[${i}]: appending a new invoice item (no \`id\`) requires unitPrice — ServiceTitan does NOT apply dynamic pricing to API-appended items, so an append without unitPrice lands at $0.00 behind an HTTP 200 (confirmed: item 84402146 on invoice 83052705). Pass the explicit dollar amount (negative is allowed for offsetting lines).`,
        { correlation }
      );
    }
    if (!isAppend && item.unitPrice === undefined) {
      warnings.push(
        `lineItems[${i}]: updating item ${item.id} without unitPrice. ST's update model binding is UNPROBED on this point — an omitted field may bind as null and ZERO an existing priced line. The post-write verify-read compares the item's price against its pre-write value and fails with amount_mismatch if ST changed it, but the change would already be written. Restate unitPrice to be sure.`
      );
    }
    if (!isAppend && item.cost === undefined) {
      warnings.push(
        `lineItems[${i}]: updating item ${item.id} without cost — same unprobed null-overwrite risk as unitPrice (verify-read checks it against the pre-write value).`
      );
    }
  }
  return warnings;
}

// Sends a single ST write call via the servicetitan-proxy /api/st/write path
// (the raw {endpoint, method, payload} path — see write-tool-factory.ts /
// assign_technicians.ts precedent). Not durableWrite: there is no proxy-side
// operation mapping for invoice writes.
async function stWrite(
  env: Env,
  ctx: { actor: string; correlation: string },
  endpoint: string,
  method: string,
  payload: unknown
): Promise<Response> {
  return env.ST_PROXY.fetch('https://servicetitan-proxy/api/st/write', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-sync-key': env.MCP_SYNC_KEY,
      'x-correlation-id': ctx.correlation,
      'x-actor': ctx.actor,
    },
    body: JSON.stringify({ endpoint, method, payload }),
  });
}

/** Index a read-side items array by item id. */
function indexItems(items: VerifyInvoiceItem[] | null | undefined): Map<number, VerifyInvoiceItem> {
  const map = new Map<number, VerifyInvoiceItem>();
  for (const item of items ?? []) {
    const id = Number(item.id);
    if (Number.isFinite(id)) map.set(id, item);
  }
  return map;
}

export const st_add_invoice_line_item: ToolDef<Args> = {
  name: 'st_add_invoice_line_item',
  description:
    'Add or update line item(s) on an existing ServiceTitan invoice. dryRun=true (default) validates and returns a ' +
    'confirmation_token — call again with dryRun=false + token to write. Executes as N sequential PATCH calls, ONE per ' +
    'line item (the confirmed ST update model takes a single flat item per call, not an array or {items:[...]}). All N ' +
    'calls are shown in the dryRun preview. Job-link reassignment is NOT possible via this or any ST API — the invoice ' +
    'update model only has summary/dueDate/reviewStatus — so this tool requires an invoice that is already linked to the ' +
    'target job; there is no jobId argument. Set the dollar amount with `unitPrice` — ServiceTitan silently ignores a ' +
    'field named `price` and would write a $0.00 line behind an HTTP 200; negative unitPrice is allowed for offsetting ' +
    'lines. unitPrice is REQUIRED when appending (no `id`): ST does NOT apply dynamic pricing to API-appended items, so ' +
    'an append without it lands at $0.00 (confirmed incident). On an update (`id` present) it may be omitted to leave ' +
    'the price alone, which warns — that binding behavior is unprobed. Unknown fields are rejected, not stripped. After ' +
    'a live write the tool RE-READS the invoice and asserts the money landed (silent_noop / amount_mismatch / ' +
    'verify_unavailable) — HTTP 200 is not proof. Exported invoices are NOT blocked (warn only) — no accounting ' +
    'sign-off exists yet for a hard block; review the dryRun warning before confirming. If item k of N fails ' +
    'mid-sequence, prior items are already written and NOT rolled back — the error names their item ids for cleanup.',
  isWrite: true,
  stEndpoint: { method: 'PATCH', path: '/accounting/v2/tenant/{tid}/invoices/{invoiceId}/items', source: 'live' },
  zodSchema: {
    invoiceId: z.number().int().positive().describe('ST invoice ID to modify'),
    lineItems: z.array(lineItemSchema).min(1).describe('Line items to add/update on the invoice — one PATCH call is issued per item'),
    dryRun: z.boolean().default(true).describe('true (default) = preview + token; false = execute write'),
    confirmation_token: z.string().optional().describe('Token from prior dryRun=true call, required when dryRun=false'),
  },
  async handler(env, args, { actor, correlation }) {
    const { invoiceId, lineItems, dryRun = true, confirmation_token } = args;
    const itemWarnings = validateLineItems(lineItems, correlation);

    const tenant = env.ST_TENANT_ID;
    const invoiceData = await readST<{ data?: RawInvoice[] }>(
      env, { actor, correlation },
      `/accounting/v2/tenant/${tenant}/invoices`,
      { ids: invoiceId },
    );
    const invoice = invoiceData.data?.[0];
    if (!invoice) throw new McpError('not_found', `invoice ${invoiceId} not found`, { correlation });
    // Guard: this endpoint has a documented history of silently ignoring
    // params (see balanceExcludeZero in list_unpaid_invoices). If ST ever
    // ignores `ids`, data[0] would be an arbitrary invoice — fail loudly
    // instead of writing to the wrong invoice.
    if (Number(invoice.id) !== invoiceId)
      throw new McpError('upstream_error', `ids filter not honored: asked ${invoiceId}, got ${invoice.id}`, { correlation });

    let exportWarning: string | undefined;
    if (invoice.syncStatus === 'Exported') {
      exportWarning = `invoice ${invoiceId} has syncStatus=Exported — writing to it may not reflect correctly in accounting. Consider st_create_adjustment_invoice instead. Proceeding anyway per warn-only policy.`;
    }

    const itemsEndpoint = `/accounting/v2/tenant/000000000/invoices/${invoiceId}/items`;

    // Build the outbound bodies ONCE, from the allow-list, and reuse the exact
    // same objects for both the preview and the live calls — what's approved is
    // literally what runs, and nothing outside the confirmed field set can leak
    // onto the wire to be silently dropped by ST.
    const itemPayloads = lineItems.map(toStInvoiceItemPayload);

    // dryRun preview lists ALL N calls as a compound payload, mirroring
    // assign_technicians — what's approved must match what runs, INCLUDING the
    // endpoint: the preview shows the tenant-resolved URL, not the 000000000
    // placeholder, so the approved steps literally match the executed calls.
    const previewEndpoint = rewriteTenantPlaceholders(env, itemsEndpoint);
    const compoundPayload = {
      steps: itemPayloads.map((payload, i) => ({
        call: i + 1,
        endpoint: previewEndpoint,
        method: 'PATCH',
        payload,
      })),
    };

    // TOCTOU guard: fold read-derived state into the hashed args so a material
    // change between the dryRun preview and the confirm call (e.g. the invoice
    // becomes Exported) invalidates the token via the existing "args changed
    // since dryRun" path in WriteGate.verifyToken — instead of silently
    // executing a write that differs from what was approved.
    // `wireContract` pins the args→wire transformation VERSION into the hash so
    // a token minted by a different deployed payload-construction cannot cross
    // a deploy boundary and execute a body the human never previewed (hashArgs
    // drops undefined values, so arg-shape drift alone is hash-invisible).
    // Bump this string any time the outbound payload construction changes.
    const businessArgs = {
      wireContract: 'items-patch-unitprice-v2-2026-07-31',
      invoiceId, lineItems, syncStatus: invoice.syncStatus,
    };
    const gate = new WriteGate(env);

    if (dryRun) {
      const result = await gate.dryRun(
        'st_add_invoice_line_item', businessArgs, actor, correlation,
        compoundPayload, itemsEndpoint, 'PATCH', 15 * 60 * 1000
      );
      return { ...result, warnings: [...(exportWarning ? [exportWarning] : []), ...itemWarnings] };
    }
    if (!confirmation_token) {
      throw new McpError('validation_error', 'confirmation_token required when dryRun=false', { correlation });
    }
    await gate.verifyToken('st_add_invoice_line_item', businessArgs, actor, confirmation_token);

    // BASELINE, taken from the read immediately above (i.e. inside the confirm
    // call, not at dryRun time): the item ids and money already on the invoice.
    // Verification is by DELTA against this, never by "an item with this SKU
    // exists" — invoice 83052705 already carries an inert $0 HI1 line, so a
    // SKU-presence check would false-positive.
    const baseline = indexItems(invoice.items);
    const baselineIds = new Set(baseline.keys());

    // N sequential calls, one flat item per call. Partial failure is a real,
    // must-report state: ST does not offer a batch/transactional endpoint here,
    // so items 1..k-1 are already written by the time item k fails, and there
    // is no rollback.
    const resolvedEndpoint = rewriteTenantPlaceholders(env, itemsEndpoint);
    const results: unknown[] = [];
    const writtenItemIds: number[] = [];
    for (let i = 0; i < itemPayloads.length; i++) {
      const resp = await stWrite(env, { actor, correlation }, resolvedEndpoint, 'PATCH', itemPayloads[i]);
      const body = resp.ok ? await resp.json().catch(() => null) : null;
      // A 200 carrying an {ok:false} envelope is a failure the status code
      // does not show — the proxy's status is not ServiceTitan's outcome.
      const envelopeError = resp.ok ? proxyEnvelopeError(body) : undefined;
      if (!resp.ok || envelopeError) {
        const succeeded = i;
        // Finding-4 fix: the ids of the items already written are the whole
        // point of the cleanup instruction. They were being dropped on the
        // floor here, leaving the operator to hunt for them in the ST UI.
        const known = writtenItemIds.length
          ? `Already-written item ids: ${writtenItemIds.join(', ')}. `
          : `ServiceTitan returned no item id for the already-written item${succeeded === 1 ? '' : 's'} — find them by comparing the invoice against baseline item ids [${[...baselineIds].join(', ') || 'none'}]. `;
        throw new McpError(
          'upstream_error',
          `st_add_invoice_line_item: item ${i + 1} of ${lineItems.length} failed (${envelopeError ?? resp.status}) on invoice ${invoiceId}. ` +
          `${succeeded} item${succeeded === 1 ? '' : 's'} already succeeded before the failure and ${succeeded === 1 ? 'is' : 'are'} ` +
          `ALREADY WRITTEN to the invoice — they are NOT rolled back. The invoice is now in a partially-updated state. ` +
          `${known}` +
          `To manually clean up an already-written item, use DELETE /accounting/v2/tenant/${tenant}/invoices/${invoiceId}/items/{itemId}.`,
          {
            correlation,
            details: {
              invoiceId,
              failedAtCall: i + 1,
              itemsAttempted: lineItems.length,
              itemsWritten: succeeded,
              writtenItemIds,
              baselineItemIds: [...baselineIds],
              results,
              deleteEndpoint: `/accounting/v2/tenant/${tenant}/invoices/${invoiceId}/items/{itemId}`,
            },
          }
        );
      }
      results.push(body);
      const writtenId = extractEntityId(body);
      if (writtenId !== undefined) writtenItemIds.push(writtenId);
    }

    // ── POST-WRITE VERIFY-READ ────────────────────────────────
    // Everything above proves the proxy answered 200. Nothing above proves
    // ServiceTitan persisted a dollar. Re-read and assert.
    const appends = lineItems.filter((li) => li.id === undefined);
    const updates = lineItems.filter((li) => li.id !== undefined);
    const stranded =
      `All ${lineItems.length} PATCH call(s) were sent against invoice ${invoiceId}` +
      (writtenItemIds.length ? ` (item ids returned by ST: ${writtenItemIds.join(', ')})` : '') +
      `; ${appends.length} append(s), ${updates.length} update(s).`;

    const post = await reReadInvoiceForVerify(env, { actor, correlation }, tenant, invoiceId, {
      tool: 'st_add_invoice_line_item',
      stranded,
    });

    // `items` absent entirely → the read carried no line items and nothing can
    // be concluded. That is verify_unavailable, NOT silent_noop.
    if (!Array.isArray(post.items)) {
      throw new McpError(
        'verify_unavailable',
        `st_add_invoice_line_item: the write was sent but the verify-read of invoice ${invoiceId} returned no items array (items=${JSON.stringify(post.items ?? null)}), so the monetary effect could not be confirmed. ${stranded} Check the invoice in ServiceTitan before re-running — a retry would duplicate the lines.`,
        { correlation, details: { invoiceId, writtenItemIds, results } },
      );
    }

    const postIndex = indexItems(post.items);
    const newItems = post.items.filter((it) => {
      const id = Number(it.id);
      return Number.isFinite(id) && !baselineIds.has(id);
    });
    const appendedItemIds = newItems.map((it) => Number(it.id));

    if (appends.length > 0 && newItems.length === 0) {
      throw new McpError(
        'silent_noop',
        `st_add_invoice_line_item: ${appends.length} line item(s) were PATCHed onto invoice ${invoiceId} and ServiceTitan answered HTTP 200, but the verify-read shows NO new items on the invoice — the write was a silent no-op. ${stranded} Nothing was rolled back and nothing landed; do not retry blindly, inspect the invoice first.`,
        { correlation, details: { invoiceId, baselineItemIds: [...baselineIds], postItemIds: [...postIndex.keys()], results } },
      );
    }
    if (newItems.length !== appends.length) {
      throw new McpError(
        'silent_noop',
        `st_add_invoice_line_item: expected ${appends.length} new line item(s) on invoice ${invoiceId} after the write, but the verify-read shows ${newItems.length} (ids: ${appendedItemIds.join(', ') || 'none'}). The invoice is not in the intended state. ${stranded}`,
        { correlation, details: { invoiceId, appendedItemIds, baselineItemIds: [...baselineIds], results } },
      );
    }

    // Money check on the appended lines: what ST persisted vs what was sent.
    const expectedAppendTotal = appends.reduce((sum, li) => sum + intendedAmount(li), 0);
    const actualAppendTotal = newItems.reduce((sum, it) => sum + itemAmount(it), 0);
    if (!moneyEquals(expectedAppendTotal, actualAppendTotal)) {
      throw new McpError(
        'amount_mismatch',
        `st_add_invoice_line_item: the line(s) landed on invoice ${invoiceId} but the money is wrong — sent ${expectedAppendTotal}, ServiceTitan persisted ${actualAppendTotal} (item ids ${appendedItemIds.join(', ')}). QSC runs Pricebook Pro dynamic pricing, so ST may have recomputed or zeroed the submitted unitPrice. The items EXIST and are NOT rolled back — fix or delete them (DELETE /accounting/v2/tenant/${tenant}/invoices/${invoiceId}/items/{itemId}), do not re-append.`,
        { correlation, details: { invoiceId, appendedItemIds, expected: expectedAppendTotal, actual: actualAppendTotal, results } },
      );
    }

    // Update path: locate each item by id and compare what was sent. For a
    // field that was NOT sent, compare against the pre-write baseline — that
    // is how an unprobed null-overwrite (the update model zeroing an omitted
    // unitPrice/cost) gets caught instead of shipping as success.
    const updatedItemIds: number[] = [];
    for (const li of updates) {
      const id = li.id as number;
      const after = postIndex.get(id);
      if (!after) {
        throw new McpError(
          'silent_noop',
          `st_add_invoice_line_item: item ${id} was PATCHed on invoice ${invoiceId} (HTTP 200) but is not present in the verify-read of that invoice. ${stranded}`,
          { correlation, details: { invoiceId, itemId: id, postItemIds: [...postIndex.keys()], results } },
        );
      }
      updatedItemIds.push(id);
      const before = baseline.get(id);

      if (li.unitPrice !== undefined) {
        const actual = itemPrice(after);
        if (actual === undefined || !moneyEquals(actual, li.unitPrice)) {
          throw new McpError(
            'amount_mismatch',
            `st_add_invoice_line_item: item ${id} on invoice ${invoiceId} was updated with unitPrice ${li.unitPrice} but the verify-read shows price ${actual ?? 'none'}. ServiceTitan did not honor the submitted amount.`,
            { correlation, details: { invoiceId, itemId: id, expected: li.unitPrice, actual } },
          );
        }
      } else if (before !== undefined) {
        // unitPrice was NOT sent: ST must have left it alone.
        const beforePrice = itemPrice(before);
        const afterPrice = itemPrice(after);
        if (beforePrice !== undefined && (afterPrice === undefined || !moneyEquals(beforePrice, afterPrice))) {
          throw new McpError(
            'amount_mismatch',
            `st_add_invoice_line_item: item ${id} on invoice ${invoiceId} was updated WITHOUT unitPrice, and ServiceTitan changed the price anyway — ${beforePrice} before, ${afterPrice ?? 'none'} after. This is the unprobed update-model null-overwrite: an omitted field bound as null. The change is already written — restore the price with an explicit unitPrice.`,
            { correlation, details: { invoiceId, itemId: id, before: beforePrice, after: afterPrice } },
          );
        }
      }

      if (li.cost === undefined && before !== undefined) {
        const beforeCost = typeof before.cost === 'number' ? before.cost : undefined;
        const afterCost = typeof after.cost === 'number' ? after.cost : undefined;
        if (beforeCost !== undefined && (afterCost === undefined || !moneyEquals(beforeCost, afterCost))) {
          throw new McpError(
            'amount_mismatch',
            `st_add_invoice_line_item: item ${id} on invoice ${invoiceId} was updated WITHOUT cost, and ServiceTitan changed the cost anyway — ${beforeCost} before, ${afterCost ?? 'none'} after (unprobed update-model null-overwrite). Restore it with an explicit cost.`,
            { correlation, details: { invoiceId, itemId: id, before: beforeCost, after: afterCost } },
          );
        }
      }
    }

    return {
      dryRun: false,
      tool: 'st_add_invoice_line_item',
      verified: true,
      result: {
        itemsWritten: lineItems.length,
        appendedItemIds,
        updatedItemIds,
        expectedAppendedAmount: expectedAppendTotal,
        actualAppendedAmount: actualAppendTotal,
        invoiceSubTotal: post.subTotal,
        invoiceTotal: post.total,
        results,
      },
      warnings: [...(exportWarning ? [exportWarning] : []), ...itemWarnings],
      correlation,
    };
  },
};
