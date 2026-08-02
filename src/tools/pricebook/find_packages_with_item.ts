// ============================================================
// find_packages_with_item — reverse lookup: which templates/proposals and
// which services contain a given pricebook item. templates_with_item keys
// on code; services_with_item keys on st_id, so we resolve st_id from
// (code,item_type) first (code is not unique across item types).
// ============================================================
import { z } from 'zod';
import type { Env } from '../../env';
import type { ToolDef } from '../index';
import { sbRpc, sbSelect, shapePriceRow } from '../../supabase';

interface Args { code: string; itemType?: 'service' | 'material' | 'equipment' | 'fee'; }

export const find_packages_with_item: ToolDef<Args> = {
  name: 'find_packages_with_item',
  description:
    'Reverse lookup for a pricebook item: returns the estimate templates/proposals that include it ' +
    'and the services whose breakout contains it. Pass the item `code`; add `itemType` to disambiguate ' +
    '(codes are not unique across services/materials/equipment). Source: Supabase pricebook mirror (derived from ST).',
  zodSchema: {
    code: z.string().min(1).max(64).describe('Pricebook item code (e.g. "CAP-240")'),
    itemType: z.enum(['service', 'material', 'equipment', 'fee']).optional()
      .describe('Disambiguates the code when it exists in more than one item type'),
  },
  async handler(env: Env, args: Args) {
    // 1. Resolve st_id from (code,item_type) for the services reverse link.
    let stId: number | null = null;
    const typeFilter = args.itemType ? `&item_type=eq.${encodeURIComponent(args.itemType)}` : '';
    const idRows = await sbSelect<Array<{ st_id: number | null }>>(
      env, `pricebook_items?code=eq.${encodeURIComponent(args.code)}${typeFilter}&select=st_id&limit=1`,
    );
    if (idRows?.[0]?.st_id != null) stId = idRows[0].st_id;

    // 2. templates_with_item keys on code; services_with_item keys on st_id.
    const templates = await sbRpc<Array<Record<string, unknown>>>(env, 'templates_with_item', { item_code: args.code });
    const services = stId != null
      ? await sbRpc<Array<Record<string, unknown>>>(env, 'services_with_item', { item_st_id: stId })
      : [];

    return {
      code: args.code,
      st_id: stId,
      templates: (templates ?? []).map((r) => shapePriceRow(r)),
      services: (services ?? []).map((r) => shapePriceRow(r)),
      _source: 'supabase',
    };
  },
};
