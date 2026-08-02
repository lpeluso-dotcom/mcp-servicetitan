// ============================================================
// siro_get_engagement — get linked recording/engagement data
// Cache TTL: 10 min
// ============================================================

import { z } from 'zod';
import type { Env } from '../env';
import { siroFetch } from '../siro';
import { cacheGet } from '../cache';
import { McpError } from '../errors';
import type { ToolDef } from './index';
import { defaultShaper } from '../response-shape';

const NAMESPACE = 'siro:engagement';
const CACHE_TTL_SEC = 600;

interface Args {
  engagementId: string;
}

export const siro_get_engagement: ToolDef<Args> = {
  name: 'siro_get_engagement',
  description:
    'Get a Siro engagement (linked recording data — typically a single visit/interaction with a customer). Read-only. Cached 10 min. Source: live Siro API — not the ServiceTitan API; no D1 mirror.',
  zodSchema: {
    engagementId: z.string().min(1).describe('Siro engagement ID'),
  },
  async handler(env, args, { correlation }) {
    if (!args.engagementId) {
      throw new McpError('validation_error', 'engagementId is required', { correlation });
    }
    const path = `/v1/integrations/engagements/${encodeURIComponent(args.engagementId)}`;
    return cacheGet(env, NAMESPACE, args.engagementId, CACHE_TTL_SEC, () => siroFetch(env, path, correlation));
  },
  transformResult: defaultShaper,
};
