import { z } from 'zod';
import { readST } from '../../st';
import { defaultShaper } from '../../response-shape';
import type { ToolDef } from '../index';

interface Args { limit?: number }

// MANDATORY: anonymize employee names until 2026-07-04 per Jackpot Drive rules.
// After that date, actual names can be revealed.
const REVEAL_DATE = new Date('2026-07-04T00:00:00Z');

export const membership_jackpot_leaderboard: ToolDef<Args> = {
  name: 'membership_jackpot_leaderboard',
  description: 'L5 composite: membership sales leaderboard for the Jackpot Drive. Employee names anonymized until 2026-07-04 per Jackpot Drive rules — only rank and count are shown before that date. Source: live ST (memberships). Returns up to `limit` top performers, default 10, max 50.',
  zodSchema: {
    limit: z.number().int().positive().max(50).default(10).describe('Number of top performers to return (default: 10, max: 50)'),
  },
  stEndpoint: { method: 'GET', path: '/memberships/v2/tenant/{tid}/memberships', source: 'live' },
  async handler(env, args, { actor, correlation }) {
    const { limit = 10 } = args;
    const shouldReveal = new Date() >= REVEAL_DATE;

    const data = await readST<{ data?: any[] }>(
      env,
      { actor, correlation },
      `/memberships/v2/tenant/000000000/memberships`,
      { statuses: 'Active', createdOnOrAfter: '2026-01-01', pageSize: 200 },
    );
    const memberships = data.data ?? [];

    // Group by soldBy employee
    const counts = new Map<number | string, { count: number; name?: string }>();
    for (const m of memberships) {
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

    return {
      leaderboard,
      anonymized: !shouldReveal,
      revealDate: REVEAL_DATE.toISOString().slice(0, 10),
      _composite: 'membership_jackpot_leaderboard',
      _source: 'live',
    };
  },
  transformResult: defaultShaper,
};
