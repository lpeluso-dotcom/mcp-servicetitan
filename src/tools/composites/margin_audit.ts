import { z } from 'zod';
import { McpError } from '../../errors';
import { authHeaders } from '../../auth';
import { pagedStRead } from '../../paged-st-read';
import { resolveBusinessUnit } from '../../name-resolver';
import type { ToolDef } from '../index';

interface Args {
  businessUnitId?: number;
  businessUnitName?: string;
  from: string;
  to: string;
}

interface JobRow {
  invoiceTotal?: number;
  totalCost?: number;
}

const TENANT_ID = '000000000';

export const margin_audit: ToolDef<Args> = {
  name: 'margin_audit',
  description:
    'L5 composite: margin audit for a business unit over a date range. Joins jobs + invoice items + cost fields. v1.4 paginates up to 4,000 jobs (20 pages × 200) and surfaces _truncated when the cap is hit. Accepts businessUnitName as an alternative to businessUnitId. See docs/audit/margin-reporting-followup-2026-05-04.md for the deferred Reporting-API migration path.',
  zodSchema: {
    businessUnitId: z.number().int().positive().optional().describe('ST business unit ID (numeric).'),
    businessUnitName: z.string().min(1).optional().describe('Business unit name; resolved against business_units D1 (case-insensitive exact > prefix > contains).'),
    from: z.string().describe('Start date (YYYY-MM-DD)'),
    to: z.string().describe('End date (YYYY-MM-DD)'),
  },
  async handler(env, args, { actor, correlation }) {
    const { businessUnitId, businessUnitName, from, to } = args;
    if ((businessUnitId === undefined) === (businessUnitName === undefined)) {
      throw new McpError(
        'validation_error',
        'exactly one of businessUnitId or businessUnitName is required',
        { correlation }
      );
    }

    const warnings: string[] = [];
    let resolvedId: number;
    if (businessUnitId !== undefined) {
      resolvedId = businessUnitId;
    } else {
      const resolution = await resolveBusinessUnit(env, businessUnitName!, 'read');
      resolvedId = resolution.id;
      if (resolution.ambiguous) {
        warnings.push(`businessUnit_name_ambiguous: chose ${resolvedId} for "${businessUnitName}"`);
      }
    }

    const headers = authHeaders(env, correlation, actor);
    const paged = await pagedStRead<JobRow>(
      env,
      headers,
      `/jpm/v2/tenant/${TENANT_ID}/jobs`,
      {
        businessUnitIds: String(resolvedId),
        completedOnOrAfter: from,
        completedBefore: to,
      }
    );

    let revenue = 0;
    let cost = 0;
    for (const job of paged.items) {
      revenue += job.invoiceTotal ?? 0;
      cost += job.totalCost ?? 0;
    }
    const margin = revenue > 0 ? ((revenue - cost) / revenue) * 100 : 0;

    const allWarnings = [...warnings, ...paged.warnings];

    return {
      businessUnitId: resolvedId,
      period: { from, to },
      jobCount: paged.items.length,
      pageCount: paged.pageCount,
      revenue: Math.round(revenue * 100) / 100,
      cost: Math.round(cost * 100) / 100,
      margin: Math.round(margin * 100) / 100,
      _composite: 'margin_audit',
      _source: 'live',
      _truncated: paged.truncated,
      ...(allWarnings.length > 0 ? { _warnings: allWarnings } : {}),
      ...(paged.partialFailures.length > 0 ? { _partial: true, _failures: paged.partialFailures } : {}),
    };
  },
};
