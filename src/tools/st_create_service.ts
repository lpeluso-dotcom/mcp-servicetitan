// ============================================================
// st_create_service — POST a new pricebook service
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
  categoryId?: number;
  categories?: number[];
  code?: string;
  description?: string;
  cost?: number;
  price?: number;
  memberPrice?: number;
  useStaticPrices?: boolean;
  hours?: number;
  isLabor?: boolean;
  taxable?: boolean;
  account?: string;
  paysCommission?: boolean;
  active?: boolean;
  dryRun?: boolean;
  confirmation_token?: string;
}

export const st_create_service: ToolDef<Args> = {
  name: 'st_create_service',
  description:
    'Create a new ServiceTitan pricebook service. ' +
    'dryRun=true (default) validates and returns a confirmation_token — call again with dryRun=false + token to write. ' +
    'QSC default is dynamic pricing — do NOT set price/memberPrice unless useStaticPrices=true. ' +
    'Use useStaticPrices: true at create time if this service needs static pricing — that flag cannot be flipped via PATCH post-create (UI-only). ' +
    'Source: live ST.',
  isWrite: true,
  stEndpoint: { method: 'POST', path: '/pricebook/v2/tenant/{tid}/services', source: 'live' },
  zodSchema: {
    name: z.string().min(1).describe('Display name for the service'),
    categoryId: z.number().int().positive().optional().describe('Pricebook category ID (single-cat shortcut; pass categories[] for multi-cat)'),
    categories: z.array(z.number().int().positive()).min(1).optional().describe('Multi-category. If passed, takes precedence over categoryId.'),
    code: z.string().optional().describe('Service code (e.g. "HVAC-DIAG-01")'),
    description: z.string().optional().describe('Service description shown on invoices'),
    cost: z.number().optional().describe('Internal cost'),
    price: z.number().optional().describe('Static price. Only meaningful when useStaticPrices=true.'),
    memberPrice: z.number().optional().describe('Member-tier static price. Only meaningful when useStaticPrices=true. Omit (or set equal to price) for no member discount.'),
    useStaticPrices: z.boolean().optional().describe('Plural — the field ST actually accepts. true at create time = static pricing. Cannot be flipped via PATCH post-create (UI-only).'),
    hours: z.number().optional().describe('Labor hours (used for cost calc on isLabor=true services)'),
    isLabor: z.boolean().optional().describe('true = labor line item; false = part/equipment/fee'),
    taxable: z.boolean().optional().describe('Whether the service is taxable'),
    account: z.string().optional().describe('GL account name (e.g. "Revenue")'),
    paysCommission: z.boolean().optional().describe('Whether commission applies on sale'),
    active: z.boolean().optional().describe('Whether active in pricebook (default true)'),
    dryRun: z.boolean().default(true).describe('true (default) = preview + token; false = execute write'),
    confirmation_token: z.string().optional().describe('Token from prior dryRun=true call, required when dryRun=false'),
  },
  async handler(env, args, { actor, correlation }) {
    const { dryRun = true, confirmation_token, ...payload } = args;
    if (payload.categoryId === undefined && (!payload.categories || payload.categories.length === 0)) {
      throw new McpError('validation_error', 'st_create_service requires either categoryId or categories[]', { correlation });
    }
    // Rewrite name→displayName and categoryId→categories[N] before submit;
    // see toStPricebookPayload for rationale. businessArgs (hash input) keeps
    // the user-facing shape so the dryRun→confirm token matches.
    const stPayload = toStPricebookPayload(payload);
    const gate = new WriteGate(env);

    if (dryRun) {
      return gate.dryRun('st_create_service', payload, actor, correlation, stPayload, '/pricebook/v2/tenant/000000000/services', 'POST', 5 * 60 * 1000);
    }
    if (!confirmation_token) {
      throw new McpError('validation_error', 'confirmation_token required when dryRun=false', { correlation });
    }
    await gate.verifyToken('st_create_service', payload, actor, confirmation_token);
    return durableWrite(env, { actor, operation: 'service.create', target: { id: '0', type: 'service' }, payload: stPayload, correlation });
  },
};
