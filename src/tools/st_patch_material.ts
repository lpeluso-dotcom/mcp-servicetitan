// ============================================================
// st_patch_material — PATCH a pricebook material by ID
// F3: dryRun=true (default) → confirmation_token → dryRun=false → durable write.
// ============================================================

import { z } from 'zod';
import { McpError } from '../errors';
import { WriteGate } from '../write-gate';
import type { ToolDef } from './index';
import { durableWrite } from './st_patch_service';
import { toStPricebookPayload } from './pricebook-payload';

interface Args {
  id: number;
  name?: string;
  code?: string;
  description?: string;
  cost?: number;
  price?: number;
  active?: boolean;
  categoryId?: number;
  unitOfMeasure?: string;
  dryRun?: boolean;
  confirmation_token?: string;
}

export const st_patch_material: ToolDef<Args> = {
  name: 'st_patch_material',
  description:
    'PATCH a ServiceTitan pricebook material by ID. ' +
    'dryRun=true (default) validates and returns a confirmation_token — call again with dryRun=false + token to write. ' +
    'Send only the fields you want to change.',
  isWrite: true,
  stEndpoint: { method: 'PATCH', path: '/pricebook/v2/tenant/{tid}/materials/{id}', source: 'live' },
  zodSchema: {
    id: z.number().int().positive().describe('ST pricebook material ID'),
    name: z.string().optional().describe('Display name'),
    code: z.string().optional().describe('Material code'),
    description: z.string().optional().describe('Material description'),
    cost: z.number().optional().describe('Internal cost per unit'),
    price: z.number().optional().describe('Price per unit charged to the customer'),
    active: z.boolean().optional().describe('Whether active in pricebook'),
    categoryId: z.number().int().positive().optional().describe('Pricebook category ID'),
    unitOfMeasure: z.string().optional().describe('Unit of measure (e.g. "Each", "Box")'),
    dryRun: z.boolean().default(true).describe('true (default) = preview + token; false = execute write'),
    confirmation_token: z.string().optional().describe('Token from prior dryRun=true call, required when dryRun=false'),
  },
  async handler(env, args, { actor, correlation }) {
    const { id, dryRun = true, confirmation_token, ...payload } = args;
    if (Object.keys(payload).length === 0) {
      throw new McpError('validation_error', 'st_patch_material requires at least one field to update besides id', { correlation });
    }
    const businessArgs = { id, ...payload };
    const stPayload = toStPricebookPayload(payload);
    const gate = new WriteGate(env);
    const endpoint = `/pricebook/v2/tenant/000000000/materials/${id}`;

    if (dryRun) {
      return gate.dryRun('st_patch_material', businessArgs, actor, correlation, stPayload, endpoint, 'PATCH', 5 * 60 * 1000);
    }
    if (!confirmation_token) {
      throw new McpError('validation_error', 'confirmation_token required when dryRun=false', { correlation });
    }
    await gate.verifyToken('st_patch_material', businessArgs, actor, confirmation_token);
    return durableWrite(env, { actor, operation: 'material.patch', target: { id: String(id), type: 'material' }, payload: stPayload, correlation });
  },
};
