import { z } from 'zod';
import { readST } from '../../st';
import { defaultShaper } from '../../response-shape';
import type { ToolDef } from '../index';

interface Args { activeOnly?: boolean }

// pb_services is FRESH (synced 2026-04-22) — D1-first read.
// pb_materials + pb_equipment blocked until §13#1 sync fix ships.
export const pricebook_health_check_services: ToolDef<Args> = {
  name: 'pricebook_health_check_services',
  description: 'L5 composite: pricebook health check for SERVICES only. Checks for zero-cost services, missing categories, and inactive items. pb_services is fresh (synced 2026-04-22). Materials + equipment blocked until nightly sync fix (§13#1). Source: D1 (pb_services).',
  zodSchema: {
    activeOnly: z.boolean().default(true).describe('Only check active services (default: true)'),
  },
  stEndpoint: { method: 'GET', path: '/pricebook/v2/tenant/{tid}/services', source: 'live' },
  async handler(env, args, { actor, correlation }) {
    const query: Record<string, unknown> = { pageSize: 200 };
    if (args.activeOnly !== false) query.active = 'true';

    const data = await readST<{ data?: any[] }>(
      env,
      { actor, correlation },
      `/pricebook/v2/tenant/000000000/services`,
      query,
    );
    const services = data.data ?? [];

    const zeroCost = services.filter((s) => (s.cost ?? 0) === 0);
    const noCategory = services.filter((s) => !s.category?.id);
    const inactive = services.filter((s) => s.active === false);

    return {
      summary: {
        total: services.length,
        zeroCostCount: zeroCost.length,
        noCategoryCount: noCategory.length,
        inactiveCount: inactive.length,
        healthy: zeroCost.length === 0 && noCategory.length === 0,
      },
      zeroCostServices: zeroCost.map((s) => ({ id: s.id, name: s.name })),
      noCategoryServices: noCategory.map((s) => ({ id: s.id, name: s.name })),
      _composite: 'pricebook_health_check_services',
      _source: 'live',
      _note: 'pb_materials and pb_equipment health blocked until §13#1 nightly sync fix',
    };
  },
  transformResult: defaultShaper,
};
