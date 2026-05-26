// ============================================================
// lockdown.test.ts — v1.5.2 §C gate.
//
// MCP_LOCKDOWN=true puts every caller in the lockdown role, which
// toolsForRole() filters to: NO isWrite tools + NO adminOnly tools.
//
// This test doubles as an `isWrite` audit: if anyone adds a write tool but
// forgets the isWrite flag, lockdown won't strip it and a write-by-name
// assertion below catches the slip.
// ============================================================
import { describe, it, expect } from 'vitest';
import { TOOLS, toolsForRole } from '../index';

// Tool names whose intent is clearly mutating ST state. Lockdown MUST strip
// every one of these — if any escape into the lockdown-visible list, lockdown
// is broken and the new tool needs `isWrite: true`.
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
  /^update_estimate_status$/,
  /^dismiss_estimate$/,
  /^sell_estimate$/,
  /^unsell_estimate$/,
  /^st_post_marketing_attribution$/,
];

describe('lockdown role', () => {
  it('default role exposes every non-adminOnly tool', () => {
    const visible = toolsForRole('default');
    expect(visible.length).toBe(TOOLS.filter((t) => !t.adminOnly).length);
  });

  it('admin role exposes every tool including st_call', () => {
    const visible = toolsForRole('admin');
    expect(visible.length).toBe(TOOLS.length);
    expect(visible.find((t) => t.name === 'st_call')).toBeDefined();
  });

  it('lockdown role strips every isWrite tool', () => {
    const visible = toolsForRole('lockdown');
    const writeNamesInVisible = visible.filter((t) => t.isWrite).map((t) => t.name);
    expect(writeNamesInVisible).toEqual([]);
  });

  it('lockdown role strips st_call', () => {
    const visible = toolsForRole('lockdown');
    expect(visible.find((t) => t.name === 'st_call')).toBeUndefined();
  });

  it('lockdown role strips every tool that looks like a write by name', () => {
    const visible = toolsForRole('lockdown');
    const leaks = visible
      .map((t) => t.name)
      .filter((name) => WRITE_NAME_PATTERNS.some((re) => re.test(name)));
    expect(leaks).toEqual([]);
  });

  it('lockdown role preserves at least a meaningful subset of reads', () => {
    const visible = toolsForRole('lockdown');
    // Sanity: lockdown should NOT be empty. Pick a few known-safe reads.
    const names = new Set(visible.map((t) => t.name));
    expect(names.has('get_customer')).toBe(true);
    expect(names.has('get_job')).toBe(true);
    expect(names.has('list_jobs_today')).toBe(true);
    expect(names.has('customer_snapshot')).toBe(true);
  });

  it('every write tool in TOOLS has isWrite=true (audit invariant)', () => {
    // Any tool name matching a write pattern must declare isWrite:true so
    // lockdown / future role-aware gates see it. If this fails, the offending
    // tool needs `isWrite: true` added.
    const misclassified = TOOLS.filter((t) =>
      WRITE_NAME_PATTERNS.some((re) => re.test(t.name)) && !t.isWrite,
    ).map((t) => t.name);
    expect(misclassified).toEqual([]);
  });
});
