// ============================================================
// Task 6.4 — Tool-selection eval harness: offline scenario validation.
//
// This is the CI-covered half of the eval harness. It requires no
// ANTHROPIC_API_KEY and asserts the ~20 natural-language QSC scenarios in
// scripts/evals/scenarios.ts stay grounded against the real TOOLS registry
// (no typos, no dangling/renamed tool names) and meet the harness's
// structural minimums. The live top-1/top-3 LLM eval (scripts/evals/
// tool-selection.ts -> runEval) is key-gated and manual — Luke runs it via
// `npm run eval:tools` with ANTHROPIC_API_KEY set; it is intentionally NOT
// exercised here (costs money, not deterministic, not a CI gate).
// ============================================================

import { describe, it, expect } from 'vitest';
import { TOOLS } from '../tools/index';
import { scenarios } from '../../scripts/evals/scenarios';
import { validateScenarios } from '../../scripts/evals/tool-selection';

describe('eval scenario integrity (offline, no API key required)', () => {
  it('validateScenarios reports ok against the live TOOLS registry', () => {
    const result = validateScenarios(TOOLS, scenarios);
    // Surface the exact errors in the assertion failure rather than just "false".
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('has at least 20 scenarios', () => {
    expect(scenarios.length).toBeGreaterThanOrEqual(20);
  });

  it('scenario ids are unique', () => {
    const ids = scenarios.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every scenario id is a non-empty string', () => {
    for (const s of scenarios) {
      expect(typeof s.id).toBe('string');
      expect(s.id.trim().length).toBeGreaterThan(0);
    }
  });

  it('every expected tool name exists in the live TOOLS registry', () => {
    const names = new Set(TOOLS.map((t) => t.name));
    for (const s of scenarios) {
      expect(Array.isArray(s.expected)).toBe(true);
      expect(s.expected.length).toBeGreaterThan(0);
      for (const name of s.expected) {
        expect(names.has(name), `scenario "${s.id}" expects unknown tool "${name}"`).toBe(true);
      }
    }
  });

  it('every scenario has a non-empty query', () => {
    for (const s of scenarios) {
      expect(typeof s.query).toBe('string');
      expect(s.query.trim().length).toBeGreaterThan(0);
    }
  });

  it('every scenario has a non-empty rationale', () => {
    for (const s of scenarios) {
      expect(typeof s.rationale).toBe('string');
      expect(s.rationale.trim().length).toBeGreaterThan(0);
    }
  });

  it('no scenario query/rationale claims a pricebook item is free/unpriced/$0 (ST uses dynamic pricing)', () => {
    // Hard rule from CLAUDE.md: a 0/null/absent price on a pricebook item is
    // NOT "free" or "unpriced" — QSC runs Pricebook Pro dynamic pricing.
    const bannedPattern = /\bfree\b|\bunpriced\b|\$0\b/i;
    for (const s of scenarios) {
      expect(bannedPattern.test(s.query), `scenario "${s.id}" query claims a pricebook item is free/unpriced/$0`).toBe(false);
      expect(bannedPattern.test(s.rationale), `scenario "${s.id}" rationale claims a pricebook item is free/unpriced/$0`).toBe(false);
    }
  });
});
