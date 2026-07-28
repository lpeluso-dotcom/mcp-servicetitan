// ============================================================
// list_jobs_today — ST simple-IDs batch cap.
//
// Step 2 batch-fetches the parent jobs via the ids-batch jobs call. That call
// is capped by ServiceTitan at 50 ids; asking for more returns HTTP 400:
//
//   {"status":400,"errors":{"Ids":["Simple IDs lookup should n…"]}}
//
// The tool already chunks and already short-circuits on an empty id set — the
// only defect was the chunk size (200). On a normal QSC day the appointment
// drain yields well over 50 distinct jobs, so the very first chunk blew the cap
// and the tool was dead for the no-argument call.
// ============================================================
import { describe, it, expect, vi } from 'vitest';
import { list_jobs_today } from '../jobs/list_jobs_today';

const CTX = { actor: 'vitest', correlation: 'test-corr' };

/** ST's documented cap for the simple-IDs lookup. */
const ST_SIMPLE_IDS_CAP = 50;

function makeDB() {
  const stmt = {
    bind: vi.fn().mockReturnThis(),
    run: vi.fn().mockResolvedValue({ success: true }),
    first: vi.fn().mockResolvedValue(null),
  };
  return { prepare: vi.fn().mockReturnValue(stmt) };
}

function makeEnv(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>): any {
  return {
    ST_PROXY: { fetch: vi.fn(fetchImpl) },
    MCP_SYNC_KEY: 'test-key',
    MCP_SERVICE_VERSION: '0.0.0-test',
    DB: makeDB(),
    PROXY_STATE: {},
    SIRO_API_TOKEN: '',
  };
}

/**
 * Pull the `ids` list out of a jobs-batch URL.
 *
 * The proxy URL is double-encoded — the real ST path+query rides in the
 * `endpoint` param, so the id commas arrive as %252C. Decode both layers.
 */
function idsFromUrl(url: string): string[] {
  const endpoint = new URL(url).searchParams.get('endpoint') ?? '';
  const qs = endpoint.split('?')[1] ?? '';
  const ids = new URLSearchParams(qs).get('ids') ?? '';
  return ids ? ids.split(',') : [];
}

describe('list_jobs_today ids-batch chunking', () => {
  it('never asks ST for more than 50 job ids in a single call', async () => {
    // 120 appointments -> 120 distinct parent jobs, i.e. more than one chunk.
    const appointments = Array.from({ length: 120 }, (_, i) => ({ id: 1000 + i, jobId: 100 + i }));

    const env = makeEnv(async (url: string) => {
      if (url.includes('appointments')) {
        return new Response(JSON.stringify({ data: appointments, hasMore: false }), { status: 200 });
      }
      if (url.includes('jobs')) {
        const ids = idsFromUrl(url);
        // Mirror ST's real behaviour: reject an over-cap simple-IDs lookup.
        if (ids.length > ST_SIMPLE_IDS_CAP) {
          return new Response(
            JSON.stringify({
              status: 400,
              title: 'One or more validation errors occurred.',
              errors: { Ids: ['Simple IDs lookup should not exceed 50 ids'] },
            }),
            { status: 400 },
          );
        }
        return new Response(
          JSON.stringify({ data: ids.map((id) => ({ id: Number(id), jobStatus: 'Scheduled' })), hasMore: false }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const result: any = await list_jobs_today.handler(env, {}, CTX);

    const jobsCalls = env.ST_PROXY.fetch.mock.calls
      .map((c: any[]) => String(c[0]))
      .filter((u: string) => u.includes('jobs') && !u.includes('appointments'));

    expect(jobsCalls.length).toBeGreaterThan(0);
    for (const url of jobsCalls) {
      const ids = idsFromUrl(url);
      expect(
        ids.length,
        `ids-batch call carried ${ids.length} ids, over ST's cap of ${ST_SIMPLE_IDS_CAP}`,
      ).toBeLessThanOrEqual(ST_SIMPLE_IDS_CAP);
    }

    // 120 ids at 50/chunk = 3 calls, and every job comes back.
    expect(jobsCalls.length).toBe(3);
    expect(result.jobs).toHaveLength(120);
  });

  it('still short-circuits without calling the jobs endpoint when no appointments exist', async () => {
    const env = makeEnv(async (url: string) => {
      if (url.includes('appointments')) {
        return new Response(JSON.stringify({ data: [], hasMore: false }), { status: 200 });
      }
      throw new Error(`jobs endpoint must not be called for an empty id set: ${url}`);
    });

    const result: any = await list_jobs_today.handler(env, {}, CTX);
    expect(result.jobs).toEqual([]);
    expect(env.ST_PROXY.fetch).toHaveBeenCalledTimes(1); // appointments only
  });
});
