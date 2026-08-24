import { z } from 'zod';
import { McpError } from '../../errors';
import { authHeaders } from '../../auth';
import { pagedStRead } from '../../paged-st-read';
import { defaultShaper } from '../../response-shape';
import type { ToolDef } from '../index';

interface Args { from: string; to: string; csr?: string }

interface CallRow {
  id?: number;
  duration?: unknown;
  customerId?: number;
  campaignId?: number;
  createdOn?: string;
}

const TENANT_ID = '000000000';

// 15 min memo. Live ST calls; Lace scores deferred to v1.1.
// (call_transcripts D1 table dropped 2026-06-12 — legacy soak expired.)
//
// Wave 2 / B: was a single `readST` with `pageSize: 100`, so `callCount` was
// the size of a page, not the size of the date range. A week of QSC call
// volume clears 100 easily, and nothing in the response said so.
export const call_quality_review: ToolDef<Args> = {
  name: 'call_quality_review',
  description:
    'L5 composite: call quality review over ST call records. Paginates the full date range (up to 20 pages x 100 calls) ' +
    'and reports `pageCount` + `_truncated` when the cap is hit — `callCount` is the whole range, not one page. ' +
    '15 min memo. Source: live ST calls. Note: Lace score integration deferred to v1.1.',
  zodSchema: {
    from: z.string().describe('Start date (ISO 8601)'),
    to: z.string().describe('End date (ISO 8601)'),
    csr: z.string().optional().describe('Filter by CSR name or employee ID'),
  },
  stEndpoint: { method: 'GET', path: '/telecom/v3/tenant/{tid}/calls', source: 'live' },
  async handler(env, args, { actor, correlation }) {
    const { from, to } = args;

    // pagedStRead takes raw outbound headers, not readST's {actor, correlation}
    // context — it builds page URLs itself and cooperates with the rate-limiter
    // DO per attempt, so the auth headers have to be materialised up front.
    const headers = authHeaders(env, correlation, actor);
    const paged = await pagedStRead<CallRow>(
      env,
      headers,
      `/telecom/v3/tenant/${TENANT_ID}/calls`,
      { createdOnOrAfter: from, createdBefore: to },
      { pageSize: 100 },
    );

    if (paged.pageCount === 0 && paged.partialFailures.length > 0) {
      const first = paged.partialFailures[0];
      throw new McpError(
        'upstream_error',
        `call_quality_review: calls fetch failed before any page was read (page ${first.page}, status ${first.status}): ${first.message}`,
        { correlation, details: { failures: paged.partialFailures } },
      );
    }

    const reviews = paged.items.map((call) => ({
      callId: call.id,
      duration: call.duration,
      customerId: call.customerId,
      campaignId: call.campaignId,
      createdOn: call.createdOn,
      laceScore: null, // deferred to v1.1 — Lace MCP integration pending
    }));

    return {
      period: { from, to },
      reviews,
      callCount: reviews.length,
      pageCount: paged.pageCount,
      _composite: 'call_quality_review',
      _source: 'live',
      _truncated: paged.truncated,
      _note: 'Lace score integration deferred to v1.1 (requires mcp-lace)',
      ...(paged.warnings.length > 0 ? { _warnings: paged.warnings } : {}),
      ...(paged.partialFailures.length > 0
        ? { _partial: true, _failures: paged.partialFailures }
        : {}),
    };
  },
  transformResult: defaultShaper,
};
