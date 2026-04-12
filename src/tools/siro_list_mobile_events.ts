// ============================================================
// siro_list_mobile_events — list Siro mobile events
// Cache TTL: 2 min (events are live-ish)
// ============================================================

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
  inputSchema: {
    type: 'object',
    properties: {
      pageSize: { type: 'number', description: 'Max events per page (default 50, max 100 per Siro docs)' },
      after: { type: 'string', description: 'ISO timestamp — return events after this time' },
      before: { type: 'string', description: 'ISO timestamp — return events before this time' },
      userId: { type: 'string', description: 'Filter to a specific Siro user' },
    },
    additionalProperties: false,
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
