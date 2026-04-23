// ============================================================
// siro_list_mobile_events — list Siro mobile events
// Cache TTL: 2 min (events are live-ish)
// ============================================================

import { z } from 'zod';
import type { Env } from '../env';
import { siroFetch } from '../siro';
import { cacheGet } from '../cache';
import type { ToolDef } from './index';

const NAMESPACE = 'siro:mobile_events';
const CACHE_TTL_SEC = 120;

interface Args {
  pageSize?: number;
  after?: string; // ISO timestamp
  before?: string; // ISO timestamp
  userId?: string;
}

export const siro_list_mobile_events: ToolDef<Args> = {
  name: 'siro_list_mobile_events',
  description:
    'List Siro mobile events (recording/sync/activity events). Read-only. Cached 2 min. Siro is the in-person sales coaching recorder acquired by ServiceTitan.',
  zodSchema: {
    pageSize: z
      .number()
      .int()
      .positive()
      .max(100)
      .optional()
      .describe('Max events per page (default 50, max 100 per Siro docs)'),
    after: z.string().optional().describe('ISO timestamp — return events after this time'),
    before: z.string().optional().describe('ISO timestamp — return events before this time'),
    userId: z.string().optional().describe('Filter to a specific Siro user'),
  },
  async handler(env, args, { correlation }) {
    const pageSize = Math.min(args.pageSize ?? 50, 100);
    const qs = new URLSearchParams();
    qs.set('pageSize', String(pageSize));
    if (args.after) qs.set('after', args.after);
    if (args.before) qs.set('before', args.before);
    if (args.userId) qs.set('userId', args.userId);
    const path = `/v1/core/mobile-events?${qs.toString()}`;
    const cacheKey = qs.toString();
    return cacheGet(env, NAMESPACE, cacheKey, CACHE_TTL_SEC, () => siroFetch(env, path, correlation));
  },
};
