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
  description: 'List technicians available for dispatch on a given date. v1.4 accepts businessUnitName as an alternative to businessUnitId. Source: live ST.',
  stEndpoint: { method: 'GET', path: '/dispatch/v2/tenant/{tid}/technicians', source: 'live' },
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

    const query: Record<string, unknown> = {
      page: args.page ?? 1,
      pageSize: args.pageSize ?? 50,
    };
    if (args.date) query.requestedOn = args.date;
    if (buId !== undefined) query.businessUnitId = buId;

    const data = await readST<{ data?: unknown[] }>(
      env,
      { actor, correlation },
      '/dispatch/v2/tenant/000000000/technicians',
      query,
    );
    return {
      technicians: data.data ?? [],
      _source: 'live',
      ...(warnings.length > 0 ? { _warnings: warnings } : {}),
    };
  },
};
