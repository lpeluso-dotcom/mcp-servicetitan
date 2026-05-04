// T10 catalog correction: renamed from create_lead_attribution_call.
// ST has no "lead attribution" object — POST /telecom/v3/tenant/.../calls
// with {campaignId, customerId, leadCallId} stitched in.
// H1: migrated to defineWriteTool factory 2026-04-26.
import { z } from 'zod';
import { defineWriteTool } from '../../write-tool-factory';

interface Args {
  customerId: number;
  campaignId: number;
  leadCallId?: string;
  dryRun?: boolean;
  confirmation_token?: string;
}

export const create_call_with_campaign = defineWriteTool<Args>({
  name: 'create_call_with_campaign',
  description: 'Create a telecom call record attributed to a marketing campaign. Note: ST has no "lead attribution" object — this POSTs to /telecom/v3/tenant/.../calls with campaignId stitched in. dryRun=true (default) → token → dryRun=false to write. For full attribution payloads (UTM source/medium/campaign, gclid/fbclid, landing page), use `st_post_marketing_attribution` with `kind=external_call`.',
  zodSchema: {
    customerId: z.number().int().positive().describe('ST customer ID'),
    campaignId: z.number().int().positive().describe('ST campaign ID to attribute the call to'),
    leadCallId: z.string().optional().describe('External call ID from your call tracking system (e.g. Lace)'),
  },
  endpoint: () => `/telecom/v3/tenant/000000000/calls`,
  method: 'POST',
  payload: ({ customerId, campaignId, leadCallId }) => {
    const body: Record<string, unknown> = { customerId, campaignId };
    if (leadCallId) body.leadCallId = leadCallId;
    return body;
  },
  businessArgs: ({ customerId, campaignId, leadCallId }) => ({ customerId, campaignId, leadCallId }),
  stEndpointTemplate: '/telecom/v3/tenant/{tid}/calls',
});
