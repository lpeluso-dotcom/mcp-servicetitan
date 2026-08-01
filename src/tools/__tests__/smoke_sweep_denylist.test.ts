// ============================================================
// QUA-1044 — the all-tools smoke sweep must derive its exclusions
// from the REGISTRY, never from a hand-maintained name list.
//
// History (audit S-4): scripts/all-tools-smoke.sh subtracted a hardcoded
// 16-name WRITES string from tools/list and invoked EVERYTHING ELSE with
// empty args against the deploy target — prod included. That list rotted
// twice: it was missing 9 real write tools (create/update/delete_estimate_
// template, dismiss/sell/unsell_estimate, save_tech_debrief, and the two
// 2026-07-31 invoice money-writes st_add_invoice_line_item /
// st_create_adjustment_invoice), and it carried a phantom entry
// (`update_estimate_status`) that is a FILENAME, not a tool name, so it had
// never matched anything.
//
// What kept prod safe was luck, not design: Zod required-field rejection.
// The day any write tool acquires an all-optional schema, the sweep writes
// to production. `save_tech_debrief` is the sharpest edge — it bypasses the
// write gate entirely and INSERTs straight into own-D1.
//
// These tests make the exclusion DENY-BY-DEFAULT and keep the annotation
// that drives it honest.
// ============================================================

import { describe, it, expect } from 'vitest';
import { TOOLS } from '../index';
import { isSweepEligible, mergedAnnotations } from '../../tool-registry';

// ── 1. The annotation that drives the denylist must not lie ──────────
//
// registerTool merges deriveAnnotations(tool) with tool.annotations, and the
// per-tool override wins. An override that flips readOnlyHint to true on a
// write tool would silently re-open the exact hole this ticket closes, so
// pin the invariant at the registry level.

describe('annotation integrity (readOnlyHint drives the sweep denylist)', () => {
  it('every tool advertises readOnlyHint === !isWrite', () => {
    const liars = TOOLS.filter(
      (t) => mergedAnnotations(t).readOnlyHint !== !t.isWrite
    ).map((t) => `${t.name} (isWrite=${!!t.isWrite}, readOnlyHint=${mergedAnnotations(t).readOnlyHint})`);
    expect(liars).toEqual([]);
  });

  it('every write tool is advertised readOnlyHint:false', () => {
    const writes = TOOLS.filter((t) => t.isWrite);
    expect(writes.length).toBeGreaterThan(0);
    for (const t of writes) {
      expect(mergedAnnotations(t).readOnlyHint).toBe(false);
    }
  });
});

// ── 2. The sweep predicate is DENY-BY-DEFAULT ────────────────────────
//
// isSweepEligible answers "may CI invoke this tool with empty args against a
// live deploy target?". The only acceptable answer is an explicit
// readOnlyHint === true. Anything else — false, undefined, missing
// annotations, a malformed entry — must be refused.

describe('isSweepEligible — deny by default', () => {
  it('admits a tool explicitly annotated readOnlyHint:true', () => {
    expect(isSweepEligible({ name: 'get_job', annotations: { readOnlyHint: true } })).toBe(true);
  });

  it('REFUSES a write tool whose schema is entirely optional (the QUA-1044 acceptance case)', () => {
    // The failure mode the hardcoded list could never catch: a mutating tool
    // with no required fields. Zod would accept `{}` and the sweep would
    // execute a real write. Only the annotation can stop it.
    const fakeAllOptionalWriteTool = {
      name: 'fake_write_all_optional',
      annotations: { readOnlyHint: false },
      inputSchema: { type: 'object', properties: { note: { type: 'string' } }, required: [] },
    };
    expect(isSweepEligible(fakeAllOptionalWriteTool)).toBe(false);
  });

  it('REFUSES a tool with no annotations at all (new tool forgot them)', () => {
    expect(isSweepEligible({ name: 'brand_new_tool' })).toBe(false);
  });

  it('REFUSES a tool whose readOnlyHint is undefined', () => {
    expect(isSweepEligible({ name: 'half_annotated', annotations: { title: 'x' } })).toBe(false);
  });

  it('REFUSES truthy-but-not-true values (no coercion)', () => {
    for (const v of ['true', 1, {}, []]) {
      expect(isSweepEligible({ name: 'coerced', annotations: { readOnlyHint: v } })).toBe(false);
    }
  });

  it('refuses a null/undefined tool rather than throwing', () => {
    expect(isSweepEligible(null)).toBe(false);
    expect(isSweepEligible(undefined)).toBe(false);
  });
});

// ── 3. No write tool in the live registry is sweep-eligible ──────────

describe('registry ⇒ sweep exclusion', () => {
  it('excludes every isWrite tool, including the 9 the hardcoded list missed', () => {
    const eligibleWrites = TOOLS.filter(
      (t) => t.isWrite && isSweepEligible({ name: t.name, annotations: mergedAnnotations(t) })
    ).map((t) => t.name);
    expect(eligibleWrites).toEqual([]);
  });

  it('specifically excludes the tools the hardcoded WRITES string omitted', () => {
    const previouslyMissed = [
      'create_estimate_template',
      'update_estimate_template',
      'delete_estimate_template',
      'dismiss_estimate',
      'sell_estimate',
      'unsell_estimate',
      'save_tech_debrief',
      'st_add_invoice_line_item',
      'st_create_adjustment_invoice',
    ];
    for (const name of previouslyMissed) {
      const tool = TOOLS.find((t) => t.name === name);
      expect(tool, `${name} should exist in the registry`).toBeTruthy();
      expect(
        isSweepEligible({ name, annotations: mergedAnnotations(tool!) }),
        `${name} must be excluded from the smoke sweep`
      ).toBe(false);
    }
  });

  it('still admits ordinary read tools (the sweep is not vacuous)', () => {
    const eligible = TOOLS.filter((t) =>
      isSweepEligible({ name: t.name, annotations: mergedAnnotations(t) })
    );
    expect(eligible.length).toBeGreaterThan(50);
    expect(eligible.every((t) => !t.isWrite)).toBe(true);
  });
});

// NOTE: the shell half of this fix — that all-tools-smoke.sh actually selects
// on `.annotations.readOnlyHint == true` and carries no hand-maintained name
// list — is pinned in scripts/preflight.sh check [3], not here. This project's
// tsconfig ships only @cloudflare/workers-types (no node types), so a
// filesystem read in a vitest file fails `tsc --noEmit`; a shell concern is
// better checked by the shell gate that already runs in CI anyway.
