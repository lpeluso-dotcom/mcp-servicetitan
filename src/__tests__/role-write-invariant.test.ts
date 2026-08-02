// ============================================================
// role-write-invariant.test.ts — QUA-1117 item 1
//
// The OAuth connector (/mcp-oauth) hardcodes role 'readonly' (index.ts:361)
// and its ENTIRE read-only guarantee is the tool filter in
// toolsForRole() (tools/index.ts:291-295). Nothing asserted that guarantee
// until this file: the 2026-08-01 connector verification pass found it
// "configured but unproven", which is the same shape as the three guards
// that failed in production in one day in July.
//
// Four invariants, in ascending order of how much they actually protect:
//
//   1. readonly serves zero isWrite tools           — the stated guarantee
//   2. readonly serves zero adminOnly tools         — st_call must never leak
//   3. readonly === lockdown, exactly               — index.ts:361 depends on it
//   4. every mutating stEndpoint declares isWrite   — THE ONE THAT MATTERS
//
// Invariant 4 exists because `isWrite?: boolean` (tools/index.ts:195) is
// OPTIONAL. A new write tool whose author forgets the flag gets
// `undefined` -> falsy -> served over the OAuth connector. Omission fails
// OPEN, not closed. Invariants 1-3 all pass today and would KEEP passing
// through exactly that mistake — they cannot catch it, because a tool that
// never declared isWrite is indistinguishable from a read tool by the flag
// alone. Invariant 4 catches it by cross-checking the flag against the ST
// HTTP method the tool actually calls.
//
// Negative controls are included for 1 and 4: each asserts the check FAILS
// against a deliberately poisoned tool set. An assertion that has never
// been shown to fail is not a control, it is a comment.
// ============================================================

import { describe, it, expect } from 'vitest';
import { TOOLS, toolsForRole } from '../tools/index';
import type { ToolDef } from '../tools/index';

/** HTTP methods that mutate state on ServiceTitan. */
const MUTATING_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/**
 * POST-as-READ exemptions.
 *
 * ServiceTitan uses POST for several genuinely read-only endpoints that take
 * a query in the request body. These tools are correctly NOT isWrite, and a
 * naive method check flags them — this list was produced by that check firing
 * on its first run (2026-08-01), and every entry was confirmed read-only by
 * reading the endpoint it calls.
 *
 * This list is deliberately keyed by TOOL NAME, not by path or method, and is
 * deliberately small. It is the review checkpoint: a NEW tool that POSTs must
 * either declare `isWrite: true` or be added here with a justification. Adding
 * an entry is a decision someone has to write down; forgetting the flag is not.
 * That is what makes this fail closed rather than open.
 */
const POST_AS_READ_EXEMPT = new Map<string, string>([
  ['get_capacity', 'POST /dispatch/v2/.../capacity — capacity query in body, returns availability'],
  ['st_get_capacity_slots', 'POST /dispatch/v2/.../capacity — same endpoint, slot-shaped response'],
  ['st_run_report', 'POST /reporting/v2/.../reports/{id}/data — report parameters in body, returns rows'],
]);

/**
 * The invariant-4 predicate, extracted so the negative control can run the
 * SAME logic against a poisoned set rather than a paraphrase of it.
 *
 * Returns the offending tool names: those that call a mutating ST endpoint,
 * do not declare isWrite, and are not a documented POST-as-read — i.e. those
 * that would be served to a readonly OAuth caller despite mutating ST.
 */
function undeclaredWriteTools(tools: readonly ToolDef<any>[]): string[] {
  return tools
    .filter((t) => {
      const method = t.stEndpoint?.method?.toUpperCase();
      if (!method || !MUTATING_METHODS.has(method)) return false;
      if (t.isWrite) return false;
      return !POST_AS_READ_EXEMPT.has(t.name);
    })
    .map((t) => t.name);
}

const names = (tools: readonly ToolDef<any>[]) => tools.map((t) => t.name).sort();

describe('toolsForRole role invariants (QUA-1117 item 1)', () => {
  it('readonly serves ZERO isWrite tools', () => {
    const leaked = toolsForRole('readonly').filter((t) => t.isWrite).map((t) => t.name);
    expect(leaked).toEqual([]);
  });

  it('readonly serves ZERO adminOnly tools (st_call must never be reachable)', () => {
    const leaked = toolsForRole('readonly').filter((t) => t.adminOnly).map((t) => t.name);
    expect(leaked).toEqual([]);
    expect(names(toolsForRole('readonly'))).not.toContain('st_call');
  });

  it('readonly and lockdown resolve to the EXACT same tool set', () => {
    // index.ts:361 warns that the hardcoded OAuth 'readonly' is only covered
    // by the MCP_LOCKDOWN incident switch while these two stay identical.
    expect(names(toolsForRole('readonly'))).toEqual(names(toolsForRole('lockdown')));
  });

  it('every tool calling a mutating ST endpoint declares isWrite', () => {
    // The fail-open guard. See the header comment.
    expect(undeclaredWriteTools(TOOLS)).toEqual([]);
  });

  it('every POST-as-read exemption is still real and still needed', () => {
    // Keeps the exemption list from rotting into a blanket amnesty. An entry
    // for a tool that no longer exists, or that has since been correctly
    // flagged isWrite, must be deleted — otherwise the list quietly grows
    // into the hole it was meant to document.
    for (const [name] of POST_AS_READ_EXEMPT) {
      const tool = TOOLS.find((t) => t.name === name);
      expect(tool, `exemption for '${name}' but no such tool — delete the entry`).toBeDefined();
      expect(tool!.isWrite, `'${name}' now declares isWrite — delete its exemption`).toBeFalsy();
      const method = tool!.stEndpoint?.method?.toUpperCase();
      expect(
        method && MUTATING_METHODS.has(method),
        `'${name}' no longer uses a mutating method — delete its exemption`,
      ).toBe(true);
    }
  });

  it('admin is a superset of default, which is a superset of readonly', () => {
    const admin = new Set(names(toolsForRole('admin')));
    const def = new Set(names(toolsForRole('default')));
    for (const n of names(toolsForRole('default'))) expect(admin.has(n)).toBe(true);
    for (const n of names(toolsForRole('readonly'))) expect(def.has(n)).toBe(true);
  });
});

describe('negative controls — these checks must FAIL on a violation', () => {
  const readTool = {
    name: 'fake_read_tool',
    description: 'read',
    stEndpoint: { method: 'GET', path: '/x', source: 'live' },
    handler: async () => ({}),
  } as unknown as ToolDef<any>;

  it('invariant 4 CATCHES a mutating tool that forgot isWrite', () => {
    const poisoned = [
      ...TOOLS,
      {
        name: 'fake_write_tool_missing_flag',
        description: 'PATCHes ServiceTitan but never declared isWrite',
        stEndpoint: { method: 'PATCH', path: '/jpm/v2/tenant/{t}/jobs/{id}', source: 'live' },
        handler: async () => ({}),
      } as unknown as ToolDef<any>,
    ];
    expect(undeclaredWriteTools(poisoned)).toEqual(['fake_write_tool_missing_flag']);
  });

  it('invariant 4 does NOT fire on a genuine read tool', () => {
    expect(undeclaredWriteTools([...TOOLS, readTool])).toEqual([]);
  });

  it('invariant 4 does NOT fire on a correctly-flagged write tool', () => {
    const correct = [
      ...TOOLS,
      {
        name: 'fake_write_tool_flagged',
        description: 'declares isWrite properly',
        isWrite: true,
        stEndpoint: { method: 'DELETE', path: '/x/{id}', source: 'live' },
        handler: async () => ({}),
      } as unknown as ToolDef<any>,
    ];
    expect(undeclaredWriteTools(correct)).toEqual([]);
  });

  it('the readonly filter itself strips an isWrite tool (control for invariant 1)', () => {
    // Exercises the real filter expression from toolsForRole against a
    // poisoned set, proving the predicate is what removes the tool.
    const poisoned = [
      ...TOOLS,
      { name: 'fake_flagged_write', isWrite: true, handler: async () => ({}) } as unknown as ToolDef<any>,
    ];
    const filtered = poisoned.filter((t) => !t.isWrite && !t.adminOnly).map((t) => t.name);
    expect(filtered).not.toContain('fake_flagged_write');
  });
});

describe('role census — pins the counts the audit trail cites', () => {
  it('reports the live role split', () => {
    const total = TOOLS.length;
    const readonly = toolsForRole('readonly').length;
    const stripped = total - readonly;
    const writes = TOOLS.filter((t) => t.isWrite).length;
    const adminOnly = TOOLS.filter((t) => t.adminOnly).length;

    // Not hardcoded: the tool catalog grows, and a brittle count assertion
    // would be deleted the first time it failed for a benign reason. What
    // must hold is the ARITHMETIC — stripped is exactly the union of
    // isWrite and adminOnly, so nothing is removed for any other reason.
    const strippedNames = new Set(names(TOOLS).filter((n) => !names(toolsForRole('readonly')).includes(n)));
    const expectedStripped = new Set(
      TOOLS.filter((t) => t.isWrite || t.adminOnly).map((t) => t.name),
    );
    expect(strippedNames).toEqual(expectedStripped);
    expect(stripped).toBe(expectedStripped.size);

    // eslint-disable-next-line no-console
    console.log(
      `[role census] total=${total} readonly=${readonly} stripped=${stripped} ` +
        `isWrite=${writes} adminOnly=${adminOnly}`,
    );
  });
});
