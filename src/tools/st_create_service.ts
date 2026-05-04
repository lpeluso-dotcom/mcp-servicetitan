// ============================================================
// st_create_service — POST a new pricebook service
// F3: dryRun=true (default) → confirmation_token → dryRun=false → durable write.
// ============================================================

import { z } from 'zod';
import { McpError } from '../errors';
import { WriteGate } from '../write-gate';
import type { ToolDef } from './index';
import { durableWrite } from './st_patch_service';

interface Args {
  name: string;
  categoryId: number;
  code?: string;
  description?: string;
  cost?: number;
  price?: number;
  useStaticPrice?: boolean;
  active?: boolean;
  dryRun?: boolean;
  confirmation_token?: string;
}

export const st_create_service: ToolDef<Args> = {
  name: 'st_create_service',
  description:
    'Create a new ServiceTitan pricebook service. ' +
    'dryRun=true (default) validates and returns a confirmation_token — call again with dryRun=false + token to write. ' +
    'This deployment uses dynamic pricing (useStaticPrice=false) — do NOT set price unless this is a static-price service.',
  isWrite: true,
  zodSchema: {
    name: z.string().min(1).describe('Display name for the service'),
    categoryId: z.number().int().positive().describe('Pricebook category ID (required by ST)'),
    code: z.string().optional().describe('Service code (e.g. "HVAC-DIAG-01")'),
    description: z.string().optional().describe('Service description shown on invoices'),
    cost: z.number().optional().describe('Internal cost'),
    price: z.number().optional().describe('Static price. Only set when useStaticPrice=true.'),
    useStaticPrice: z.boolean().optional().describe('true = static price; false = dynamic markup (deployment default)'),
    active: z.boolean().optional().describe('Whether active in pricebook (default true)'),
    dryRun: z.boolean().default(true).describe('true (default) = preview + token; false = execute write'),
    confirmation_token: z.string().optional().describe('Token from prior dryRun=true call, required when dryRun=false'),
  },
  async handler(env, args, { actor, correlation }) {
    const { dryRun = true, confirmation_token, ...payload } = args;
    const gate = new WriteGate(env);

    if (dryRun) {
      return gate.dryRun('st_create_service', payload, actor, correlation, payload, '/pricebook/v2/tenant/000000000/services', 'POST', 5 * 60 * 1000);
    }
    if (!confirmation_token) {
      throw new McpError('validation_error', 'confirmation_token required when dryRun=false', { correlation });
    }
    await gate.verifyToken('st_create_service', payload, actor, confirmation_token);
    return durableWrite(env, { actor, operation: 'service.create', target: { id: '0', type: 'service' }, payload, correlation });
  },
};
