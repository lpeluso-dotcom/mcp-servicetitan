// ============================================================
// st_run_report — ST native reporting (4-mode discriminator).
//
// ST's reporting API is a 3-step discovery + 1-step run pattern:
//   1. list_categories  — GET /reporting/v2/tenant/{tid}/report-categories
//   2. list_reports     — GET /reporting/v2/tenant/{tid}/report-category/{cat}/reports
//   3. describe_report  — GET /reporting/v2/tenant/{tid}/report-category/{cat}/reports/{id}
//   4. run              — POST /reporting/v2/tenant/{tid}/report-category/{cat}/reports/{id}/data
//
// Mandatory: describe_report before first run on an unknown reportId — the
// parameter schema is dynamic per report. The `parameters` array on `run`
// must match what describe_report returns.
//
// canonical descriptor uses the run path (the actual data fetch).
// ============================================================
import { z } from 'zod';
import { McpError } from '../../errors';
import { readST, readSTPost } from '../../st';
import type { ToolDef } from '../index';

const ReportMode = z.enum(['list_categories', 'list_reports', 'describe_report', 'run']);

interface ReportParam {
  name: string;
  value: unknown;
}

interface Args {
  mode: z.infer<typeof ReportMode>;
  categoryId?: string | number;
  reportId?: string | number;
  parameters?: ReportParam[];
  page?: number;
  pageSize?: number;
}

export const st_run_report: ToolDef<Args> = {
  name: 'st_run_report',
  description:
    'Run or discover ServiceTitan native reports. Modes: list_categories | list_reports (requires categoryId) | describe_report (requires categoryId + reportId — MANDATORY before first run on unknown reportId; parameter schema is dynamic) | run (requires categoryId + reportId, takes parameters[]). POST .../reports/{id}/data is the data fetch (returns rows synchronously). Source: live ST.',
  zodSchema: {
    mode: ReportMode.describe('Reporting workflow step'),
    categoryId: z
      .union([z.string(), z.number()])
      .optional()
      .describe('Report category ID — required for list_reports/describe_report/run'),
    reportId: z
      .union([z.string(), z.number()])
      .optional()
      .describe('Report ID — required for describe_report/run'),
    parameters: z
      .array(z.object({ name: z.string(), value: z.unknown() }))
      .optional()
      .describe('Parameter list for mode=run; shape per describe_report response'),
    page: z.number().int().positive().optional().describe('Page (run mode only, default 1)'),
    pageSize: z
      .number()
      .int()
      .positive()
      .max(5000)
      .optional()
      .describe('Page size (run mode only, default 100)'),
  },
  stEndpoint: {
    method: 'POST',
    path: '/reporting/v2/tenant/{tid}/report-category/{cat}/reports/{reportId}/data',
    source: 'live',
  },
  async handler(env, args, { actor, correlation }) {
    // Per-mode required-arg validation (zod refinement is a flat object so we do it here).
    const requireArg = (cond: unknown, msg: string) => {
      if (!cond) {
        throw new McpError('validation_error', msg, { correlation });
      }
    };
    const tid = '000000000';

    if (args.mode === 'list_categories') {
      const data = await readST<{ data?: unknown[] }>(
        env,
        { actor, correlation },
        `/reporting/v2/tenant/${tid}/report-categories`,
      );
      return { mode: 'list_categories', categories: data.data ?? data, _source: 'live' };
    }

    if (args.mode === 'list_reports') {
      requireArg(args.categoryId !== undefined, 'categoryId required for mode=list_reports');
      const data = await readST<{ data?: unknown[] }>(
        env,
        { actor, correlation },
        `/reporting/v2/tenant/${tid}/report-category/${args.categoryId}/reports`,
      );
      return {
        mode: 'list_reports',
        categoryId: args.categoryId,
        reports: data.data ?? data,
        _source: 'live',
      };
    }

    if (args.mode === 'describe_report') {
      requireArg(args.categoryId !== undefined, 'categoryId required for mode=describe_report');
      requireArg(args.reportId !== undefined, 'reportId required for mode=describe_report');
      const data = await readST<unknown>(
        env,
        { actor, correlation },
        `/reporting/v2/tenant/${tid}/report-category/${args.categoryId}/reports/${args.reportId}`,
      );
      return {
        mode: 'describe_report',
        categoryId: args.categoryId,
        reportId: args.reportId,
        report: data,
        _source: 'live',
      };
    }

    // mode === 'run'
    requireArg(args.categoryId !== undefined, 'categoryId required for mode=run');
    requireArg(args.reportId !== undefined, 'reportId required for mode=run');
    requireArg(
      Array.isArray(args.parameters),
      'parameters[] required for mode=run (use describe_report to discover the schema)'
    );

    const runBody: Record<string, unknown> = {
      parameters: args.parameters,
      pageSize: args.pageSize ?? 100,
      page: args.page ?? 1,
    };

    const data = await readSTPost<unknown>(
      env,
      { actor, correlation },
      `/reporting/v2/tenant/${tid}/report-category/${args.categoryId}/reports/${args.reportId}/data`,
      runBody,
    );
    return {
      mode: 'run',
      categoryId: args.categoryId,
      reportId: args.reportId,
      data,
      _source: 'live',
    };
  },
};
