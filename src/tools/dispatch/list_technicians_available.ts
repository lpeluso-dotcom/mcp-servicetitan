import { z } from 'zod';
import { McpError } from '../../errors';
import { readST } from '../../st';
import { resolveBusinessUnit } from '../../name-resolver';
import type { ToolDef } from '../index';

interface Args {
  date?: string;
  businessUnitId?: number;
  businessUnitName?: string;
  page?: number;
  pageSize?: number;
}

export const list_technicians_available: ToolDef<Args> = {
  name: 'list_technicians_available',
  description: 'List the active technician roster from ST Settings, optionally resolving a business-unit name. NOTE: ST has no dispatch "available technicians by date" operation, so this returns the active roster; the `date` arg does NOT filter by availability and business-unit filtering is not supported by the roster endpoint (both surface as _warnings). Source: live ST (settings/technicians).',
  stEndpoint: { method: 'GET', path: '/settings/v2/tenant/{tid}/technicians', source: 'live' },
  zodSchema: {
    date: z.string().optional().describe('Date to check availability (YYYY-MM-DD, default: today)'),
    businessUnitId: z.number().int().positive().optional().describe('Filter by business unit ID'),
    businessUnitName: z.string().min(1).optional().describe('Filter by business unit name (resolved against business_units D1).'),
    page: z.number().int().positive().default(1).describe('Page number'),
    pageSize: z.number().int().positive().max(200).default(50).describe('Page size, max 200'),
  },
  async handler(env, args, { actor, correlation }) {
    if (args.businessUnitId !== undefined && args.businessUnitName !== undefined) {
      throw new McpError('validation_error', 'pass at most one of businessUnitId or businessUnitName', { correlation });
    }

    const warnings: string[] = [];
    let buId = args.businessUnitId;
    if (args.businessUnitName !== undefined) {
      const r = await resolveBusinessUnit(env, args.businessUnitName, 'read');
      buId = r.id;
      if (r.ambiguous) warnings.push(`businessUnit_name_ambiguous: chose ${r.id} for "${args.businessUnitName}"`);
    }

    // ST Settings /technicians is the technician ROSTER endpoint — it has no
    // availability-date or business-unit filter, so surface those as warnings
    // instead of silently dropping them. The old /dispatch/v2/.../technicians
    // route never existed (404 "Unable to match an operation").
    const query: Record<string, unknown> = {
      active: true,
      page: args.page ?? 1,
      pageSize: args.pageSize ?? 50,
    };
    if (args.date) warnings.push('date_ignored: ST has no technician-availability-by-date endpoint; returning the active roster');
    if (buId !== undefined) warnings.push(`businessUnit_ignored: ST Settings technicians is not filterable by business unit (resolved ${buId})`);

    const data = await readST<{ data?: unknown[] }>(
      env,
      { actor, correlation },
      '/settings/v2/tenant/000000000/technicians',
      query,
    );
    return {
      technicians: data.data ?? [],
      _source: 'live',
      ...(warnings.length > 0 ? { _warnings: warnings } : {}),
    };
  },
};
