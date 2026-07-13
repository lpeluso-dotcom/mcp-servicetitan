// ============================================================
// siro_get_recording_summary — get AI-generated summary for a recording
// Cache TTL: 1 hour (summaries are stable once generated)
// ============================================================

import { z } from 'zod';
import type { Env } from '../env';
import { siroFetch } from '../siro';
import { cacheGet } from '../cache';
import { McpError } from '../errors';
import type { ToolDef } from './index';
import { defaultShaper } from '../response-shape';

const NAMESPACE = 'siro:recording_summary';
const CACHE_TTL_SEC = 3600;

interface Args {
  recordingId: string;
}

export const siro_get_recording_summary: ToolDef<Args> = {
  name: 'siro_get_recording_summary',
  description:
    'Get the AI-generated summary for a Siro recording (sales conversation analysis, key moments, coaching points). Read-only. Cached 1 hour.',
  zodSchema: {
    recordingId: z.string().min(1).describe('Siro recording ID'),
  },
  async handler(env, args, { correlation }) {
    if (!args.recordingId) {
      throw new McpError('validation_error', 'recordingId is required', { correlation });
    }
    const path = `/v1/core/recordings/${encodeURIComponent(args.recordingId)}/summaries`;
    return cacheGet(env, NAMESPACE, args.recordingId, CACHE_TTL_SEC, () => siroFetch(env, path, correlation));
  },
  transformResult: defaultShaper,
};
