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
  it('exports 90 tools (v1.7.0 — pricebook full-field surface; tool count unchanged from v1.6.1)', () => {
    expect(TOOLS.length).toBe(90);
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
      'create_recurring_service',
      'create_task',
      'dismiss_estimate',
      'hold_appointment',
      'reschedule_appointment',
      'save_tech_debrief',
      'sell_estimate',
      'st_create_material',
      'st_create_service',
      'st_patch_material',
      'st_patch_service',
      'st_post_marketing_attribution',
      'unsell_estimate',
    ]);
  });

  it('st_call is the only adminOnly tool', () => {
    const adminOnly = TOOLS.filter((t) => t.adminOnly).map((t) => t.name);
    expect(adminOnly).toEqual(['st_call']);
  });

  it('toolsForRole("default") excludes st_call; admin includes it', () => {
    expect(toolsForRole('default').length).toBe(89);
    expect(toolsForRole('admin').length).toBe(90);
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
