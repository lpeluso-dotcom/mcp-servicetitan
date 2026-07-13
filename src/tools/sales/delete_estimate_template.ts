// Live-verified 2026-07-09: DELETE /sales/v2/tenant/{tid}/estimate-templates/{id}
// is a SOFT-DEACTIVATE (sets active:false), reversible via
// update_estimate_template({templateId, active:true}) — not a hard delete.
// Unlike item-level PATCH (which freezes modifiedOn, see
// update_estimate_template.ts), DELETE *does* advance modifiedOn.
import { z } from 'zod';
import { defineWriteTool } from '../../write-tool-factory';

interface Args {
  templateId: number;
  dryRun?: boolean;
  confirmation_token?: string;
}

export const delete_estimate_template = defineWriteTool<Args>({
  name: 'delete_estimate_template',
  description:
    'Soft-deactivates an estimate template (sets active=false) — reversible via ' +
    'update_estimate_template({templateId, active:true}). This is NOT a hard delete. ' +
    'Note: DELETE advances modifiedOn (unlike an item-level PATCH via update_estimate_template, which freezes it). ' +
    'dryRun=true (default) → token → dryRun=false to write.',
  zodSchema: {
    templateId: z.number().int().positive().describe('ST estimate template ID'),
  },
  endpoint: ({ templateId }) => `/sales/v2/tenant/000000000/estimate-templates/${templateId}`,
  method: 'DELETE',
  payload: () => ({}),
  businessArgs: ({ templateId }) => ({ templateId }),
  stEndpointTemplate: '/sales/v2/tenant/{tid}/estimate-templates/{templateId}',
});
