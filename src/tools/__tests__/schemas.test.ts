// ============================================================
// Schema validation tests for all 12 F1 tools.
// Verifies each tool's Zod raw shape accepts canonical valid input
// and rejects obvious violations (missing required, wrong type).
// ============================================================

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { TOOLS, toolsForRole } from '../index';

function schemaOf(name: string) {
  const t = TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`tool not found: ${name}`);
  return z.object(t.zodSchema);
}

// ── Registry sanity ──────────────────────────────────────────

describe('tool registry', () => {
  it('exports 110 tools (adds titan_advisor_score — Titan Advisor adoption score over the Woz gold snapshots)', () => {
    expect(TOOLS.length).toBe(110);
  });

  it('every tool has name + description + zodSchema', () => {
    for (const t of TOOLS) {
      expect(typeof t.name).toBe('string');
      expect(t.name.length).toBeGreaterThan(2);
      expect(typeof t.description).toBe('string');
      expect(t.description.length).toBeGreaterThan(10);
      expect(t.zodSchema).toBeTruthy();
      expect(typeof t.zodSchema).toBe('object');
    }
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

  it('st_call is the only adminOnly tool', () => {
    const adminOnly = TOOLS.filter((t) => t.adminOnly).map((t) => t.name);
    expect(adminOnly).toEqual(['st_call']);
  });

  it('toolsForRole("default") excludes st_call; admin includes it', () => {
    expect(toolsForRole('default').length).toBe(109);
    expect(toolsForRole('admin').length).toBe(110);
    expect(toolsForRole('default').find((t) => t.name === 'st_call')).toBeUndefined();
    expect(toolsForRole('admin').find((t) => t.name === 'st_call')).toBeDefined();
  });
});

// ── st_list_customers ────────────────────────────────────────

describe('st_list_customers schema', () => {
  const s = schemaOf('st_list_customers');

  it('accepts empty args', () => {
    expect(s.safeParse({}).success).toBe(true);
  });

  it('accepts pagination', () => {
    expect(s.safeParse({ page: 2, pageSize: 100 }).success).toBe(true);
  });

  it('rejects pageSize over 200', () => {
    expect(s.safeParse({ pageSize: 500 }).success).toBe(false);
  });

  it('rejects non-positive page', () => {
    expect(s.safeParse({ page: 0 }).success).toBe(false);
    expect(s.safeParse({ page: -1 }).success).toBe(false);
  });
});

// ── st_get_customer ──────────────────────────────────────────

describe('st_get_customer schema', () => {
  const s = schemaOf('st_get_customer');

  it('requires customerId', () => {
    expect(s.safeParse({}).success).toBe(false);
  });

  it('accepts a positive integer customerId', () => {
    expect(s.safeParse({ customerId: 12345 }).success).toBe(true);
  });

  it('rejects non-numeric customerId', () => {
    expect(s.safeParse({ customerId: 'abc' }).success).toBe(false);
  });
});

// ── st_list_jobs ─────────────────────────────────────────────

describe('st_list_jobs schema', () => {
  const s = schemaOf('st_list_jobs');

  it('accepts empty args', () => {
    expect(s.safeParse({}).success).toBe(true);
  });

  it('accepts full filter set', () => {
    expect(
      s.safeParse({
        page: 1,
        pageSize: 50,
        customerId: 123,
        jobStatus: 'Scheduled',
        modifiedOnOrAfter: '2026-04-22T00:00:00Z',
      }).success
    ).toBe(true);
  });
});

// ── st_list_appointments ─────────────────────────────────────

describe('st_list_appointments schema', () => {
  const s = schemaOf('st_list_appointments');

  it('accepts start-window filters', () => {
    expect(
      s.safeParse({ startsOnOrAfter: '2026-04-22', startsBefore: '2026-04-23', technicianId: 99 }).success
    ).toBe(true);
  });
});

// ── st_get_pricebook ─────────────────────────────────────────

describe('st_get_pricebook schema', () => {
  const s = schemaOf('st_get_pricebook');

  it('requires assetType', () => {
    expect(s.safeParse({}).success).toBe(false);
  });

  it('accepts services | materials | equipment', () => {
    for (const a of ['services', 'materials', 'equipment']) {
      expect(s.safeParse({ assetType: a }).success).toBe(true);
    }
  });

  it('rejects unknown assetType', () => {
    expect(s.safeParse({ assetType: 'bogus' }).success).toBe(false);
  });
});

// ── st_patch_service ─────────────────────────────────────────

describe('st_patch_service schema', () => {
  const s = schemaOf('st_patch_service');

  it('requires id', () => {
    expect(s.safeParse({}).success).toBe(false);
  });

  it('accepts id + partial updates', () => {
    expect(s.safeParse({ id: 100, cost: 50, useStaticPrice: false }).success).toBe(true);
  });
});

// ── st_create_service ────────────────────────────────────────

describe('st_create_service schema', () => {
  const s = schemaOf('st_create_service');

  it('requires name (categoryId-or-categories enforced in handler, not Zod)', () => {
    expect(s.safeParse({}).success).toBe(false);
    expect(s.safeParse({ categoryId: 1 }).success).toBe(false);
    // name-only passes Zod; handler enforces categoryId-or-categories
    expect(s.safeParse({ name: 'X' }).success).toBe(true);
  });

  it('accepts minimal create payload', () => {
    expect(s.safeParse({ name: 'New Service', categoryId: 5 }).success).toBe(true);
  });

  it('accepts multi-cat create payload', () => {
    expect(s.safeParse({ name: 'New Service', categories: [5, 7] }).success).toBe(true);
  });

  it('rejects empty name', () => {
    expect(s.safeParse({ name: '', categoryId: 5 }).success).toBe(false);
  });

  it('accepts new v1.7.0 fields', () => {
    const r = s.safeParse({
      name: 'Lab Fee', categories: [1, 2],
      hours: 0.5, isLabor: true, taxable: true, account: 'Revenue',
      paysCommission: false, memberPrice: 89, useStaticPrices: true, price: 89,
    });
    expect(r.success).toBe(true);
  });

  it('rejects singular useStaticPrice (removed in v1.7.0)', () => {
    // Zod strips unknown keys by default; this test documents the rename.
    // The transform layer also strips it as belt-and-suspenders.
    const r: any = s.safeParse({ name: 'X', categoryId: 5, useStaticPrice: true });
    expect(r.success).toBe(true);
    expect(r.data).not.toHaveProperty('useStaticPrice');
  });
});

// ── st_patch_material ────────────────────────────────────────

describe('st_patch_material schema', () => {
  const s = schemaOf('st_patch_material');

  it('requires id', () => {
    expect(s.safeParse({}).success).toBe(false);
  });

  it('accepts id + partial updates', () => {
    expect(s.safeParse({ id: 200, cost: 12.5, unitOfMeasure: 'Each' }).success).toBe(true);
  });
});

// ── st_create_material ───────────────────────────────────────

describe('st_create_material schema', () => {
  const s = schemaOf('st_create_material');

  it('requires name and categoryId', () => {
    expect(s.safeParse({}).success).toBe(false);
  });

  it('accepts minimal create payload', () => {
    expect(s.safeParse({ name: 'R-22', categoryId: 10 }).success).toBe(true);
  });

  it('accepts a nested primaryVendor', () => {
    expect(s.safeParse({ name: 'R-22', categoryId: 10, primaryVendor: { vendorId: 555 } }).success).toBe(true);
  });

  it('accepts flat primaryVendorId shorthand', () => {
    expect(s.safeParse({ name: 'R-22', categoryId: 10, primaryVendorId: 555, primaryVendorCost: 9.5 }).success).toBe(true);
  });

  it('rejects a non-positive vendorId', () => {
    expect(s.safeParse({ name: 'R-22', categoryId: 10, primaryVendor: { vendorId: 0 } }).success).toBe(false);
  });
});

// ── siro_list_mobile_events ──────────────────────────────────

describe('siro_list_mobile_events schema', () => {
  const s = schemaOf('siro_list_mobile_events');

  it('accepts empty args', () => {
    expect(s.safeParse({}).success).toBe(true);
  });

  it('caps pageSize at 100 per Siro docs', () => {
    expect(s.safeParse({ pageSize: 100 }).success).toBe(true);
    expect(s.safeParse({ pageSize: 101 }).success).toBe(false);
  });
});

// ── siro_get_recording_summary ───────────────────────────────

describe('siro_get_recording_summary schema', () => {
  const s = schemaOf('siro_get_recording_summary');

  it('requires recordingId', () => {
    expect(s.safeParse({}).success).toBe(false);
  });

  it('rejects empty recordingId', () => {
    expect(s.safeParse({ recordingId: '' }).success).toBe(false);
  });

  it('accepts a non-empty string', () => {
    expect(s.safeParse({ recordingId: 'rec-123' }).success).toBe(true);
  });
});

// ── siro_get_engagement ──────────────────────────────────────

describe('siro_get_engagement schema', () => {
  const s = schemaOf('siro_get_engagement');

  it('requires engagementId', () => {
    expect(s.safeParse({}).success).toBe(false);
  });

  it('accepts a non-empty string', () => {
    expect(s.safeParse({ engagementId: 'eng-xyz' }).success).toBe(true);
  });
});

// ── st_add_invoice_line_item ─────────────────────────────────
// Schema rewritten 2026-07-31 to the CONFIRMED InvoiceItemUpdateRequest
// field set (live-probed). description + quantity are required; price,
// generalLedgerAccountId, businessUnitId, and type no longer exist on the
// real ST model and are gone from this schema too.

describe('st_add_invoice_line_item schema', () => {
  const s = schemaOf('st_add_invoice_line_item');

  it('accepts a minimal valid line item (description + quantity only)', () => {
    expect(s.safeParse({
      invoiceId: 111,
      lineItems: [{ description: 'Service call diagnostic', quantity: 1 }],
    }).success).toBe(true);
  });

  it('accepts the full confirmed field set (including unitPrice — the real monetary field)', () => {
    expect(s.safeParse({
      invoiceId: 111,
      lineItems: [{
        id: 55, skuId: 1, skuName: 'Diagnostic Fee', description: 'Diagnostic Fee',
        quantity: 1, cost: 45, technicianId: 9, unitPrice: 89,
      }],
    }).success).toBe(true);
  });

  it('accepts a NEGATIVE unitPrice (offsetting lines are expressed as negative unitPrice)', () => {
    const r: any = s.safeParse({
      invoiceId: 111,
      lineItems: [{ skuName: 'HI1', description: 'Offset', quantity: 1, unitPrice: -13674 }],
    });
    expect(r.success).toBe(true);
    expect(r.data.lineItems[0].unitPrice).toBe(-13674);
  });

  it('rejects missing invoiceId', () => {
    expect(s.safeParse({ lineItems: [{ description: 'x', quantity: 1 }] }).success).toBe(false);
  });

  it('rejects a line item missing description', () => {
    expect(s.safeParse({ invoiceId: 111, lineItems: [{ quantity: 1 }] }).success).toBe(false);
  });

  it('rejects a line item missing quantity', () => {
    expect(s.safeParse({ invoiceId: 111, lineItems: [{ description: 'x' }] }).success).toBe(false);
  });

  it('rejects an empty lineItems array', () => {
    expect(s.safeParse({ invoiceId: 111, lineItems: [] }).success).toBe(false);
  });

  // REGRESSION GUARD (inverted 2026-07-31 per adversarial review): silently
  // STRIPPING a caller's `price` recreates the $0.00-write defect one layer up
  // — the caller believes they set the money, the wire carries nothing. Every
  // field that is not on the confirmed ST model must be REJECTED loudly, and
  // `price` specifically must point the caller at `unitPrice`.
  it('REJECTS a line item carrying `price` — with an error that names unitPrice as the fix', () => {
    const r: any = s.safeParse({
      invoiceId: 111,
      lineItems: [{ description: 'x', quantity: 1, price: 200 }],
    });
    expect(r.success).toBe(false);
    const messages = r.error.issues.map((i: any) => i.message).join(' | ');
    expect(messages).toMatch(/unitPrice/);
  });

  it('REJECTS line-item fields that do not exist on the confirmed ST model (type, generalLedgerAccountId, businessUnitId, and any unknown key)', () => {
    for (const bad of [
      { type: 'Service' },
      { generalLedgerAccountId: 1 },
      { businessUnitId: 2 },
      { totallyUnknownKey: 3 },
    ]) {
      const r = s.safeParse({
        invoiceId: 111,
        lineItems: [{ description: 'x', quantity: 1, ...bad }],
      });
      expect(r.success).toBe(false);
    }
  });

  it('REJECTS an empty-string skuName on an append line (would 500 at ST mid-sequence otherwise)', () => {
    expect(s.safeParse({
      invoiceId: 111,
      lineItems: [{ skuName: '', description: 'x', quantity: 1 }],
    }).success).toBe(false);
  });

  it('no longer has a jobId argument — job-link reassignment is not an API capability; the top-level SDK schema strips it (documented limitation: top-level unknown keys are outside this tool\'s zod shape)', () => {
    const r: any = s.safeParse({ invoiceId: 111, jobId: 42, lineItems: [{ description: 'x', quantity: 1 }] });
    expect(r.success).toBe(true);
    expect(r.data).not.toHaveProperty('jobId');
  });

  it('defaults dryRun to true', () => {
    const parsed = s.parse({ invoiceId: 111, lineItems: [{ description: 'x', quantity: 1 }] });
    expect(parsed.dryRun).toBe(true);
  });
});

// ── st_create_adjustment_invoice ─────────────────────────────

// Schema rewritten 2026-07-31 to the CONFIRMED POST /invoices body shape
// (live-probed). items[] accepts ONLY skuName / description / quantity / cost /
// unitPrice. skuId, price, type, generalLedgerAccountId and businessUnitId are
// silently dropped by ST on this endpoint and are gone from the schema.

describe('st_create_adjustment_invoice schema', () => {
  const s = schemaOf('st_create_adjustment_invoice');

  it('accepts a minimal valid negative-offset line item (skuName + quantity + unitPrice)', () => {
    expect(s.safeParse({
      parentInvoiceId: 222,
      lineItems: [{ skuName: 'HI1', description: 'Offset', quantity: 1, unitPrice: -998484 }],
    }).success).toBe(true);
  });

  it('rejects a line item missing skuName — ST resolves adjustment lines by SKU NAME only (skuId is ignored here)', () => {
    expect(s.safeParse({
      parentInvoiceId: 222,
      lineItems: [{ description: 'Offset', quantity: 1, unitPrice: -100 }],
    }).success).toBe(false);
  });

  it('rejects missing parentInvoiceId', () => {
    expect(s.safeParse({ lineItems: [{ skuName: 'HI1', quantity: 1, unitPrice: -100 }] }).success).toBe(false);
  });

  it('rejects an empty lineItems array', () => {
    expect(s.safeParse({ parentInvoiceId: 222, lineItems: [] }).success).toBe(false);
  });

  // REGRESSION GUARD (inverted 2026-07-31 per adversarial review): stripping a
  // caller's `price` IS the $0.00-adjustment vector, one layer up from ST.
  // Everything not on the confirmed items[] model must be rejected loudly,
  // with `price` → unitPrice and `skuId` → skuName guidance.
  it('REJECTS an items[] line carrying `price` — with an error that names unitPrice as the fix', () => {
    const r: any = s.safeParse({
      parentInvoiceId: 222,
      lineItems: [{ skuName: 'HI1', description: 'Offset', quantity: 1, price: -999 }],
    });
    expect(r.success).toBe(false);
    expect(r.error.issues.map((i: any) => i.message).join(' | ')).toMatch(/unitPrice/);
  });

  it('REJECTS an items[] line carrying `skuId` — with an error that names skuName as the fix (this endpoint resolves by name only)', () => {
    const r: any = s.safeParse({
      parentInvoiceId: 222,
      lineItems: [{ skuId: 62958024, skuName: 'HI1', description: 'Offset', quantity: 1, unitPrice: -100 }],
    });
    expect(r.success).toBe(false);
    expect(r.error.issues.map((i: any) => i.message).join(' | ')).toMatch(/skuName/);
  });

  it('REJECTS items[] fields ST silently ignores on this endpoint (type, generalLedgerAccountId, businessUnitId, unknown keys)', () => {
    for (const bad of [
      { type: 'Service' },
      { generalLedgerAccountId: 3 },
      { businessUnitId: 4 },
      { anythingElse: true },
    ]) {
      const r = s.safeParse({
        parentInvoiceId: 222,
        lineItems: [{ skuName: 'HI1', description: 'Offset', quantity: 1, unitPrice: -100, ...bad }],
      });
      expect(r.success).toBe(false);
    }
  });

  // Tombstoned top-level args: ST ignores both, and silently stripping them
  // would be the same silent-no-op UX at the zod layer. They reject with an
  // explanatory message instead.
  it('REJECTS the removed top-level businessUnitId / invoiceDate args with explanatory errors', () => {
    const r: any = s.safeParse({
      parentInvoiceId: 222,
      businessUnitId: 257,
      invoiceDate: '2026-07-31',
      lineItems: [{ skuName: 'HI1', description: 'Offset', quantity: 1, unitPrice: -100 }],
    });
    expect(r.success).toBe(false);
    const messages = r.error.issues.map((i: any) => i.message).join(' | ');
    expect(messages).toMatch(/removed 2026-07-31/);
    expect(messages).toMatch(/inherits the parent/);
  });

  it('keeps summary — it IS accepted at the top level by ST', () => {
    const r: any = s.safeParse({
      parentInvoiceId: 222,
      summary: 'Offset HVAC install misbooked to project invoice',
      lineItems: [{ skuName: 'HI1', description: 'Offset', quantity: 1, unitPrice: -100 }],
    });
    expect(r.success).toBe(true);
    expect(r.data.summary).toBe('Offset HVAC install misbooked to project invoice');
  });

  it('defaults dryRun to true', () => {
    const parsed = s.parse({ parentInvoiceId: 222, lineItems: [{ skuName: 'HI1', quantity: 1, unitPrice: -100 }] });
    expect(parsed.dryRun).toBe(true);
  });
});

// ── Tombstone descriptions survive into the advertised schema ──
// Without a .describe(), a z.any() tombstone serializes into the published
// MCP inputSchema as a bare '{}' property — actively ADVERTISING the exact
// fields that caused the incident as accepted, undescribed inputs. The
// descriptions below ride into the serialized schema so the warning reaches
// the caller before the runtime rejection does.
describe('tombstone field descriptions (advertised-schema warnings)', () => {
  function fieldDescription(schema: any): string | undefined {
    return schema?.description;
  }

  it('st_add_invoice_line_item: the price tombstone carries a DO-NOT-SEND description naming unitPrice', () => {
    const tool = TOOLS.find((t) => t.name === 'st_add_invoice_line_item')!;
    const itemSchema: any = (tool.zodSchema as any).lineItems.element ?? (tool.zodSchema as any).lineItems._def?.element;
    const desc = fieldDescription(itemSchema.shape.price);
    expect(desc).toMatch(/DO NOT SEND/);
    expect(desc).toMatch(/unitPrice/);
  });

  it('st_create_adjustment_invoice: price/skuId item tombstones + top-level businessUnitId/invoiceDate tombstones all carry DO-NOT-SEND descriptions', () => {
    const tool = TOOLS.find((t) => t.name === 'st_create_adjustment_invoice')!;
    const shape: any = tool.zodSchema as any;
    const itemSchema: any = shape.lineItems.element ?? shape.lineItems._def?.element;
    expect(fieldDescription(itemSchema.shape.price)).toMatch(/unitPrice/);
    expect(fieldDescription(itemSchema.shape.skuId)).toMatch(/skuName/);
    expect(fieldDescription(shape.businessUnitId)).toMatch(/DO NOT SEND/);
    expect(fieldDescription(shape.invoiceDate)).toMatch(/DO NOT SEND/);
  });
});
