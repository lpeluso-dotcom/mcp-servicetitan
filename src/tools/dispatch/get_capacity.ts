import { z } from 'zod';
import { readSTPost } from '../../st';
import type { ToolDef } from '../index';
import { defaultShaper } from '../../response-shape';

interface Args {
  businessUnitIds: number[];
  startDate: string;
  endDate: string;
  skillBasedAvailability?: boolean;
}

// get_capacity POSTs to ST /dispatch/v2/tenant/{t}/capacity. The previously-used
// /capacity-planning route does not exist in ST (404 "Unable to match an operation").
// NOTE: this now hits the SAME ST /capacity operation as st_get_capacity_slots — the two
// overlap and should be deduped in a follow-up; and ST must grant the /capacity scope to
// this tenant's token (currently 403) before either tool returns data.
export const get_capacity: ToolDef<Args> = {
  name: 'get_capacity',
  description: 'Get dispatch capacity for business units over a date range (POST to ST /dispatch/v2/.../capacity; the body carries the filters). Overlaps st_get_capacity_slots — both call ST /capacity. Source: live ST.',
  zodSchema: {
    businessUnitIds: z.array(z.number().int().positive()).min(1).describe('Business unit IDs to check capacity for'),
    startDate: z.string().describe('Start date (YYYY-MM-DD)'),
    endDate: z.string().describe('End date (YYYY-MM-DD)'),
    skillBasedAvailability: z.boolean().optional().describe('Use skill-based availability matching (default: false)'),
  },
  stEndpoint: {
    method: 'POST',
    path: '/dispatch/v2/tenant/{tid}/capacity',
    source: 'live',
  },
  async handler(env, args, { actor, correlation }) {
    // ST /capacity expects startsOnOrAfter/endsOnOrBefore (not startDate/endDate).
    const body = {
      businessUnitIds: args.businessUnitIds,
      startsOnOrAfter: args.startDate,
      endsOnOrBefore: args.endDate,
      skillBasedAvailability: args.skillBasedAvailability ?? false,
    };

    const data = await readSTPost<unknown>(
      env,
      { actor, correlation },
      '/dispatch/v2/tenant/000000000/capacity',
      body,
    );
    return { capacity: data, _source: 'live' };
  },
  transformResult: defaultShaper,
};
