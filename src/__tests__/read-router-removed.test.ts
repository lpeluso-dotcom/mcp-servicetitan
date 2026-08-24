// ============================================================
// read-router-removed.test.ts — `src/read-router.ts` must stay deleted.
//
// WHAT IT WAS. A D1-first read dispatcher: query the taylor-ai mirror, and
// fall back to live ServiceTitan when the table was absent from the synced
// set or its `updatedAt` was over 48h old. Good design — it just never got
// wired to anything. As of the 2026-06-12 read-router probe and every audit
// since, it had exactly ONE importer in the whole repo: its own unit test.
// Zero live call paths. Every mirror-reading tool called readD1/queryD1
// directly instead.
//
// WHY DELETING IT IS THE FIX, NOT WIRING IT UP. The staleness problem it was
// built for was solved a different way, and that way shipped:
// `src/mirror-freshness.ts` (QUA-1141 / QUA-1234) DISCLOSES freshness on the
// response instead of silently switching sources, because the F1/F2 findings
// showed a mirror-vs-live switch cannot be made correctly from `synced_at`
// alone — incremental syncs leave healthy rows looking old, so a
// staleness-triggered fallback would have hammered live ST on most honest
// calls.
//
// THE ACTIVE HARM was documentary. `src/tools/index.ts` described
// `source: 'd1'` as "D1-first read via read-router (live ST only on miss)",
// which was false for all 15 'd1' tools — they read the mirror with no
// fallback of any kind. A caller reading that comment would believe a stale
// mirror silently self-heals. It does not. The dead module was what made the
// false comment look plausible, so both go together.
//
// ALSO REMOVED WITH IT: two dead `checkRateLimit` call sites (read-router.ts
// :79 and :93). They were the only callers of that guard on the read path,
// and they were unreachable. The LIVE rate-limit wiring is separate, parallel
// work — this deletion removes dead callers only and must not be read as
// removing rate limiting from anything that actually runs.
//
// If a source-switching router is ever wanted again, build it on the
// mirror-freshness verdict (which is honest about what synced_at can prove)
// rather than resurrecting a 48h `updatedAt` threshold.
//
// SOURCE-LEVEL, like connector-route-removed.test.ts: "the module is gone" is
// not a behaviour a unit test can observe, and @types/node is not installed
// here, so the scan goes through Vite's raw glob rather than node:fs.
// ============================================================

import { describe, it, expect } from 'vitest';

// Vite injects `import.meta.glob` at transform time and requires it be
// written out in full (it cannot be aliased or destructured). `vite/client`
// types are not in this repo's `types` list, so declare just the one member.
declare global {
  interface ImportMeta {
    glob(
      pattern: string,
      opts: { query: string; import: string; eager: true },
    ): Record<string, string>;
  }
}

/** Every .ts file under src/, keyed by path relative to this file. */
const SOURCES: Record<string, string> = import.meta.glob('../**/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
});

/** This guard's own prose names the dead module constantly — skip it. */
const SCANNED = Object.entries(SOURCES).filter(
  ([path]) => !path.includes('read-router-removed'),
);

describe('src/read-router.ts stays deleted', () => {
  it('the glob actually resolved sources (guard against a vacuously green scan)', () => {
    expect(SCANNED.length).toBeGreaterThan(50);
  });

  it('the module file does not exist', () => {
    expect(Object.keys(SOURCES)).not.toContain('../read-router.ts');
  });

  it('its unit test does not exist either', () => {
    expect(Object.keys(SOURCES)).not.toContain('../tools/__tests__/read_router_sql_guard.test.ts');
  });

  it('no TypeScript source imports the module or its ReadRouter class', () => {
    const offenders: string[] = [];
    for (const [path, src] of SCANNED) {
      // Import of the module by path, in any of the forms this repo uses.
      if (/from\s+['"][^'"]*read-router['"]/.test(src)) offenders.push(`${path} (import)`);
      // The class itself, so a copy-paste resurrection under a new filename
      // is caught too.
      if (/\bnew ReadRouter\b/.test(src)) offenders.push(`${path} (new ReadRouter)`);
    }
    expect(offenders).toEqual([]);
  });

  it('the `d1` source semantics comment no longer credits read-router', () => {
    const toolsIndex = SOURCES['../tools/index.ts'];
    expect(toolsIndex).toBeTypeOf('string');
    expect(toolsIndex).not.toMatch(/read-router/);
    // And it must not keep the false promise the router was cited for.
    expect(toolsIndex).not.toMatch(/live ST only on miss/);
  });
});
