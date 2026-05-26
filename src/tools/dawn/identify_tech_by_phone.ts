// ============================================================
// identify_tech_by_phone — Dawn SMS support (v1.6.0)
//
// Identifies a QSC tech by phone number at SMS conversation start.
// Two-tier lookup: voice_registry (preferred) → technicians (canonical).
// Always returns HTTP 200 — never throws (F8 lesson from voice era).
// stEndpoint: null (D1-only, not ST-backed)
// ============================================================

import { z } from 'zod';
import type { ToolDef } from '../index';
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
}

interface ParseErrorResult {
  status: 'parse_error';
  message?: string;
}

type Result = FoundResult | NotFoundResult | ParseErrorResult;

function normalizePhone(phone: string): string {
  if (!phone) return '';
  return phone.replace(/\D/g, '').slice(-10);
}

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
  async handler(env: Env, args: Args): Promise<Result> {
    try {
      const normalized = normalizePhone(args.phone ?? '');
      if (normalized.length < 10) {
        return { status: 'parse_error', message: 'Phone number too short after normalization.' };
      }

      // Tier 1: voice_registry (has learned associations from prior calls)
      const registry = await env.DB.prepare(
        `SELECT name, tech_id, role, confidence FROM voice_registry WHERE phone = ?`,
      )
        .bind(normalized)
        .first<{ name: string; tech_id: string; role: string; confidence: number }>();

      if (registry && registry.name && registry.name !== 'Unknown Tech') {
        return {
          status: 'found',
          tech_id: registry.tech_id,
          tech_name: registry.name,
          role: registry.role,
          source: 'voice_registry',
        };
      }

      // Tier 2: technicians table (canonical ST sync)
      const row = await env.DB.prepare(
        `SELECT tech_id, name, business_unit, role FROM technicians
         WHERE REPLACE(REPLACE(REPLACE(REPLACE(phone, '-', ''), ' ', ''), '(', ''), ')', '') = ?
         AND active = 1 LIMIT 1`,
      )
        .bind(normalized)
        .first<{ tech_id: string; name: string; business_unit: string | null; role: string | null }>();

      if (row) {
        return {
          status: 'found',
          tech_id: row.tech_id,
          tech_name: row.name,
          role: row.role,
          business_unit: row.business_unit,
          source: 'technicians',
        };
      }

      return { status: 'not_found' };
    } catch (err) {
      return { status: 'parse_error', message: `Lookup error: ${String(err)}` };
    }
  },
};
