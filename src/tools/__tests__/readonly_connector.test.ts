// ============================================================
// readonly_connector.test.ts — the no-write guarantee for the Claude Desktop
// connector route (/c/<token>/mcp), used by Jessica Hunt (Ops Director).
//
// Luke's hard requirement: she gets the full ServiceTitan read domain but
// CANNOT write. The 'readonly' role MUST register ZERO write tools (removal,
// not gating) — identical safe set as 'lockdown', but per-connector.
// ============================================================
import { describe, it, expect } from 'vitest';
import { TOOLS, toolsForRole } from '../index';

const WRITE_NAME_PATTERNS = [
  /^st_patch_/,
  /^st_create_/,
  /^add_(customer|job)_note$/,
  /^book_job$/,
  /^reschedule_appointment$/,
  /^hold_appointment$/,
  /^assign_technicians$/,
  /^create_task$/,
  /^create_call_with_campaign$/,
  /^create_recurring_service$/,
  /^dismiss_estimate$/,
  /^sell_estimate$/,
  /^unsell_estimate$/,
  /^st_post_marketing_attribution$/,
  /^save_tech_debrief$/,
  /^create_estimate_template$/,
  /^update_estimate_template$/,
  /^delete_estimate_template$/,
];

describe('readonly connector role', () => {
  it('registers ZERO isWrite tools (no-write guarantee)', () => {
    const visible = toolsForRole('readonly');
    const writeNamesInVisible = visible.filter((t) => t.isWrite).map((t) => t.name);
    expect(writeNamesInVisible).toEqual([]);
  });

  it('registers ZERO tools that look like a write by name', () => {
    const visible = toolsForRole('readonly');
    const leaks = visible
      .map((t) => t.name)
      .filter((name) => WRITE_NAME_PATTERNS.some((re) => re.test(name)));
    expect(leaks).toEqual([]);
  });

  it('strips the st_call admin escape hatch', () => {
    const visible = toolsForRole('readonly');
    expect(visible.find((t) => t.name === 'st_call')).toBeUndefined();
  });

  it('exposes the SAME safe set as lockdown', () => {
    const ro = toolsForRole('readonly').map((t) => t.name).sort();
    const ld = toolsForRole('lockdown').map((t) => t.name).sort();
    expect(ro).toEqual(ld);
  });

  it('is a strict subset of default (writes were actually removed)', () => {
    const ro = toolsForRole('readonly').length;
    const def = toolsForRole('default').length;
    expect(ro).toBeLessThan(def);
    // every readonly tool is a non-write, non-admin tool
    expect(toolsForRole('readonly').every((t) => !t.isWrite && !t.adminOnly)).toBe(true);
  });

  it('still exposes the finance/ops reads Jessica needs', () => {
    const names = new Set(toolsForRole('readonly').map((t) => t.name));
    for (const need of [
      'customer_snapshot',
      'list_unpaid_invoices',
      'get_invoice_balance',
      'list_memberships_expiring',
      'job_cost_actuals',
      'margin_audit',
      'st_run_report',
      'get_capacity',
    ]) {
      expect(names.has(need)).toBe(true);
    }
  });
});
