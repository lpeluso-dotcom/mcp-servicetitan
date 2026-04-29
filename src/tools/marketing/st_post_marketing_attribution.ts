// ============================================================
// st_post_marketing_attribution — write tool, kind discriminator
// over four ST marketingads attribution endpoints.
//
//   kind=job              → POST /marketingads/v2/tenant/{tid}/job-attributions
//   kind=web_booking      → POST /marketingads/v2/tenant/{tid}/web-booking-attributions
//   kind=web_lead_form    → POST /marketingads/v2/tenant/{tid}/web-lead-form-attributions
//   kind=external_call    → POST /marketingads/v2/tenant/{tid}/external-call-attributions
//
// All four take the same shape: top-level ID + `attributionData` object with
// utm_*, gclid/fbclid, landing/referrer URLs, sessionId/clientId.
//
// Distinct from `create_call_with_campaign` — that POSTs /telecom/v3/.../calls
// with a campaignId stitched in. This tool is the FULL attribution payload.
// ============================================================
import { z } from 'zod';
import { defineWriteTool } from '../../write-tool-factory';

const Kind = z.enum(['job', 'web_booking', 'web_lead_form', 'external_call']);
type KindT = z.infer<typeof Kind>;

const AttributionData = z
  .object({
    utmSource: z.string().optional(),
    utmMedium: z.string().optional(),
    utmCampaign: z.string().optional(),
    utmContent: z.string().optional(),
    utmTerm: z.string().optional(),
    landingPageUrl: z.string().optional(),
    referrerUrl: z.string().optional(),
    gclid: z.string().optional(),
    fbclid: z.string().optional(),
    sessionId: z.string().optional(),
    clientId: z.string().optional(),
  })
  .describe('Attribution payload — UTM source/medium/campaign, click IDs, landing page, session/client IDs. All optional but at least one is typically required.');

interface Args {
  kind: KindT;
  jobId?: number;
  bookingId?: number;
  leadFormId?: number;
  externalCallId?: string;
  callId?: number;
  attributionData: z.infer<typeof AttributionData>;
  dryRun?: boolean;
  confirmation_token?: string;
}

const KIND_PATH: Record<KindT, string> = {
  job: 'job-attributions',
  web_booking: 'web-booking-attributions',
  web_lead_form: 'web-lead-form-attributions',
  external_call: 'external-call-attributions',
};

export const st_post_marketing_attribution = defineWriteTool<Args>({
  name: 'st_post_marketing_attribution',
  description:
    'Post a full marketing attribution payload to ServiceTitan via one of four kind-specific endpoints (job-attributions, web-booking-attributions, web-lead-form-attributions, external-call-attributions). attributionData carries UTM/click/session fields. Distinct from create_call_with_campaign (which POSTs /telecom/v3/.../calls with just a campaignId). dryRun=true (default) → token → dryRun=false to write.',
  zodSchema: {
    kind: Kind.describe('Which attribution endpoint to target'),
    jobId: z.number().int().positive().optional().describe('Required when kind=job'),
    bookingId: z.number().int().positive().optional().describe('Required when kind=web_booking'),
    leadFormId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Required when kind=web_lead_form'),
    externalCallId: z
      .string()
      .optional()
      .describe('Required when kind=external_call (or pass callId instead)'),
    callId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Alternative to externalCallId for kind=external_call'),
    attributionData: AttributionData,
  },
  validate: (args) => {
    switch (args.kind) {
      case 'job':
        if (args.jobId === undefined) throw new Error('jobId is required when kind=job');
        break;
      case 'web_booking':
        if (args.bookingId === undefined)
          throw new Error('bookingId is required when kind=web_booking');
        break;
      case 'web_lead_form':
        if (args.leadFormId === undefined)
          throw new Error('leadFormId is required when kind=web_lead_form');
        break;
      case 'external_call':
        if (args.externalCallId === undefined && args.callId === undefined) {
          throw new Error('externalCallId or callId is required when kind=external_call');
        }
        break;
    }
  },
  endpoint: ({ kind }) => `/marketingads/v2/tenant/431848990/${KIND_PATH[kind]}`,
  method: 'POST',
  payload: ({
    kind,
    jobId,
    bookingId,
    leadFormId,
    externalCallId,
    callId,
    attributionData,
  }) => {
    const body: Record<string, unknown> = { attributionData };
    if (kind === 'job') body.jobId = jobId;
    if (kind === 'web_booking') body.bookingId = bookingId;
    if (kind === 'web_lead_form') body.leadFormId = leadFormId;
    if (kind === 'external_call') {
      if (externalCallId !== undefined) body.externalCallId = externalCallId;
      if (callId !== undefined) body.callId = callId;
    }
    return body;
  },
  businessArgs: ({
    kind,
    jobId,
    bookingId,
    leadFormId,
    externalCallId,
    callId,
    attributionData,
  }) => ({ kind, jobId, bookingId, leadFormId, externalCallId, callId, attributionData }),
  stEndpointTemplate: '/marketingads/v2/tenant/{tid}/{kind}-attributions',
});
