// ============================================================
// coverage_gate.test.ts — Phase 5 gate.
//
// Every tool in the TOOLS registry MUST either:
//   - declare an `stEndpoint` descriptor, OR
//   - be listed in COVERAGE_EXEMPT in src/routes/admin-endpoints.ts
//
// Catches "shipped a new tool, forgot the descriptor" before it ever hits
// /admin/endpoints/coverage in production. Failure of this test fails
// preflight (vitest is run in scripts/preflight.sh §6).
// ============================================================
import { describe, it, expect } from 'vitest';
import { TOOLS } from '../index';

// Keep this list in sync with COVERAGE_EXEMPT in src/routes/admin-endpoints.ts.
// Adding a tool here should be a deliberate decision (e.g. the generic
// admin escape hatch) — not a "make the test pass" shortcut.
const COVERAGE_EXEMPT = new Set<string>([
  // Generic ST escape hatch (admin-only). Maps to any ST endpoint by definition.
  'st_call',
  // Siro tools — external Siro API, not ServiceTitan. No ST endpoint to map.
  'siro_list_mobile_events',
  'siro_get_recording_summary',
  'siro_get_engagement',
  // Dawn SMS tools — D1-only, no ServiceTitan endpoint (v1.6.0).
  'identify_tech_by_phone',
  'save_tech_debrief',
]);

describe('stEndpoint coverage gate', () => {
  it('every non-exempt tool declares an stEndpoint descriptor', () => {
    const gaps = TOOLS.filter((t) => !t.stEndpoint && !COVERAGE_EXEMPT.has(t.name)).map((t) => t.name);
    expect(gaps).toEqual([]);
  });

  it('every exempt tool actually exists in the registry', () => {
    const known = new Set(TOOLS.map((t) => t.name));
    const missing = Array.from(COVERAGE_EXEMPT).filter((name) => !known.has(name));
    expect(missing).toEqual([]);
  });
});
