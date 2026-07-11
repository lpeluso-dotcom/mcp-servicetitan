// ============================================================
// description-lint.test.ts — Task 6.1
//
// Static-eval gate on tool description quality. With 99 registered
// tools (98 default + 1 admin), the description text IS the agent UX — an LLM caller decides
// which tool to invoke, whether a call is a write, and what pagination
// to expect almost entirely from `description`. This test asserts every
// tool in TOOLS meets the QSC quality bar so description drift fails CI
// instead of silently degrading agent behavior.
//
// Rules (see per-tool violation collection below):
//   1. Non-trivial: description.length >= 40.
//   2. States a data source: matches /\b(live ST|D1|D1-first|computed|derived|synthetic)\b/i.
//      KNOWN LIMITATION: this checks source-keyword PRESENCE, not TRUTH — a
//      tool whose description names a source that its handler doesn't actually
//      use still passes here. Provenance truth (does the handler really read
//      that source?) is verified separately, by spec review and the
//      tool-selection eval — do not over-trust this gate for correctness.
//   3. Write tools (isWrite === true) name the dryRun -> confirm two-phase
//      write-gate flow: matches /dryRun/i AND /(confirm|token)/i.
//   4. Tools exposing a paging/capping arg in zodSchema (pageSize, limit, topK,
//      count, offset) state the pagination / limit behavior:
//      matches /pageSize|up to|limit|default|max/i.
//
// Failures are collected (not thrown on first hit) so a red run lists
// EVERY offending tool + rule in one shot — diagnosable without a
// debug-fix-rerun loop per tool.
// ============================================================

import { describe, it, expect } from 'vitest';
import { TOOLS } from '../tools/index';

// Note: a `source:` alternative was dropped — the trailing `\b` never matches
// after a colon, so it was dead. The real tokens below still require every
// description to name a concrete data source.
const DATA_SOURCE_RE = /\b(live ST|D1|D1-first|computed|derived|synthetic)\b/i;
const DRY_RUN_RE = /dryRun/i;
const CONFIRM_RE = /(confirm|token)/i;
const PAGINATION_RE = /pageSize|up to|limit|default|max/i;

/**
 * Explicit exemptions. Every entry needs a one-line justification.
 * Keyed by [toolName, ruleId] so an exemption never silently applies to a
 * rule it wasn't reviewed for.
 */
const EXEMPT: Record<string, Set<'source' | 'pagination' | 'write_gate'>> = {
  // st_call is the admin raw-gateway escape hatch — it proxies an arbitrary
  // caller-supplied ST endpoint/method, so there is no single fixed data
  // source to name; the description instead documents the gateway contract.
  st_call: new Set(['source']),
  // save_tech_debrief is a D1-only idempotent upsert (Dawn SMS agent) that
  // deliberately bypasses write-gate.ts (see the tool's own header comment)
  // — it never calls ServiceTitan, so there is no dryRun/confirmation_token
  // arg in its zodSchema, and describing a preview->confirm flow that does
  // not exist would be inaccurate. isWrite=true only to keep it out of
  // readonly/lockdown roles.
  save_tech_debrief: new Set(['write_gate']),
};

function isExempt(toolName: string, rule: 'source' | 'pagination' | 'write_gate'): boolean {
  return EXEMPT[toolName]?.has(rule) ?? false;
}

interface Violation {
  tool: string;
  reason: string;
}

describe('description-lint — static eval', () => {
  const violations: Violation[] = [];

  for (const tool of TOOLS) {
    const { name, description, zodSchema, isWrite } = tool;

    // Rule 1 — non-trivial
    if (typeof description !== 'string' || description.length < 40) {
      violations.push({ tool: name, reason: `rule1 non-trivial: description length ${description?.length ?? 0} < 40` });
    }

    // Rule 2 — data source stated.
    // NOTE: this is a PRESENCE check on the source keyword, not a TRUTH check —
    // it cannot tell whether the handler actually reads the named source.
    // Provenance truth is verified in spec review + the tool-selection eval.
    if (!isExempt(name, 'source') && !DATA_SOURCE_RE.test(description ?? '')) {
      violations.push({ tool: name, reason: 'rule2 data-source: description does not state a data source (live ST/D1/D1-first/computed/derived/synthetic)' });
    }

    // Rule 3 — write tools mention the write-gate
    if (isWrite === true && !isExempt(name, 'write_gate')) {
      if (!DRY_RUN_RE.test(description ?? '')) {
        violations.push({ tool: name, reason: 'rule3 write-gate: isWrite=true but description does not mention dryRun' });
      }
      if (!CONFIRM_RE.test(description ?? '')) {
        violations.push({ tool: name, reason: 'rule3 write-gate: isWrite=true but description does not mention confirm/token' });
      }
    }

    // Rule 4 — pagination/limit behavior stated. Triggers on any paging or
    // result-capping arg the schema exposes, so a tool that can silently
    // truncate its result set must say so.
    const argKeys = Object.keys(zodSchema ?? {});
    const PAGING_ARGS = ['pageSize', 'limit', 'topK', 'count', 'offset'];
    const hasPaginationArg = PAGING_ARGS.some((k) => argKeys.includes(k));
    if (hasPaginationArg && !isExempt(name, 'pagination') && !PAGINATION_RE.test(description ?? '')) {
      violations.push({ tool: name, reason: 'rule4 pagination: zodSchema exposes a paging/capping arg (pageSize/limit/topK/count/offset) but description does not state pagination/limit behavior' });
    }
  }

  it('TOOLS is non-empty (sanity check the registry import worked)', () => {
    expect(TOOLS.length).toBeGreaterThan(0);
  });

  it('every tool description meets the QSC quality bar (non-trivial, sourced, write-gated, paginated)', () => {
    const message = violations.map((v) => `${v.tool}: ${v.reason}`).join('\n');
    expect(violations, `\n${violations.length} description-lint violation(s):\n${message}\n`).toEqual([]);
  });

  // Per-tool assertions so a single failing tool is individually named and
  // diagnosable in the test runner's tree output, not just in one big
  // aggregate failure message.
  describe('per-tool', () => {
    for (const tool of TOOLS) {
      it(tool.name, () => {
        const toolViolations = violations.filter((v) => v.tool === tool.name);
        expect(toolViolations, toolViolations.map((v) => v.reason).join('\n')).toEqual([]);
      });
    }
  });
});
