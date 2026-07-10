import { z } from 'zod';
import { readST } from '../../st';
import type { ToolDef } from '../index';
import { defaultShaper } from '../../response-shape';

interface Args { estimateId: number }

// verified 2026-07-09: /sales/v2 estimates/{id} route EXISTS (logical 404 "Estimate ID = X was not found" on missing ids) — not in the no-by-id-route class.
export const get_estimate: ToolDef<Args> = {
  name: 'get_estimate',
  description: 'Get full details for a single estimate including line items and status. Source: live ST.',
  zodSchema: {
    estimateId: z.number().int().positive().describe('ST estimate ID'),
  },
  // Envelope precise (estimate/_source always present). The handler itself
  // types `estimate` as `readST<unknown>` — the live ST payload shape isn't
  // locally guaranteed, so this stays fully permissive (z.unknown()).
  outputSchema: {
    estimate: z.unknown(),
    _source: z.string(),
  },
  stEndpoint: { method: 'GET', path: '/sales/v2/tenant/{tid}/estimates/{estimateId}', source: 'live' },
  async handler(env, args, { actor, correlation }) {
    const data = await readST<unknown>(
      env,
      { actor, correlation },
      `/sales/v2/tenant/000000000/estimates/${args.estimateId}`,
    );
    return { estimate: data, _source: 'live' };
  },
  transformResult: defaultShaper,
};
