// ============================================================
// st_create_material — POST a new pricebook material
// F3: dryRun=true (default) → confirmation_token → dryRun=false → durable write.
// ============================================================

import { z } from 'zod';
import { McpError } from '../errors';
import { WriteGate } from '../write-gate';
import type { ToolDef } from './index';
import { durableWrite } from './st_patch_service';
import { toStPricebookPayload } from './pricebook-payload';

interface Args {
  name: string;
  categoryId: number;
  code?: string;
  description?: string;
  cost?: number;
  price?: number;
  active?: boolean;
  unitOfMeasure?: string;
  primaryVendor?: { vendorId: number; cost?: number; active?: boolean };
  primaryVendorId?: number;
  primaryVendorCost?: number;
  dryRun?: boolean;
  confirmation_token?: string;
}

type ResolvedVendor = { vendorId: number; cost?: number; active: boolean };

// ST requires exactly one primary vendor on material create. Accept either a
// nested primaryVendor object or the flat primaryVendorId/primaryVendorCost
// shorthand; default the vendor cost to the material cost. Returns null when
// no vendor was supplied (caller turns that into a validation_error).
function resolvePrimaryVendor(
  nested: Args['primaryVendor'],
  flatId: number | undefined,
  flatCost: number | undefined,
  materialCost: number | undefined,
): ResolvedVendor | null {
  if (nested && typeof nested.vendorId === 'number') {
    return { vendorId: nested.vendorId, cost: nested.cost ?? materialCost, active: nested.active ?? true };
  }
  if (typeof flatId === 'number') {
    return { vendorId: flatId, cost: flatCost ?? materialCost, active: true };
  }
  return null;
}

export const st_create_material: ToolDef<Args> = {
  name: 'st_create_material',
  description:
    'Create a new ServiceTitan pricebook material. ' +
    'dryRun=true (default) validates and returns a confirmation_token — call again with dryRun=false + token to write. ' +
    'Requires name and categoryId at minimum. A primary vendor is also required ' +
    '(primaryVendor:{vendorId} or the flat primaryVendorId) — ST rejects a material create without exactly one primary vendor. ' +
    'Source: live ST.',
  isWrite: true,
  stEndpoint: { method: 'POST', path: '/pricebook/v2/tenant/{tid}/materials', source: 'live' },
  zodSchema: {
    name: z.string().min(1).describe('Display name for the material'),
    categoryId: z.number().int().positive().describe('Pricebook category ID (required by ST)'),
    code: z.string().optional().describe('Material code'),
    description: z.string().optional().describe('Material description'),
    cost: z.number().optional().describe('Internal cost per unit'),
    price: z.number().optional().describe('Price per unit charged to the customer'),
    active: z.boolean().optional().describe('Whether active in pricebook (default true)'),
    unitOfMeasure: z.string().optional().describe('Unit of measure (e.g. "Each", "Box")'),
    primaryVendor: z.object({
      vendorId: z.number().int().positive().describe('ST vendor ID (see inventory_vendors_list)'),
      cost: z.number().optional().describe('Vendor cost per unit; defaults to the material cost when omitted'),
      active: z.boolean().default(true).describe('Whether this vendor link is active'),
    }).optional().describe('Primary vendor — REQUIRED by ST (exactly one). Supply this or primaryVendorId.'),
    primaryVendorId: z.number().int().positive().optional().describe('Shorthand: primary vendor ID (alternative to the primaryVendor object)'),
    primaryVendorCost: z.number().optional().describe('Shorthand: primary vendor cost (used with primaryVendorId; defaults to material cost)'),
    dryRun: z.boolean().default(true).describe('true (default) = preview + token; false = execute write'),
    confirmation_token: z.string().optional().describe('Token from prior dryRun=true call, required when dryRun=false'),
  },
  async handler(env, args, { actor, correlation }) {
    const { dryRun = true, confirmation_token, primaryVendorId, primaryVendorCost, ...rest } = args;
    const vendor = resolvePrimaryVendor(rest.primaryVendor, primaryVendorId, primaryVendorCost, rest.cost);
    if (!vendor) {
      throw new McpError('validation_error',
        'primaryVendor is required: ServiceTitan rejects a material create without exactly one primary vendor. ' +
        'Pass primaryVendor:{vendorId,…} or primaryVendorId.', { correlation });
    }
    const payload = { ...rest, primaryVendor: vendor };
    const stPayload = toStPricebookPayload(payload);
    const gate = new WriteGate(env);

    if (dryRun) {
      return gate.dryRun('st_create_material', payload, actor, correlation, stPayload, '/pricebook/v2/tenant/000000000/materials', 'POST', 5 * 60 * 1000);
    }
    if (!confirmation_token) {
      throw new McpError('validation_error', 'confirmation_token required when dryRun=false', { correlation });
    }
    await gate.verifyToken('st_create_material', payload, actor, confirmation_token);
    return durableWrite(env, { actor, operation: 'material.create', target: { id: '0', type: 'material' }, payload: stPayload, correlation });
  },
};
