// ============================================================
// siro_get_engagement — get linked recording/engagement data
// Cache TTL: 10 min
// ============================================================

import type { Env } from '../env';
import { siroFetch } from '../siro';
import { cacheGet } from '../cache';
import { McpError } from '../errors';
import type { ToolDef } from './index';

const NAMESPACE = 'siro:engagement';
const CACHE_TTL_SEC = 600;

interface Args {
  engagementId: string;
}

export const siro_get_engagement: ToolDef<Args> = {
  name: 'siro_get_engagement',
  description:
    'Get a Siro engagement (linked recording data — typically a single visit/interaction with a customer). Read-only. Cached 10 min.',
  inputSchema: {
    type: 'object',
    properties: {
      engagementId: { type: 'string', description: 'Siro engagement ID' },
    },
    required: ['engagementId'],
    additionalProperties: false,
  },
  async handler(env, args, { correlation }) {
    if (!args.engagementId) {
      throw new McpError('validation_error', 'engagementId is required', { correlation });
    }
    const path = `/v1/integrations/engagements/${encodeURIComponent(args.engagementId)}`;
    return cacheGet(env, NAMESPACE, args.engagementId, CACHE_TTL_SEC, () => siroFetch(env, path, correlation));
  },
};
