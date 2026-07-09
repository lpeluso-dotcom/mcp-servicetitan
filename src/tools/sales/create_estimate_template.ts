// Live-verified 2026-07-09: POST /sales/v2/tenant/{tid}/estimate-templates.
// Ground truth confirmed the GET item shape ({id, skuId, skuType, skuName,
// description, quantity, unitPrice, totalPrice, isAddOn, chargeable,
// allowDiscounts, unitCost, memo, order, parentItemId, itemGroupParentId,
// itemGroupName, projectLabels}) — but unitPrice/totalPrice/unitCost/
// description/skuName are ST-computed/denormalized FROM the referenced sku,
// not caller input, so create-time items only accept the subset the caller
// actually owns (skuId, skuType, quantity, isAddOn, chargeable,
// allowDiscounts, memo, order). NOTE: this create/update payload shape was
// not live-tested against prod (only list/get/PATCH item-shape were
// live-verified) — see create_estimate_template.test.ts's ambiguity note
// and the phase report for what's inferred vs. confirmed.
import { z } from 'zod';
import { defineWriteTool } from '../../write-tool-factory';

const CreateItemSchema = z.object({
  skuId: z.number().int().positive().describe('Pricebook SKU ID (service/material/equipment ID) this line references.'),
  skuType: z.enum(['Service', 'Material', 'Equipment']).describe('Type of the referenced SKU.'),
  quantity: z.number().positive().describe('Quantity of this line item.'),
  isAddOn: z.boolean().optional().describe('Whether this item is an optional add-on. Default false.'),
  chargeable: z.boolean().optional().describe('Whether this item is billable. Default true.'),
  allowDiscounts: z
    .boolean()
    .optional()
    .describe(
      'Whether discounts apply to this item. QSC convention: defaults to true when omitted — ' +
        'pass false explicitly to exclude an item from discounting.',
    ),
  memo: z.string().optional().describe('Internal memo for this line item.'),
  order: z.number().int().optional().describe('Display order within the template.'),
  // Deliberately NOT accepted here: unitPrice, totalPrice, unitCost, description,
  // skuName. Those are ST-computed/denormalized from the sku at price-calc time —
  // passing them is a no-op (zod strips unknown keys by default).
});

type CreateItemArgs = z.infer<typeof CreateItemSchema>;

interface Args {
  name: string;
  internalName?: string;
  summary?: string;
  mode: 'Dynamic' | 'Static';
  businessUnitId?: number;
  items: CreateItemArgs[];
  dryRun?: boolean;
  confirmation_token?: string;
}

function buildItemPayload(item: CreateItemArgs): Record<string, unknown> {
  const out: Record<string, unknown> = {
    skuId: item.skuId,
    skuType: item.skuType,
    quantity: item.quantity,
    isAddOn: item.isAddOn ?? false,
    chargeable: item.chargeable ?? true,
    // QSC standard convention: an omitted allowDiscounts defaults to true (per
    // the phase-4 plan notes) — most template line items should be discountable
    // unless a caller deliberately opts an item out.
    allowDiscounts: item.allowDiscounts ?? true,
  };
  if (item.memo !== undefined) out.memo = item.memo;
  if (item.order !== undefined) out.order = item.order;
  return out;
}

export const create_estimate_template = defineWriteTool<Args>({
  name: 'create_estimate_template',
  description:
    'Create a new estimate template. Item input excludes unitPrice/totalPrice/unitCost/description/skuName — ' +
    "those are ST-computed/denormalized from each item's sku, not caller-supplied. allowDiscounts on an item " +
    'defaults to true when omitted (QSC convention). dryRun=true (default) → token → dryRun=false to write. ' +
    'NOTE: this create payload shape is inferred from the (live-verified) GET/PATCH item shape and the plan\'s ' +
    'field list — it was not live-tested against a real ST create call; verify the actual response shape on first use.',
  zodSchema: {
    name: z.string().min(1).describe('Template display name'),
    internalName: z.string().optional().describe('Internal-only name (not shown to customers)'),
    summary: z.string().optional().describe('Short summary/description of the template'),
    mode: z.enum(['Dynamic', 'Static']).describe('Pricing mode — Dynamic (QSC default) computes at invoice time; Static uses fixed prices'),
    businessUnitId: z.number().int().positive().optional().describe('Business unit this template belongs to'),
    items: z.array(CreateItemSchema).describe('Line items to include in the template'),
  },
  endpoint: () => `/sales/v2/tenant/000000000/estimate-templates`,
  method: 'POST',
  payload: (args) => {
    const body: Record<string, unknown> = {
      name: args.name,
      mode: args.mode,
      items: args.items.map(buildItemPayload),
    };
    if (args.internalName !== undefined) body.internalName = args.internalName;
    if (args.summary !== undefined) body.summary = args.summary;
    if (args.businessUnitId !== undefined) body.businessUnitId = args.businessUnitId;
    return body;
  },
  stEndpointTemplate: '/sales/v2/tenant/{tid}/estimate-templates',
});
