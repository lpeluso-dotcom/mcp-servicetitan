import { z } from 'zod';
import type { ToolDef } from '../index';

interface Args { period?: string }

// Stub — requires mcp-scorpion, mcp-lsa, mcp-lace which are not yet planned.
// Returns pending status immediately without hitting any endpoint.
export const marketing_roas: ToolDef<Args> = {
  name: 'marketing_roas',
  description: 'L5 composite: marketing ROAS (return on ad spend) across Scorpion, LSA, and Lace. STUB — pending mcp-scorpion, mcp-lsa, mcp-lace integrations. Returns pending status immediately.',
  zodSchema: {
    period: z.string().optional().describe('Period for ROAS calculation (e.g. "2026-Q1"). Ignored — stub always returns pending.'),
  },
  async handler(_env, _args, { correlation }) {
    return {
      status: 'pending_dependency',
      blocking_on: ['mcp-scorpion', 'mcp-lsa', 'mcp-lace'],
      message: 'marketing_roas requires external MCP integrations that are not yet planned. Use list_campaigns + get_campaign_performance for ST-native campaign data.',
      correlation,
    };
  },
};
