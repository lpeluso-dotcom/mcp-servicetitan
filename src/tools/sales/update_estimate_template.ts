// Live-verified 2026-07-09: PATCH /sales/v2/tenant/{tid}/estimate-templates/{id}
// accepts the GET item shape VERBATIM on items[] (flat, no rebuild). items[]
// is full-replacement, removal-by-omission: GET the template, build the
// survivor array client-side, PATCH the whole thing back. This tool does NOT
// rebuild or diff items — when items is provided it is forwarded exactly as
// given.
//
// ⚠ SILENT-FAIL (documented in qsc-infra/.claude/rules/servicetitan.md,
// treated as authoritative): item-level PATCH does NOT advance modifiedOn
// (the write persists correctly, but the timestamp is frozen — do not use
// modifiedOn to detect whether an item-only PATCH landed).
//
// Design correction from the original plan: no D1 refresh is performed or
// claimed. readD1 (src/d1.ts) is SELECT/WITH-only by design (defense-in-depth
// on client + server); there is no D1-write route on taylor-ai; and no
// mcp-servicetitan tool reads a D1 estimate_templates table today, so there
// is no in-repo consumer to refresh. This tool reads/writes LIVE ST only.
// Staleness only affects taylor-ai's own downstream D1 consumers (outside
// this repo), if any exist.
import { z } from 'zod';
import { defineWriteTool } from '../../write-tool-factory';

// Verbatim GET item shape. Every field is optional/passthrough here because
// the whole point is "send back exactly what GET returned" — this schema
// exists to give callers autocomplete/validation on the common fields
// without rejecting a real GET payload that includes fields not enumerated
// here (ST payload drift tolerance).
const UpdateItemSchema = z
  .object({
    id: z.number().int().optional(),
    skuId: z.number().int().optional(),
    skuType: z.string().optional(),
    skuName: z.string().optional(),
    description: z.string().nullable().optional(),
    quantity: z.number().optional(),
    unitPrice: z.number().optional(),
    totalPrice: z.number().optional(),
    isAddOn: z.boolean().optional(),
    chargeable: z.boolean().optional(),
    allowDiscounts: z.boolean().optional(),
    unitCost: z.number().optional(),
    memo: z.string().nullable().optional(),
    order: z.number().optional(),
    parentItemId: z.number().nullable().optional(),
    itemGroupParentId: z.number().nullable().optional(),
    itemGroupName: z.string().nullable().optional(),
    projectLabels: z.array(z.unknown()).optional(),
  })
  .passthrough();

interface Args {
  templateId: number;
  name?: string;
  internalName?: string;
  summary?: string;
  mode?: 'Dynamic' | 'Static';
  businessUnitId?: number;
  active?: boolean;
  items?: Array<z.infer<typeof UpdateItemSchema>>;
  dryRun?: boolean;
  confirmation_token?: string;
}

export const update_estimate_template = defineWriteTool<Args>({
  name: 'update_estimate_template',
  description:
    'Update an estimate template. Any top-level field omitted is left unchanged. items, when provided, is a ' +
    'FULL-REPLACEMENT array in the exact GET item shape (verbatim, removal-by-omission) — GET the template first, ' +
    'build the survivor list client-side, then PATCH the whole array back; omitting items entirely leaves existing ' +
    'items untouched. ⚠ Item-level PATCH does NOT advance modifiedOn (the write persists correctly, but the ' +
    'timestamp stays frozen — do not rely on modifiedOn to detect an item-only update). This tool reads/writes ' +
    'live ServiceTitan only; it does not refresh any D1 table (no D1 estimate_templates consumer exists in this repo). ' +
    'dryRun=true (default) → token → dryRun=false to write.',
  zodSchema: {
    templateId: z.number().int().positive().describe('ST estimate template ID'),
    name: z.string().min(1).optional().describe('Template display name'),
    internalName: z.string().optional().describe('Internal-only name (not shown to customers)'),
    summary: z.string().optional().describe('Short summary/description of the template'),
    mode: z.enum(['Dynamic', 'Static']).optional().describe('Pricing mode'),
    businessUnitId: z.number().int().positive().optional().describe('Business unit this template belongs to'),
    active: z.boolean().optional().describe('Active flag. Same effect as delete_estimate_template(active:false) / reactivate with true.'),
    items: z
      .array(UpdateItemSchema)
      .optional()
      .describe(
        'Full-replacement item array in the exact GET item shape (sent verbatim — removal by omission). ' +
          'Omit entirely to leave existing items untouched.',
      ),
  },
  endpoint: ({ templateId }) => `/sales/v2/tenant/000000000/estimate-templates/${templateId}`,
  method: 'PATCH',
  payload: (args) => {
    const body: Record<string, unknown> = {};
    if (args.name !== undefined) body.name = args.name;
    if (args.internalName !== undefined) body.internalName = args.internalName;
    if (args.summary !== undefined) body.summary = args.summary;
    if (args.mode !== undefined) body.mode = args.mode;
    if (args.businessUnitId !== undefined) body.businessUnitId = args.businessUnitId;
    if (args.active !== undefined) body.active = args.active;
    if (args.items !== undefined) body.items = args.items;
    return body;
  },
  stEndpointTemplate: '/sales/v2/tenant/{tid}/estimate-templates/{templateId}',
});
