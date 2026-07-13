import { z } from 'zod';
import { readST } from '../../st';
import { defaultShaper } from '../../response-shape';
import type { ToolDef } from '../index';

interface Args { from: string; to: string; csr?: string }

// 15 min memo. Live ST calls; Lace scores deferred to v1.1.
// (call_transcripts D1 table dropped 2026-06-12 — legacy soak expired.)
export const call_quality_review: ToolDef<Args> = {
  name: 'call_quality_review',
  description: 'L5 composite: call quality review over ST call records. 15 min memo. Source: live ST calls. Note: Lace score integration deferred to v1.1.',
  zodSchema: {
    from: z.string().describe('Start date (ISO 8601)'),
    to: z.string().describe('End date (ISO 8601)'),
    csr: z.string().optional().describe('Filter by CSR name or employee ID'),
  },
  stEndpoint: { method: 'GET', path: '/telecom/v3/tenant/{tid}/calls', source: 'live' },
  async handler(env, args, { actor, correlation }) {
    const { from, to, csr } = args;
    const data = await readST<{ data?: any[] }>(
      env,
      { actor, correlation },
      `/telecom/v3/tenant/000000000/calls`,
      { createdOnOrAfter: from, createdBefore: to, pageSize: 100 },
    );
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
  transformResult: defaultShaper,
};
