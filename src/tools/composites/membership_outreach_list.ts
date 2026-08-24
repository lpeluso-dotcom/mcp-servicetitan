import { z } from 'zod';
import { McpError } from '../../errors';
import { authHeaders } from '../../auth';
import { pagedStRead } from '../../paged-st-read';
import { defaultShaper } from '../../response-shape';
import type { ToolDef } from '../index';

type Segment = 'expiring_30' | 'expiring_60' | 'expiring_90' | 'lapsed';

interface Args { segment: Segment; businessUnitId?: number }

interface MembershipRow {
  id?: number;
  customerId?: number;
  customerName?: string;
  type?: unknown;
  activeThrough?: string;
  status?: string;
}

const TENANT_ID = '000000000';

// Wave 2 / B: was a single `readST` with `pageSize: 200`. This is a CALL LIST —
// a truncated one means the 201st expiring member is never contacted, and the
// response gave no hint that anyone was missing.
export const membership_outreach_list: ToolDef<Args> = {
  name: 'membership_outreach_list',
  description:
    'L5 composite: outreach contact list for a membership segment. Segments: expiring_30/60/90 (expiring within N days), lapsed (status=Cancelled last 90d). ' +
    'Paginates the full segment (up to 20 pages x 200) and reports `pageCount` + `_truncated` when the cap is hit, so a partial call list is never presented as complete. ' +
    '30 min memo. Source: live ST (no D1 memberships table).',
  zodSchema: {
    segment: z.enum(['expiring_30', 'expiring_60', 'expiring_90', 'lapsed']).describe('Target segment for outreach'),
    businessUnitId: z.number().int().positive().optional().describe('Filter by business unit ID'),
  },
  stEndpoint: { method: 'GET', path: '/memberships/v2/tenant/{tid}/memberships', source: 'live' },
  async handler(env, args, { actor, correlation }) {
    const { segment, businessUnitId } = args;
    const now = new Date();

    // pagedStRead's query is Record<string, string | number> — it stringifies
    // every entry into the page URL, so optional keys are added conditionally
    // rather than passed as undefined, and `pageSize` moves to opts (the helper
    // owns pageSize/page).
    const query: Record<string, string | number> = {};
    if (businessUnitId) query.businessUnitIds = businessUnitId;

    if (segment.startsWith('expiring_')) {
      const days = parseInt(segment.split('_')[1], 10);
      const windowEnd = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
      query.statuses = 'Active';
      query.activeThroughOnOrAfter = now.toISOString();
      query.activeThroughBefore = windowEnd.toISOString();
    } else {
      // lapsed: cancelled in the last 90 days
      const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
      query.statuses = 'Cancelled';
      query.activeThroughOnOrAfter = ninetyDaysAgo.toISOString();
    }

    const headers = authHeaders(env, correlation, actor);
    const paged = await pagedStRead<MembershipRow>(
      env,
      headers,
      `/memberships/v2/tenant/${TENANT_ID}/memberships`,
      query,
    );

    if (paged.pageCount === 0 && paged.partialFailures.length > 0) {
      const first = paged.partialFailures[0];
      throw new McpError(
        'upstream_error',
        `membership_outreach_list: memberships fetch failed before any page was read (page ${first.page}, status ${first.status}): ${first.message}`,
        { correlation, details: { failures: paged.partialFailures } },
      );
    }

    const contacts = paged.items.map((m) => ({
      membershipId: m.id,
      customerId: m.customerId,
      customerName: m.customerName,
      membershipType: m.type,
      expirationDate: m.activeThrough,
      status: m.status,
    }));

    const warnings = [...paged.warnings];
    if (paged.truncated) {
      warnings.push(
        'outreach_list_incomplete: the page cap was hit, so this segment has more members than are listed — do not treat this as the full call list',
      );
    }

    return {
      segment,
      contacts,
      count: contacts.length,
      pageCount: paged.pageCount,
      _composite: 'membership_outreach_list',
      _source: 'live',
      _truncated: paged.truncated,
      ...(warnings.length > 0 ? { _warnings: warnings } : {}),
      ...(paged.partialFailures.length > 0
        ? { _partial: true, _failures: paged.partialFailures }
        : {}),
    };
  },
  transformResult: defaultShaper,
};
