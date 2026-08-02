// ============================================================
// identify_tech_by_phone — Dawn SMS support (v1.6.0)
//
// Identifies a QSC tech by phone number at SMS conversation start.
// Two-tier lookup: voice_registry (preferred) → technicians (canonical).
// Always returns HTTP 200 — never throws (F8 lesson from voice era).
// stEndpoint: null (D1-only, not ST-backed)
//
// QUA-267 finding 1 (2026-05-26): tables live in TAYLOR-AI's D1, not in
// mcp-servicetitan's own env.DB. Cross-worker reads go through the
// servicetitan-proxy service binding's /api/sql/read endpoint — same
// pattern as search_pricebook_all's queryD1 helper. The earlier env.DB
// implementation always returned `SQLITE_ERROR: no such table` which
// dawn-chat masked with its in-prompt roster, but dawn-text would not.
// ============================================================

import { z } from 'zod';
import type { ToolDef } from '../index';
import { defaultShaper } from '../../response-shape';
import { queryD1First } from '../../d1-proxy';
import { stampMirrorFreshness, fetchTableMax, type FreshnessStamp } from '../../mirror-freshness';
import type { Env } from '../../env';

interface Args {
  phone: string;
}

interface FoundResult {
  status: 'found';
  tech_id: string | null;
  tech_name: string;
  role: string | null;
  business_unit?: string | null;
  source: 'voice_registry' | 'technicians';
}

interface NotFoundResult {
  status: 'not_found';
  /** MB-1 / QUA-1141: a miss is a claim about the MIRROR, not ServiceTitan. */
  _not_found_caveat: string;
}

interface ParseErrorResult {
  status: 'parse_error';
  message?: string;
}

// Tier-2 hits and misses carry the mirror-freshness stamp; tier-1
// (voice_registry) hits do not — see the comment at that return site.
type Result =
  | FoundResult
  | (FoundResult & FreshnessStamp)
  | (NotFoundResult & FreshnessStamp)
  | ParseErrorResult;

function normalizePhone(phone: string): string {
  if (!phone) return '';
  return phone.replace(/\D/g, '').slice(-10);
}

// Cross-worker D1 reads against taylor-ai go through src/d1-proxy.ts's
// queryD1First helper — retry-on-transient + correlation threading.

export const identify_tech_by_phone: ToolDef<Args> = {
  name: 'identify_tech_by_phone',
  description:
    'Identify a QSC tech by phone number. Used at SMS conversation start (Dawn agent). ' +
    'Two-tier lookup: voice_registry (preferred, has learned associations) → technicians table (canonical). ' +
    'Always returns 200 — never throws. D1-only (no ST API call).',
  zodSchema: {
    phone: z.string().min(1).describe('Caller phone number (any format — will be normalized to 10 digits)'),
  },
  stEndpoint: undefined,
  async handler(env: Env, args: Args, ctx?: { correlation?: string }): Promise<Result> {
    const correlation = ctx?.correlation;
    try {
      const normalized = normalizePhone(args.phone ?? '');
      if (normalized.length < 10) {
        return { status: 'parse_error', message: 'Phone number too short after normalization.' };
      }

      // Tier 1: voice_registry (has learned associations from prior calls).
      // Lives in taylor-ai's D1 — read via servicetitan-proxy.
      const registry = await queryD1First<{
        name: string;
        tech_id: string;
        role: string;
        confidence: number;
      }>(
        env,
        `SELECT name, tech_id, role, confidence FROM voice_registry WHERE phone = ?`,
        [normalized],
        { correlation, tag: 'identify_tech_by_phone:voice_registry' },
      );

      if (registry && registry.name && registry.name !== 'Unknown Tech') {
        // MB-1 / QUA-1141: deliberately NOT stamped. voice_registry is a
        // LEARNED association table, not an ST mirror — it has no synced_at
        // column (pragma-verified 2026-08-02) and no sync whose failure a
        // stamp could disclose.
        return {
          status: 'found',
          tech_id: registry.tech_id,
          tech_name: registry.name,
          role: registry.role,
          source: 'voice_registry',
        };
      }

      // Tier 2: technicians table (canonical ST sync). Also taylor-ai D1.
      // The table-level freshness probe (F1/F5 redesign) runs concurrently
      // with the lookup; it never rejects (degrades to {}). Deliberately not
      // fired on the tier-1 fast path — voice_registry hits carry no stamp.
      const tableMaxP = fetchTableMax(env, ['technicians']);
      const row = await queryD1First<{
        tech_id: string;
        name: string;
        business_unit: string | null;
        role: string | null;
        synced_at: string | null;
      }>(
        env,
        `SELECT tech_id, name, business_unit, role, synced_at FROM technicians
         WHERE REPLACE(REPLACE(REPLACE(REPLACE(phone, '-', ''), ' ', ''), '(', ''), ')', '') = ?
         AND active = 1 LIMIT 1`,
        [normalized],
        { correlation, tag: 'identify_tech_by_phone:technicians' },
      );

      if (row) {
        return {
          status: 'found',
          tech_id: row.tech_id,
          tech_name: row.name,
          role: row.role,
          business_unit: row.business_unit,
          source: 'technicians',
          // MB-1 / QUA-1141: a hit off a frozen mirror may be an ex-tech —
          // the table-level probe (not the row's own synced_at) decides.
          ...stampMirrorFreshness([row], { table: 'technicians', tableMax: await tableMaxP }),
        };
      }

      // MB-1 / QUA-1141: a miss is a claim about the MIRROR, not ServiceTitan.
      // On a proven-fresh mirror this is an honest "not in the mirror as of
      // the last sync" (F5); otherwise a new hire or changed number may
      // simply be absent until the next sync.
      return {
        status: 'not_found',
        ...stampMirrorFreshness([], { table: 'technicians', tableMax: await tableMaxP }),
        _not_found_caveat:
          'No match in the taylor-ai D1 mirror as of its last sync (see _freshness). If the ' +
          'mirror is not proven fresh this does NOT prove the caller is not a QSC tech — new ' +
          'hires and changed numbers are absent until the next technicians sync.',
      };
    } catch (err) {
      return { status: 'parse_error', message: `Lookup error: ${String(err)}` };
    }
  },
  transformResult: defaultShaper,
};
