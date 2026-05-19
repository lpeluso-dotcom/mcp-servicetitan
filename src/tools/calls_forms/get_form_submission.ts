import { z } from 'zod';
import { readST } from '../../st';
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
  stEndpoint: { method: 'GET', path: '/forms/v2/tenant/{tid}/submissions/{formSubmissionId}', source: 'live' },
  async handler(env, args, { actor, correlation }) {
    const data = await readST(env, { actor, correlation }, `/forms/v2/tenant/000000000/submissions/${args.formSubmissionId}`);
    return { formSubmission: data, _source: 'live' };
  },
};
