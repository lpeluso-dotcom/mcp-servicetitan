import { z } from 'zod';
import { McpError } from '../../errors';
import { authHeaders } from '../../auth';
import type { ToolDef } from '../index';

interface Args { parentEquipmentId: number; active?: boolean }

// T8 catalog correction: renamed from get_equipment_variants to match ST vocabulary.
// ST uses "variations" / isConfigurableEquipment — children are queried by parent ID.
export const get_configurable_equipment_children: ToolDef<Args> = {
  name: 'get_configurable_equipment_children',
  description: 'Get child equipment variations for a configurable (parent) equipment item. ST vocabulary: isConfigurableEquipment=true on the parent. Source: live ST (pb_equipment 37d stale in D1).',
  zodSchema: {
    parentEquipmentId: z.number().int().positive().describe('ST pricebook equipment ID of the parent (isConfigurableEquipment=true)'),
    active: z.boolean().optional().describe('Filter by active status (default: all)'),
  },
  async handler(env, args, { actor, correlation }) {
    const qs = new URLSearchParams();
    qs.set('parentEquipmentId', String(args.parentEquipmentId));
    if (args.active !== undefined) qs.set('active', String(args.active));

    const resp = await env.TAYLOR_AI.fetch(
      `https://taylor-ai/api/st/read?endpoint=${encodeURIComponent(`/pricebook/v2/tenant/431848990/equipment?${qs}`)}`,
      { headers: authHeaders(env, correlation, actor) }
    );
    if (!resp.ok) throw new McpError('upstream_error', `get_configurable_equipment_children failed: ${resp.status}`, { correlation });
    const data = await resp.json<{ data?: unknown[] }>();
    return { equipment: data.data ?? [], _source: 'live' };
  },
};
