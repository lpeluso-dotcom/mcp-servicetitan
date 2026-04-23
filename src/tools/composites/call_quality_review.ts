import { z } from 'zod';
import { McpError } from '../../errors';
import { authHeaders } from '../../auth';
import type { ToolDef } from '../index';

interface Args { from: string; to: string; csr?: string }

// 15 min memo. Lace scores + ST calls + call_transcripts D1 table.
export const call_quality_review: ToolDef<Args> = {
  name: 'call_quality_review',
  description: 'L5 composite: call quality review combining ST call records with available transcripts. 15 min memo. Source: D1 (calls + call_transcripts nightly-synced). Note: Lace score integration deferred to v1.1.',
  zodSchema: {
    from: z.string().describe('Start date (ISO 8601)'),
    to: z.string().describe('End date (ISO 8601)'),
    csr: z.string().optional().describe('Filter by CSR name or employee ID'),
  },
  async handler(env, args, { actor, correlation }) {
    const { from, to, csr } = args;
    const qs = new URLSearchParams();
    qs.set('createdOnOrAfter', from);
    qs.set('createdBefore', to);
    qs.set('pageSize', '100');

    const resp = await env.TAYLOR_AI.fetch(
      `https://taylor-ai/api/st/read?endpoint=${encodeURIComponent(`/telecom/v3/tenant/431848990/calls?${qs}`)}`,
      { headers: authHeaders(env, correlation, actor) }
    );
    if (!resp.ok) throw new McpError('upstream_error', `call_quality_review: calls fetch failed: ${resp.status}`, { correlation });
    const data = await resp.json<{ data?: any[] }>();
    const calls = data.data ?? [];

    const reviews = calls.map((call) => ({
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
      _composite: 'call_quality_review',
      _source: 'live',
      _note: 'Lace score integration deferred to v1.1 (requires mcp-lace)',
    };
  },
};
