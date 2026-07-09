import { z } from 'zod';
import { McpError } from '../../errors';
import { readD1 } from '../../d1';
import { readSTPaged } from '../../st';
import type { ToolDef } from '../index';
import { defaultShaper } from '../../response-shape';

interface Args {
  formSubmissionId: number;
  formId?: number;
}

interface D1SubmissionRow {
  submission_id: number;
  form_id: number | null;
  form_name: string | null;
  status: string | null;
  submitted_on: string;
  submitted_by_id: number | null;
  owners_json: string | null;
  units_json: string | null;
  synced_at: string;
}

// Note: form submissions return unit IDs (not equipment IDs).
// join via forms_equipment D1 table is done at the composite layer (job_closeout_report).
export const get_form_submission: ToolDef<Args> = {
  name: 'get_form_submission',
  description:
    'Get a form submission record. Source: D1-first (`form_submissions` table, nightly-synced on a submittedOnOrAfter window). ' +
    'ST has NO per-id route for submissions, and the live submissions LIST endpoint silently ignores its `ids` filter — ' +
    'even when combined with `formIds` — so a live lookup is only possible by scanning a specific form\'s submissions ' +
    '(`formIds` is the only filter ST actually honors). On a D1 miss, pass `formId` to enable that live fallback scan; ' +
    'without it, a D1 miss returns not_found immediately since there is no way to resolve a bare submission id live. ' +
    'Note: form submissions return unit IDs, not equipment IDs — equipment join is done in the job_closeout_report composite via the forms_equipment D1 table.',
  zodSchema: {
    formSubmissionId: z.number().int().positive().describe('ST form submission ID'),
    formId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'ST form ID. Required to enable a live fallback scan on a D1 miss — ST has no per-submission route, ' +
          "and the live list's `ids` filter is silently ignored (even combined with formIds); only `formIds` narrows.",
      ),
  },
  stEndpoint: { method: 'GET', path: '/forms/v2/tenant/{tid}/submissions', source: 'mixed' },
  async handler(env, args, { actor, correlation }) {
    const { rows } = await readD1<D1SubmissionRow>(
      env,
      'SELECT submission_id, form_id, form_name, status, submitted_on, submitted_by_id, owners_json, units_json, synced_at ' +
        'FROM form_submissions WHERE submission_id = ? LIMIT 1',
      [args.formSubmissionId],
    );
    if (rows.length > 0) {
      return { submission: rows[0], _source: 'd1' };
    }

    if (args.formId === undefined) {
      throw new McpError(
        'not_found',
        `form submission ${args.formSubmissionId} not found in D1. Live lookup requires formId — ST has no ` +
          `per-submission route and the live list's ids filter is silently ignored, so a bare submission id ` +
          `cannot be resolved live. Pass formId to enable a live fallback scan.`,
        { correlation },
      );
    }

    const { rows: liveRows } = await readSTPaged<Record<string, unknown>>(
      env,
      { actor, correlation },
      '/forms/v2/tenant/000000000/submissions',
      { formIds: args.formId },
      { pageSize: 200 },
    );
    const match = liveRows.find((r) => Number((r as { id?: unknown }).id) === args.formSubmissionId);
    if (!match) {
      throw new McpError(
        'not_found',
        `form submission ${args.formSubmissionId} not found in D1 or in the live scan of form ${args.formId}'s submissions`,
        { correlation },
      );
    }
    return { submission: match, _source: 'live' };
  },
  transformResult: defaultShaper,
};
