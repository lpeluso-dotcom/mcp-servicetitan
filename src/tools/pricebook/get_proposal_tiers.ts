// ============================================================
// get_proposal_tiers — Good/Better/Best tier ladder for a QSC proposal
// (Supabase get_proposal_tiers RPC, migrations 0007/0008).
// ============================================================
import { z } from 'zod';
import type { Env } from '../../env';
import type { ToolDef } from '../index';
import { sbRpc, shapePriceRow } from '../../supabase';

interface Args { proposalId: number; }

export const get_proposal_tiers: ToolDef<Args> = {
  name: 'get_proposal_tiers',
  description:
    'Return the tier ladder (e.g. Good/Better/Best) for a QSC proposal by proposal id, ' +
    'with each tier\'s template, item count, and reference total. ' +
    'Note: total_price_ref may be null — QSC uses dynamic pricing computed at invoice time.',
  zodSchema: {
    proposalId: z.number().int().positive().describe('Proposal id (pb_proposal_templates.id)'),
  },
  async handler(env: Env, args: Args) {
    const rows = await sbRpc<Array<Record<string, unknown>>>(env, 'get_proposal_tiers', { pid: args.proposalId });
    return { tiers: (rows ?? []).map((r) => shapePriceRow(r)), proposalId: args.proposalId, _source: 'supabase' };
  },
};
