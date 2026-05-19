import { z } from 'zod';
import { readST } from '../../st';
import type { ToolDef } from '../index';

const TENANT_ID = '000000000';

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
  stEndpoint: { method: 'GET', path: '/pricebook/v2/tenant/{tid}/equipment', source: 'live' },
  async handler(env, args, { actor, correlation }) {
    const query: Record<string, unknown> = {
      parentEquipmentId: args.parentEquipmentId,
      active: args.active,
    };
    const data = await readST<{ data?: unknown[] }>(
      env,
      { actor, correlation },
      `/pricebook/v2/tenant/${TENANT_ID}/equipment`,
      query,
    );
    return { equipment: data.data ?? [], _source: 'live' };
  },
};
