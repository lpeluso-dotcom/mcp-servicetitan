// ============================================================
// get_proposal_tiers — Good/Better/Best tier ladder for a QSC proposal
// (Supabase get_proposal_tiers RPC, migrations 0007/0008).
// ============================================================
import { z } from 'zod';
import type { Env } from '../../env';
import type { ToolDef } from '../index';
import { sbRpc, shapePriceRow } from '../../supabase';
import { cacheGet } from '../../cache';
import { goldAsOf } from '../../gold-watermark';

interface Args { proposalId: number; }

/**
 * Tier ladders change only when the nightly template sync runs (09:30 UTC),
 * so re-running the RPC per call bought nothing — this was the one Supabase
 * RPC in the repo with no cache at all. 1h keeps a proposal's ladder warm
 * across the several calls a single estimate conversation makes, while still
 * picking up a same-day template edit within the hour. Keyed by proposal id,
 * so one proposal's ladder can never be served for another.
 */
const TIERS_CACHE_NAMESPACE = 'servicetitan:pb-proposal-tiers';
export const TIERS_TTL_SEC = 3600;

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
    const [rows, asOf] = await Promise.all([
      cacheGet<Array<Record<string, unknown>>>(
        env, TIERS_CACHE_NAMESPACE, String(args.proposalId), TIERS_TTL_SEC,
        () => sbRpc<Array<Record<string, unknown>>>(env, 'get_proposal_tiers', { pid: args.proposalId }),
      ),
      // pb_proposal_tiers rides the TEMPLATE sync (09:30 UTC), not the item
      // refresh (09:45) — watermarking off pricebook_items would let a fresh
      // item sync vouch for a frozen template sync.
      goldAsOf(env, 'pricebook_templates'),
    ]);
    return {
      tiers: (rows ?? []).map((r) => shapePriceRow(r)),
      proposalId: args.proposalId,
      _source: 'supabase',
      ...asOf,
    };
  },
};
