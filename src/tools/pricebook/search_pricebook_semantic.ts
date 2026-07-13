// ============================================================
// search_pricebook_semantic — Vectorize semantic search over pricebook
//
// Proxies to taylor-ai /api/pricebook/semantic-search via the ST_PROXY
// service binding. Returns top-K pricebook items ranked by embedding
// similarity. Use when a keyword search returns no useful results or
// when the caller has a natural-language description rather than a code.
// ============================================================

import { z } from 'zod';
import type { Env } from '../../env';
import type { ToolDef } from '../index';
import { defaultShaper } from '../../response-shape';

interface Args {
  query: string;
  topK?: number;
}

interface SemanticMatch {
  id: string;
  score: number;
  metadata: {
    id?: string;
    name?: string;
    type?: string;
    category?: string;
    price?: number;
    code?: string;
  };
}

export const search_pricebook_semantic: ToolDef<Args> = {
  name: 'search_pricebook_semantic',
  description:
    'Semantic (vector) search over the QSC pricebook — services, materials, and equipment. ' +
    'Use when keyword search yields no results or the caller describes a task in natural language ' +
    '(e.g. "replace capacitor on heat pump", "flush tankless water heater"). ' +
    'Returns up to topK matches ranked by embedding similarity with metadata (name, type, code, price). ' +
    'Note: price may be 0 or absent — QSC uses dynamic pricing computed at invoice time.',
  zodSchema: {
    query: z.string().min(1).max(500).describe('Natural-language description of the service or part needed'),
    topK: z.number().int().min(1).max(20).default(10).optional().describe('Number of results to return (default 10, max 20)'),
  },
  async handler(env: Env, args: Args, { correlation }) {
    const params = new URLSearchParams({ q: args.query, topK: String(args.topK ?? 10) });
    const resp = await (env as any).ST_PROXY.fetch(
      `https://servicetitan-proxy/api/pricebook/semantic-search?${params}`,
      {
        headers: {
          'X-Sync-Key': env.MCP_SYNC_KEY,
          'X-Correlation-Id': correlation ?? '',
        },
      }
    );

    if (!resp.ok) {
      const text = await resp.text().catch(() => String(resp.status));
      throw new Error(`pricebook semantic search failed: ${text}`);
    }

    const data = await resp.json() as { matches?: SemanticMatch[]; query?: string };
    return {
      matches: (data.matches ?? []).map((m) => ({
        score: m.score,
        id: m.metadata?.id ?? m.id,
        name: m.metadata?.name ?? '',
        type: m.metadata?.type ?? '',
        code: m.metadata?.code ?? '',
        category: m.metadata?.category ?? '',
        price: m.metadata?.price ?? null,
      })),
      query: data.query ?? args.query,
      _source: 'vectorize',
    };
  },
  transformResult: defaultShaper,
};
