import { z } from 'zod';
import { McpError } from '../../errors';
import { authHeaders } from '../../auth';
import type { ToolDef } from '../index';

type Segment = 'expiring_30' | 'expiring_60' | 'expiring_90' | 'lapsed';

interface Args { segment: Segment; businessUnitId?: number }

export const membership_outreach_list: ToolDef<Args> = {
  name: 'membership_outreach_list',
  description: 'L5 composite: outreach contact list for a membership segment. Segments: expiring_30/60/90 (expiring within N days), lapsed (status=Cancelled last 90d). 30 min memo. Source: live ST (no D1 memberships table).',
  zodSchema: {
    segment: z.enum(['expiring_30', 'expiring_60', 'expiring_90', 'lapsed']).describe('Target segment for outreach'),
    businessUnitId: z.number().int().positive().optional().describe('Filter by business unit ID'),
  },
  async handler(env, args, { actor, correlation }) {
    const { segment, businessUnitId } = args;
    const now = new Date();
    const h = authHeaders(env, correlation, actor);
    const tenant = '431848990';

    const qs = new URLSearchParams();
    if (businessUnitId) qs.set('businessUnitIds', String(businessUnitId));
    qs.set('pageSize', '200');

    if (segment.startsWith('expiring_')) {
      const days = parseInt(segment.split('_')[1], 10);
      const windowEnd = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
      qs.set('statuses', 'Active');
      qs.set('activeThroughOnOrAfter', now.toISOString());
      qs.set('activeThroughBefore', windowEnd.toISOString());
    } else {
      // lapsed: cancelled in the last 90 days
      const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
      qs.set('statuses', 'Cancelled');
      qs.set('activeThroughOnOrAfter', ninetyDaysAgo.toISOString());
    }

    const resp = await env.TAYLOR_AI.fetch(
      `https://taylor-ai/api/st/read?endpoint=${encodeURIComponent(`/memberships/v2/tenant/${tenant}/memberships?${qs}`)}`,
      { headers: h }
    );
    if (!resp.ok) throw new McpError('upstream_error', `membership_outreach_list failed: ${resp.status}`, { correlation });
    const data = await resp.json<{ data?: any[] }>();
    const memberships = data.data ?? [];

    const contacts = memberships.map((m) => ({
      membershipId: m.id,
      customerId: m.customerId,
      customerName: m.customerName,
      membershipType: m.type,
      expirationDate: m.activeThrough,
      status: m.status,
    }));

    return {
      segment,
      contacts,
      count: contacts.length,
      _composite: 'membership_outreach_list',
      _source: 'live',
    };
  },
};
