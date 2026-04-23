import { z } from 'zod';
import { McpError } from '../../errors';
import { authHeaders } from '../../auth';
import type { ToolDef } from '../index';

interface Args { formSubmissionId: number }

// Note: form submissions return unit IDs (not equipment IDs).
// join via forms_equipment D1 table is done at the composite layer (job_closeout_report).
export const get_form_submission: ToolDef<Args> = {
  name: 'get_form_submission',
  description: 'Get a form submission record. Note: form submissions return unit IDs, not equipment IDs — equipment join is done in the job_closeout_report composite via the forms_equipment D1 table. Source: live ST.',
  zodSchema: {
    formSubmissionId: z.number().int().positive().describe('ST form submission ID'),
  },
  async handler(env, args, { actor, correlation }) {
    const resp = await env.TAYLOR_AI.fetch(
      `https://taylor-ai/api/st/read?endpoint=${encodeURIComponent(`/forms/v2/tenant/431848990/submissions/${args.formSubmissionId}`)}`,
      { headers: authHeaders(env, correlation, actor) }
    );
    if (!resp.ok) throw new McpError('upstream_error', `get_form_submission failed: ${resp.status}`, { correlation });
    const data = await resp.json<unknown>();
    return { formSubmission: data, _source: 'live' };
  },
};
