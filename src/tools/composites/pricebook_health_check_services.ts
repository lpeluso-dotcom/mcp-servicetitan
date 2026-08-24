import { z } from 'zod';
import { McpError } from '../../errors';
import { authHeaders } from '../../auth';
import { pagedStRead } from '../../paged-st-read';
import { defaultShaper } from '../../response-shape';
import type { ToolDef } from '../index';

interface Args { activeOnly?: boolean }

interface ServiceRow {
  id?: number;
  name?: string;
  cost?: number | null;
  price?: number | null;
  active?: boolean;
  category?: { id?: number } | null;
}

const TENANT_ID = '000000000';

const DYNAMIC_PRICING_NOTE =
  'QSC runs ServiceTitan dynamic pricing (Pricebook Pro): a 0/null/absent cost or price on a service ' +
  'is NOT unpriced and NOT a defect — the number is computed at invoice time from rules, business unit, ' +
  'membership tier and labor. `dynamicPricedCount` is informational only and does not affect `healthy`. ' +
  'Same rule as supabase.ts shapePriceRow (price_basis: dynamic — computed at invoice).';

// Reads live ST pricebook services (not D1). Services-only.
// pb_materials + pb_equipment health blocked until §13#1 sync fix ships.
//
// Wave 2 / B, two fixes:
//   * `healthy` used to require zero zero-cost services, which contradicts
//     QSC's dynamic pricing outright — a correctly configured pricebook was
//     reported UNHEALTHY and its working items listed as "zeroCostServices".
//   * `summary.total` was `services.length` from ONE 200-row page, presented
//     as the size of the pricebook. It now covers the drained population and
//     says so via `populationComplete` / `_truncated`.
export const pricebook_health_check_services: ToolDef<Args> = {
  name: 'pricebook_health_check_services',
  description:
    'L5 composite: pricebook health check for SERVICES only. Health = every service has a category; ' +
    'a 0/blank cost is NOT a defect (QSC runs dynamic pricing — the price is computed at invoice time), so it is reported ' +
    'as `dynamicPricedCount` for information and never fails the check. Paginates the whole services population ' +
    '(up to 20 pages x 200) and reports `pageCount` + `_truncated`; `summary.populationComplete` says whether the verdict covers the full pricebook. ' +
    'Materials + equipment blocked until nightly sync fix (§13#1). Source: live ST (pricebook services).',
  zodSchema: {
    activeOnly: z.boolean().default(true).describe('Only check active services (default: true)'),
  },
  stEndpoint: { method: 'GET', path: '/pricebook/v2/tenant/{tid}/services', source: 'live' },
  async handler(env, args, { actor, correlation }) {
    const query: Record<string, string | number> = {};
    if (args.activeOnly !== false) query.active = 'true';

    const headers = authHeaders(env, correlation, actor);
    const paged = await pagedStRead<ServiceRow>(
      env,
      headers,
      `/pricebook/v2/tenant/${TENANT_ID}/services`,
      query,
    );

    if (paged.pageCount === 0 && paged.partialFailures.length > 0) {
      const first = paged.partialFailures[0];
      throw new McpError(
        'upstream_error',
        `pricebook_health_check_services: services fetch failed before any page was read (page ${first.page}, status ${first.status}): ${first.message}`,
        { correlation, details: { failures: paged.partialFailures } },
      );
    }

    const services = paged.items;

    // Informational only. NOT a health signal — see DYNAMIC_PRICING_NOTE.
    const dynamicPriced = services.filter(
      (s) => (s.cost === undefined || s.cost === null || s.cost === 0)
        && (s.price === undefined || s.price === null || s.price === 0),
    );
    // A genuine defect: a service with no category breaks reporting and GL
    // mapping no matter how its price is computed.
    const noCategory = services.filter((s) => !s.category?.id);
    const inactive = services.filter((s) => s.active === false);

    // A verdict over a partial population cannot claim the pricebook is clean:
    // the missing pages could hold every uncategorised service.
    const populationComplete = !paged.truncated && paged.partialFailures.length === 0;

    const warnings = [...paged.warnings];
    if (!populationComplete) {
      warnings.push(
        'partial_population: the services read stopped short of the full pricebook, so `healthy` describes only what was examined',
      );
    }

    return {
      summary: {
        total: services.length,
        populationComplete,
        dynamicPricedCount: dynamicPriced.length,
        noCategoryCount: noCategory.length,
        inactiveCount: inactive.length,
        healthy: populationComplete && noCategory.length === 0,
      },
      noCategoryServices: noCategory.map((s) => ({ id: s.id, name: s.name })),
      dynamicPricedServices: dynamicPriced.map((s) => ({ id: s.id, name: s.name })),
      pageCount: paged.pageCount,
      _composite: 'pricebook_health_check_services',
      _source: 'live',
      _truncated: paged.truncated,
      _note: `${DYNAMIC_PRICING_NOTE} pb_materials and pb_equipment health blocked until §13#1 nightly sync fix.`,
      ...(warnings.length > 0 ? { _warnings: warnings } : {}),
      ...(paged.partialFailures.length > 0
        ? { _partial: true, _failures: paged.partialFailures }
        : {}),
    };
  },
  transformResult: defaultShaper,
};
