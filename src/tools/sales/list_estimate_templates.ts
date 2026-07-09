// Live-verified 2026-07-09: GET /sales/v2/tenant/{tid}/estimate-templates
// -> { page, pageSize, hasMore, totalCount, data: Template[] }. The older
// KB doc's /salestech/v2 namespace is WRONG (confirmed 404) — /sales/v2 is
// the correct namespace, same as estimates themselves.
import { z } from 'zod';
import { readSTPaged } from '../../st';
import type { ToolDef } from '../index';
import { defaultShaper } from '../../response-shape';

interface Args {
  active?: 'Any' | 'True' | 'False';
  businessUnitId?: number;
}

export const list_estimate_templates: ToolDef<Args> = {
  name: 'list_estimate_templates',
  description:
    'List estimate templates (reusable line-item bundles used to build estimates). ' +
    'Defaults to active=Any rather than active-only — an active-only default would hide the ' +
    'inactive/retired templates that people most often need to find and re-edit. Pass ' +
    'active="True" to see only active templates. Source: live ST.',
  zodSchema: {
    active: z
      .enum(['Any', 'True', 'False'])
      .optional()
      .describe('Filter by active flag. Default "Any" (see description for why active-only is not the default).'),
    businessUnitId: z.number().int().positive().optional().describe('Filter by business unit ID'),
  },
  stEndpoint: { method: 'GET', path: '/sales/v2/tenant/{tid}/estimate-templates', source: 'live' },
  async handler(env, args, { actor, correlation }) {
    const { rows, totalCount } = await readSTPaged<Record<string, unknown>>(
      env,
      { actor, correlation },
      '/sales/v2/tenant/000000000/estimate-templates',
      { active: args.active ?? 'Any', businessUnitId: args.businessUnitId },
      { pageSize: 200 },
    );
    return { templates: rows, count: totalCount ?? rows.length, _source: 'live' };
  },
  transformResult: defaultShaper,
};
