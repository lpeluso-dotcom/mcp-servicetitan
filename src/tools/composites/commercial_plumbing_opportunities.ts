import { z } from 'zod';
import { McpError } from '../../errors';
import { authHeaders } from '../../auth';
import { rejectUnsupportedSTFilters } from '../../st';
import { pagedStRead } from '../../paged-st-read';
import { defaultShaper } from '../../response-shape';
import type { ToolDef } from '../index';

interface Args {
  businessUnitId?: number;
  lookbackDays?: number;
  jobTypeName?: string;
  customerType?: string;
}

interface JobRow {
  id?: number;
  customerId?: number;
  completedOn?: string;
}

const TENANT_ID = '000000000';

/**
 * What this tool can and cannot narrow, stated in the payload as well as the
 * description because the caller acts on the payload.
 *
 * /jpm/v2/tenant/{tid}/jobs exposes no verified trade filter and no
 * customer-segment filter. The old code sent `jobTypeName: 'Plumbing'`, which
 * ST does not recognise — and ST does not 400 on an unknown query param, it
 * ignores it and returns an unfiltered HTTP 200. So the tool has never
 * restricted anything to plumbing, or to commercial, despite its name.
 * Silently keeping that pretence is the QUA-1054 / QUA-951 defect class:
 * a wrong answer that looks right. The scope is disclosed instead.
 */
const SCOPE_NOTE =
  'NOT restricted to commercial plumbing. ServiceTitan /jpm/v2 jobs exposes no verified job-type or ' +
  'customer-segment filter, so this cohort spans ALL job types and BOTH residential and commercial ' +
  'customers. For a job-type-filtered cohort use opportunities_list / open_opportunities_pulitzer_feed, ' +
  'which filter job_type_name in D1.';

// 60 min memo.
export const commercial_plumbing_opportunities: ToolDef<Args> = {
  name: 'commercial_plumbing_opportunities',
  description:
    'L5 composite: customers whose most recent completed job is older than `lookbackDays` (default 90) — i.e. lapsed customers, ranked by how long they have been quiet. ' +
    'SCOPE WARNING: this is NOT restricted to commercial plumbing. ServiceTitan\'s jobs endpoint has no verified job-type or customer-segment filter, so the cohort spans all job types and both residential and commercial customers; ' +
    'use opportunities_list for a job-type-filtered cohort. Passing `jobTypeName` or `customerType` is rejected rather than silently dropped. ' +
    'Excludes any customer with a job completed inside the lookback window. Paginates both windows (up to 20 pages x 200 each) and reports `pageCount` + `_truncated`. ' +
    '60 min memo. Source: live ST (jobs).',
  zodSchema: {
    businessUnitId: z.number().int().positive().optional().describe('Filter by business unit ID'),
    lookbackDays: z.number().int().positive().default(90).describe('Days without a completed job to consider a customer an opportunity (default: 90)'),
    jobTypeName: z.string().optional().describe('NOT SUPPORTED on this endpoint — passing it fails loudly. Use opportunities_list({jobTypeName}) instead.'),
    customerType: z.string().optional().describe('NOT SUPPORTED on this endpoint — passing it fails loudly. ServiceTitan jobs cannot be filtered by residential/commercial.'),
  },
  stEndpoint: { method: 'GET', path: '/jpm/v2/tenant/{tid}/jobs', source: 'live' },
  async handler(env, args, { actor, correlation }) {
    // FAIL LOUDLY rather than send a param ST ignores (st.ts docstring rule,
    // Luke 2026-08-04). The old handler hard-coded `jobTypeName: 'Plumbing'`
    // into the query and got back every job type in the tenant.
    rejectUnsupportedSTFilters(
      args as unknown as Record<string, unknown>,
      {
        jobTypeName:
          'ServiceTitan exposes no jobTypeName filter on /jpm/v2/tenant/{tid}/jobs — it ignores the ' +
          'parameter and returns jobs of every type. Use opportunities_list({jobTypeName}) or ' +
          'open_opportunities_pulitzer_feed({jobTypeName}), which filter job_type_name in D1.',
        customerType:
          'ServiceTitan exposes no residential/commercial filter on /jpm/v2/tenant/{tid}/jobs. The ' +
          'segment lives on the customer record, not the job, and would need a per-customer lookup ' +
          'this tool does not perform.',
      },
      correlation,
    );

    const { businessUnitId, lookbackDays = 90 } = args;
    const now = Date.now();
    const cutoff = new Date(now - lookbackDays * 24 * 60 * 60 * 1000).toISOString();

    // ST honours the SINGULAR businessUnitId on /jpm/v2 jobs and silently
    // ignores the plural businessUnitIds (live-verified 2026-07-09, see
    // margin_audit) — the old code sent the plural form, so the BU filter
    // never applied.
    const base: Record<string, string | number> = {};
    if (businessUnitId) base.businessUnitId = businessUnitId;

    const headers = authHeaders(env, correlation, actor);

    // Two windows, because the cohort is defined by ABSENCE. The old code
    // deduped jobs completed BEFORE the cutoff and called every one of those
    // customers an opportunity — a customer serviced last week still has old
    // jobs, so they were listed as lapsed. The recent window is what makes the
    // exclusion possible.
    const [historical, recent] = await Promise.all([
      pagedStRead<JobRow>(env, headers, `/jpm/v2/tenant/${TENANT_ID}/jobs`, {
        ...base,
        completedBefore: cutoff,
      }),
      pagedStRead<JobRow>(env, headers, `/jpm/v2/tenant/${TENANT_ID}/jobs`, {
        ...base,
        completedOnOrAfter: cutoff,
      }),
    ]);

    for (const [label, paged] of [['historical', historical], ['recent', recent]] as const) {
      if (paged.pageCount === 0 && paged.partialFailures.length > 0) {
        const first = paged.partialFailures[0];
        throw new McpError(
          'upstream_error',
          `commercial_plumbing_opportunities: ${label} jobs fetch failed before any page was read ` +
            `(page ${first.page}, status ${first.status}): ${first.message}`,
          { correlation, details: { failures: paged.partialFailures } },
        );
      }
    }

    const servedRecently = new Set<number>();
    for (const job of recent.items) {
      if (typeof job.customerId === 'number') servedRecently.add(job.customerId);
    }

    // Keep the customer's MOST RECENT qualifying job, not whichever row ST
    // happened to return first — `lastJobDate` has to be their actual last job.
    const latestByCustomer = new Map<number, { jobId?: number; completedOn: string; t: number }>();
    for (const job of historical.items) {
      const { customerId, completedOn } = job;
      if (typeof customerId !== 'number' || servedRecently.has(customerId)) continue;
      if (!completedOn) continue;
      const t = Date.parse(completedOn);
      if (!Number.isFinite(t)) continue;
      const existing = latestByCustomer.get(customerId);
      if (!existing || t > existing.t) {
        latestByCustomer.set(customerId, { jobId: job.id, completedOn, t });
      }
    }

    const opportunities = Array.from(latestByCustomer.entries())
      .sort(([, a], [, b]) => a.t - b.t) // quietest customer first
      .map(([customerId, last]) => ({
        customerId,
        lastJobId: last.jobId,
        lastJobDate: last.completedOn,
        daysSinceLastJob: Math.floor((now - last.t) / 86_400_000),
      }));

    const warnings = [...historical.warnings, ...recent.warnings];
    if (recent.truncated) {
      warnings.push(
        'recent_window_truncated: the page cap was hit reading jobs completed inside the lookback ' +
          'window, so some recently-served customers could NOT be excluded — treat listed customers as unverified',
      );
    }
    if (historical.truncated) {
      warnings.push(
        'historical_window_truncated: the page cap was hit reading older jobs, so lapsed customers are missing from this list',
      );
    }

    const partialFailures = [...historical.partialFailures, ...recent.partialFailures];

    return {
      opportunities,
      count: opportunities.length,
      lookbackDays,
      cutoff,
      pageCount: historical.pageCount + recent.pageCount,
      _composite: 'commercial_plumbing_opportunities',
      _source: 'live',
      _scope: SCOPE_NOTE,
      _truncated: historical.truncated || recent.truncated,
      ...(warnings.length > 0 ? { _warnings: warnings } : {}),
      ...(partialFailures.length > 0 ? { _partial: true, _failures: partialFailures } : {}),
    };
  },
  transformResult: defaultShaper,
};
