import { z } from 'zod';
import { readST } from '../../st';
import type { ToolDef } from '../index';
import { defaultShaper } from '../../response-shape';

const TENANT_ID = '000000000';

interface Args { parentEquipmentId: number }

interface ParentEquipment {
  id?: number;
  isConfigurableEquipment?: boolean;
  variationsOrConfigurableEquipment?: unknown[];
}

// ST has no parentEquipmentId filter on the /equipment list endpoint — unknown
// query params are silently ignored and the unfiltered first page comes back.
// Variant linkage is only readable on the parent record itself, via the
// read-only variationsOrConfigurableEquipment array.
export const get_configurable_equipment_children: ToolDef<Args> = {
  name: 'get_configurable_equipment_children',
  description: 'Get child equipment variations for a configurable (parent) equipment item, read from the parent record\'s variationsOrConfigurableEquipment array. ST vocabulary: isConfigurableEquipment=true on the parent. Source: live ST (pb_equipment 37d stale in D1).',
  zodSchema: {
    parentEquipmentId: z.number().int().positive().describe('ST pricebook equipment ID of the parent (isConfigurableEquipment=true)'),
  },
  stEndpoint: { method: 'GET', path: '/pricebook/v2/tenant/{tid}/equipment/{parentEquipmentId}', source: 'live' },
  async handler(env, args, { actor, correlation }) {
    const parent = await readST<ParentEquipment>(
      env,
      { actor, correlation },
      `/pricebook/v2/tenant/${TENANT_ID}/equipment/${args.parentEquipmentId}`,
    );
    return {
      parentEquipmentId: args.parentEquipmentId,
      isConfigurableEquipment: parent.isConfigurableEquipment ?? false,
      equipment: parent.variationsOrConfigurableEquipment ?? [],
      _source: 'live',
    };
  },
  transformResult: defaultShaper,
};
