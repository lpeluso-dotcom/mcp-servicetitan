import { z } from 'zod';
import { McpError } from '../../errors';
import { authHeaders } from '../../auth';
import { pagedStRead } from '../../paged-st-read';
import { defaultShaper } from '../../response-shape';
import type { ToolDef } from '../index';

interface Args { limit?: number }

interface MembershipRow {
  soldById?: number | string;
  soldByName?: string;
}

const TENANT_ID = '000000000';

// MANDATORY: anonymize employee names until 2026-07-04 per Jackpot Drive rules.
// After that date, actual names can be revealed.
const REVEAL_DATE = new Date('2026-07-04T00:00:00Z');

/** Contest start — the leaderboard is scored over the calendar year to date. */
const CONTEST_START = '2026-01-01';

// Wave 2 / B: was a single `readST` with `pageSize: 200` over a YTD contest.
// A leaderboard is a RANKING, so a dropped entrant does not just shrink the
// list — it can change who is in first place. QSC sells well past 200
// memberships in a year, so the ranking was being computed over an arbitrary
// slice with no disclosure at all.
export const membership_jackpot_leaderboard: ToolDef<Args> = {
  name: 'membership_jackpot_leaderboard',
  description:
    'L5 composite: membership sales leaderboard for the Jackpot Drive. Employee names anonymized until 2026-07-04 per Jackpot Drive rules — only rank and count are shown before that date. ' +
    'Paginates every YTD entrant (up to 20 pages x 200) before ranking, and reports `pageCount` + `_truncated`; a truncated read makes the RANKING itself unsafe and says so. ' +
    'Source: live ST (memberships). Returns up to `limit` top performers, default 10, max 50.',
  zodSchema: {
    limit: z.number().int().positive().max(50).default(10).describe('Number of top performers to return (default: 10, max: 50)'),
  },
  stEndpoint: { method: 'GET', path: '/memberships/v2/tenant/{tid}/memberships', source: 'live' },
  async handler(env, args, { actor, correlation }) {
    const { limit = 10 } = args;
    const shouldReveal = new Date() >= REVEAL_DATE;

    const headers = authHeaders(env, correlation, actor);
    const paged = await pagedStRead<MembershipRow>(
      env,
      headers,
      `/memberships/v2/tenant/${TENANT_ID}/memberships`,
      { statuses: 'Active', createdOnOrAfter: CONTEST_START },
    );

    if (paged.pageCount === 0 && paged.partialFailures.length > 0) {
      const first = paged.partialFailures[0];
      throw new McpError(
        'upstream_error',
        `membership_jackpot_leaderboard: memberships fetch failed before any page was read (page ${first.page}, status ${first.status}): ${first.message}`,
        { correlation, details: { failures: paged.partialFailures } },
      );
    }

    // Group by soldBy employee
    const counts = new Map<number | string, { count: number; name?: string }>();
    for (const m of paged.items) {
      const key = m.soldById ?? 'unknown';
      const existing = counts.get(key) ?? { count: 0, name: m.soldByName };
      counts.set(key, { count: existing.count + 1, name: existing.name });
    }

    const sorted = Array.from(counts.entries())
      .sort(([, a], [, b]) => b.count - a.count)
      .slice(0, limit);

    const leaderboard = sorted.map(([employeeId, { count }], index) => {
      const entry: Record<string, unknown> = {
        rank: index + 1,
        count,
      };
      if (shouldReveal) {
        // After 2026-07-04, reveal names
        entry.employeeId = employeeId;
      }
      // Never include 'employee' name field before reveal date
      return entry;
    });

    const warnings = [...paged.warnings];
    if (paged.truncated) {
      warnings.push(
        'ranking_unsafe: the page cap was hit before every YTD entrant was read, so counts are undercounts and the RANK ORDER may be wrong — do not announce a winner from this result',
      );
    }

    return {
      leaderboard,
      anonymized: !shouldReveal,
      revealDate: REVEAL_DATE.toISOString().slice(0, 10),
      contestStart: CONTEST_START,
      // The population the ranking was computed over — memberships read, not
      // the number of leaderboard rows returned.
      entrantCount: paged.items.length,
      pageCount: paged.pageCount,
      _composite: 'membership_jackpot_leaderboard',
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
