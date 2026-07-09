// Live-verified 2026-07-09: /sales/v2/tenant/{tid}/estimate-templates/{id}
// route WORKS (200, full object) — unlike invoices/calls this is NOT in the
// no-by-id-route class, so no D1-first / fallback-scan pattern is needed.
// Mirrors get_estimate.ts's pattern: a genuine ST 404 propagates naturally
// via readST's mapUpstreamStatus (no redundant not_found wrapper).
import { z } from 'zod';
import { readST } from '../../st';
import type { ToolDef } from '../index';

interface Args {
  templateId: number;
}

export const get_estimate_template: ToolDef<Args> = {
  name: 'get_estimate_template',
  description: 'Get full details for a single estimate template, including its line items. Source: live ST.',
  zodSchema: {
    templateId: z.number().int().positive().describe('ST estimate template ID'),
  },
  outputSchema: {
    template: z.unknown(),
    _source: z.string(),
  },
  stEndpoint: { method: 'GET', path: '/sales/v2/tenant/{tid}/estimate-templates/{templateId}', source: 'live' },
  async handler(env, args, { actor, correlation }) {
    const data = await readST<unknown>(
      env,
      { actor, correlation },
      `/sales/v2/tenant/000000000/estimate-templates/${args.templateId}`,
    );
    return { template: data, _source: 'live' };
  },
};
