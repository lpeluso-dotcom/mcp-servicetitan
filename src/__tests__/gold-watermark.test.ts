// ============================================================
// gold-watermark.test.ts — the `_gold_as_of` disclosure.
//
// WHY THIS EXISTS: a QSC analytical answer went to the owner's inbox with a
// wrong headline because the age of the gold data was invisible at write-up
// time. All nine Supabase-backed tools published no data-age signal at all —
// a grep for `as_of|measured_at|synced_at|updated_at` across them returned
// zero hits. A stale-gold answer that looks fresh is worse than no answer.
//
// THE TRAP THESE TESTS EXIST TO PIN: `trade_coverage.ts:158` writes
// `measured_at: new Date().toISOString()`. That is when WE MEASURED, and it
// is always "now" — copying it as a data-age watermark would make every
// answer look seconds old regardless of how frozen the warehouse was. The
// watermark must come from the BUILD, and the build's own stamp lives in
// `vec.refresh_state` (qsc-hopper `scripts/build-gold.ts` writes
// `gold_build_complete_at` only after a zero-failure build; qsc-vector's
// `src/gold-freshness.ts` already reads it for exactly this reason).
// ============================================================
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  GOLD_STALE_THRESHOLD_HOURS,
  WATERMARK_TTL_SEC,
  buildGoldStamp,
  goldAsOf,
  type WatermarkPart,
} from '../gold-watermark';

const NOW = Date.parse('2026-08-24T12:00:00.000Z');
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

function part(over: Partial<WatermarkPart> = {}): WatermarkPart {
  return { source: 'gold', label: 'vec.refresh_state[gold_build_complete_at]', builtAt: hoursAgo(3), failed: false, ...over };
}

/** D1 stub that always misses, so the probe runs for real. */
function missingCacheDb() {
  return { prepare: () => ({ bind: () => ({ first: async () => null, run: async () => ({}) }) }) };
}

/** D1 stub with a real in-memory table, so cacheGet actually caches. */
function realCacheDb() {
  const store = new Map<string, { value: string; expires_at: number }>();
  return {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        first: async () => (sql.includes('SELECT') ? store.get(`${args[0]}|${args[1]}`) ?? null : null),
        run: async () => {
          if (sql.includes('INSERT')) {
            store.set(`${args[0]}|${args[1]}`, { value: args[2] as string, expires_at: args[3] as number });
          }
          return {};
        },
      }),
    }),
  };
}

function env(db: unknown = missingCacheDb()) {
  return { SUPABASE_URL: 'https://p.supabase.co', SUPABASE_PB_KEY: 'k', DB: db } as any;
}

/**
 * Routes the live probe shapes:
 *   vec.refresh_state       -> [{key, value, updated_at}]
 *   <table>?select=synced_at -> [{synced_at}]
 */
function stubProbe(opts: {
  goldBuiltAt?: string | null;
  vecRefreshedAt?: string | null;
  pricebookSyncedAt?: string | null;
  templatesSyncedAt?: string | null;
  fail?: boolean;
}) {
  const f = vi.fn(async (url: string) => {
    if (opts.fail) return new Response('boom', { status: 400 });
    if (url.includes('refresh_state')) {
      const rows: Array<Record<string, unknown>> = [];
      if (opts.goldBuiltAt) {
        rows.push({ key: 'gold_build_complete_at', value: opts.goldBuiltAt, updated_at: opts.goldBuiltAt });
      }
      if (opts.vecRefreshedAt) {
        rows.push({ key: 'taylor_jobs_synced_at', value: '2026-08-24 05:00:00', updated_at: opts.vecRefreshedAt });
      }
      return new Response(JSON.stringify(rows), { status: 200 });
    }
    if (url.includes('pb_estimate_templates')) {
      return new Response(JSON.stringify(opts.templatesSyncedAt ? [{ synced_at: opts.templatesSyncedAt }] : []), { status: 200 });
    }
    if (url.includes('pricebook_items')) {
      return new Response(JSON.stringify(opts.pricebookSyncedAt ? [{ synced_at: opts.pricebookSyncedAt }] : []), { status: 200 });
    }
    return new Response('[]', { status: 200 });
  });
  vi.stubGlobal('fetch', f as any);
  return f;
}

afterEach(() => vi.unstubAllGlobals());

// ── The pure verdict ────────────────────────────────────────
describe('buildGoldStamp — the verdict, given a build timestamp', () => {
  it('reports the BUILD time, not the call time', () => {
    const builtAt = hoursAgo(3);
    const s = buildGoldStamp([part({ builtAt })], NOW);
    expect(s._gold_as_of).toBe(builtAt);
    // The whole defect in one assertion: a watermark equal to "now" is the bug.
    expect(s._gold_as_of).not.toBe(new Date(NOW).toISOString());
    expect(s._gold_age_hours).toBe(3);
  });

  it('a build inside the threshold is fresh, with no warning', () => {
    const s = buildGoldStamp([part({ builtAt: hoursAgo(4) })], NOW);
    expect(s._gold_freshness).toBe('fresh');
    expect(s._gold_warning).toBeUndefined();
  });

  it('a build past the threshold is STALE — the watermark PROVES it, unlike synced_at', () => {
    const s = buildGoldStamp([part({ builtAt: hoursAgo(GOLD_STALE_THRESHOLD_HOURS + 1) })], NOW);
    expect(s._gold_freshness).toBe('stale');
    expect(s._gold_warning).toMatch(/stale/i);
    // The age has to be IN the warning: "stale" without a number is unactionable.
    expect(s._gold_warning).toMatch(/27/);
  });

  it('threshold clears a healthy nightly build at its oldest legitimate point', () => {
    // gold builds 09:00 UTC; a call at 08:59 the next day sees a ~24h-old build
    // that is perfectly healthy. A 20h threshold (qsc-vector's, correct for a
    // job that runs 30min after the build) would cry wolf every single morning.
    expect(GOLD_STALE_THRESHOLD_HOURS).toBeGreaterThan(24);
    expect(buildGoldStamp([part({ builtAt: hoursAgo(23.9) })], NOW)._gold_freshness).toBe('fresh');
  });

  it('a MISSING watermark is unknown — never silently fresh, never call time', () => {
    const s = buildGoldStamp([part({ builtAt: null })], NOW);
    expect(s._gold_as_of).toBeNull();
    expect(s._gold_age_hours).toBeNull();
    expect(s._gold_freshness).toBe('unknown');
    expect(s._gold_warning).toBeTruthy();
  });

  it('a FAILED probe is unknown and says the probe failed, not that data is fresh', () => {
    const s = buildGoldStamp([part({ builtAt: null, failed: true })], NOW);
    expect(s._gold_freshness).toBe('unknown');
    expect(s._gold_warning).toMatch(/could not be read|probe/i);
  });

  it('an unparseable watermark is unknown, not NaN hours', () => {
    const s = buildGoldStamp([part({ builtAt: 'not-a-timestamp' })], NOW);
    expect(s._gold_freshness).toBe('unknown');
    expect(s._gold_age_hours).toBeNull();
  });

  it('a FUTURE watermark is rejected — one bad write must not read as maximally fresh', () => {
    const s = buildGoldStamp([part({ builtAt: new Date(NOW + 5 * 3_600_000).toISOString() })], NOW);
    expect(s._gold_freshness).toBe('unknown');
    expect(s._gold_warning).toMatch(/future/i);
  });

  it('with several upstreams the OLDEST wins — data is no fresher than its stalest input', () => {
    const older = hoursAgo(30);
    const s = buildGoldStamp(
      [part({ source: 'gold', builtAt: hoursAgo(2) }),
       part({ source: 'vec', label: 'vec index re-embed', builtAt: older })],
      NOW,
    );
    expect(s._gold_as_of).toBe(older);
    expect(s._gold_freshness).toBe('stale');
    // The binding constraint must be named, or nobody knows what to go fix.
    expect(s._gold_watermark_source).toContain('vec index re-embed');
  });

  it('one unprovable upstream makes the whole answer unknown, even beside a fresh one', () => {
    const s = buildGoldStamp(
      [part({ source: 'gold', builtAt: hoursAgo(1) }),
       part({ source: 'pricebook', label: 'max(pricebook_items.synced_at)', builtAt: null })],
      NOW,
    );
    expect(s._gold_freshness).toBe('unknown');
    expect(s._gold_warning).toContain('pricebook_items');
  });
});

// ── The probe ───────────────────────────────────────────────
describe('goldAsOf — probing Supabase for the build watermark', () => {
  it('reads gold build time from vec.refresh_state[gold_build_complete_at]', async () => {
    const builtAt = hoursAgo(3);
    const f = stubProbe({ goldBuiltAt: builtAt });
    const s = await goldAsOf(env(), 'gold', NOW);
    expect(s._gold_as_of).toBe(builtAt);
    expect(s._gold_freshness).toBe('fresh');
    const url = String((f.mock.calls as any[])[0][0]);
    expect(url).toContain('refresh_state');
    expect(url).toContain('gold_build_complete_at');
    // vec is a non-public exposed schema — without the profile header PostgREST
    // resolves against `public` and 404s.
    expect(((f.mock.calls as any[])[0][1].headers as Record<string, string>)['Accept-Profile']).toBe('vec');
  });

  it('the vec index watermark is bounded by BOTH the re-embed and the gold build it embedded', async () => {
    // The 2026-07-21 incident: gold froze while the vector refresh kept running
    // nightly and reporting success. Either link going stale must show.
    const s = await (stubProbe({ goldBuiltAt: hoursAgo(40), vecRefreshedAt: hoursAgo(2) }),
      goldAsOf(env(), 'vec', NOW));
    expect(s._gold_as_of).toBe(hoursAgo(40));
    expect(s._gold_freshness).toBe('stale');
  });

  it('reads pricebook freshness from max(pricebook_items.synced_at)', async () => {
    const syncedAt = hoursAgo(5);
    const f = stubProbe({ pricebookSyncedAt: syncedAt });
    const s = await goldAsOf(env(), 'pricebook', NOW);
    expect(s._gold_as_of).toBe(syncedAt);
    const url = String((f.mock.calls as any[])[0][0]);
    expect(url).toContain('pricebook_items');
    expect(url).toContain('order=synced_at.desc');
    expect(url).toContain('limit=1');
  });

  it('reads template freshness from its OWN table, not from pricebook_items', async () => {
    // Two separate nightly crons (09:30 templates, 09:45 items). One standing in
    // for the other is exactly the "fresh sibling hides a frozen table" failure.
    const f = stubProbe({ pricebookSyncedAt: hoursAgo(1), templatesSyncedAt: hoursAgo(50) });
    const s = await goldAsOf(env(), 'pricebook_templates', NOW);
    expect(s._gold_as_of).toBe(hoursAgo(50));
    expect(s._gold_freshness).toBe('stale');
    expect(String((f.mock.calls as any[])[0][0])).toContain('pb_estimate_templates');
  });

  it('takes the oldest across several sources', async () => {
    stubProbe({ pricebookSyncedAt: hoursAgo(2), templatesSyncedAt: hoursAgo(9) });
    const s = await goldAsOf(env(), ['pricebook', 'pricebook_templates'], NOW);
    expect(s._gold_as_of).toBe(hoursAgo(9));
  });

  it('an absent refresh_state row reads unknown, not fresh', async () => {
    stubProbe({ goldBuiltAt: null });
    const s = await goldAsOf(env(), 'gold', NOW);
    expect(s._gold_as_of).toBeNull();
    expect(s._gold_freshness).toBe('unknown');
  });

  it('FAILS SOFT — a broken probe never throws out of the tool that carries it', async () => {
    stubProbe({ fail: true });
    const s = await goldAsOf(env(), 'gold', NOW);
    expect(s._gold_freshness).toBe('unknown');
    expect(s._gold_warning).toBeTruthy();
  });

  it('fails soft when there is no Supabase config at all', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('no fetch'); }) as any);
    await expect(goldAsOf({} as any, 'gold', NOW)).resolves.toMatchObject({ _gold_freshness: 'unknown' });
  });
});

// ── The cache ───────────────────────────────────────────────
describe('the probe is cached, not re-fetched per tool call', () => {
  it('a second call inside the TTL issues no new request', async () => {
    const f = stubProbe({ goldBuiltAt: hoursAgo(3) });
    const e = env(realCacheDb());
    const a = await goldAsOf(e, 'gold', NOW);
    const b = await goldAsOf(e, 'gold', NOW);
    expect(a._gold_as_of).toBe(b._gold_as_of);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('caching the TIMESTAMP (not the age) means a warm cache can only look OLDER, never fresher', async () => {
    // The safety property that lets the TTL be generous: age is recomputed from
    // the cached build time on every call, so a stale cache delays noticing a
    // NEW build — it can never hide an old one.
    const f = stubProbe({ goldBuiltAt: hoursAgo(GOLD_STALE_THRESHOLD_HOURS - 1) });
    const e = env(realCacheDb());
    const warm = await goldAsOf(e, 'gold', NOW);
    expect(warm._gold_freshness).toBe('fresh');
    // Same cached entry, read two hours later: now correctly stale.
    const later = await goldAsOf(e, 'gold', NOW + 2 * 3_600_000);
    expect(later._gold_freshness).toBe('stale');
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('the TTL is short enough to notice a nightly build the same day', () => {
    expect(WATERMARK_TTL_SEC).toBeGreaterThan(0);
    expect(WATERMARK_TTL_SEC).toBeLessThanOrEqual(3600);
  });

  it('different sources do not share a cache key', async () => {
    const f = stubProbe({ goldBuiltAt: hoursAgo(3), pricebookSyncedAt: hoursAgo(8) });
    const e = env(realCacheDb());
    expect((await goldAsOf(e, 'gold', NOW))._gold_as_of).toBe(hoursAgo(3));
    expect((await goldAsOf(e, 'pricebook', NOW))._gold_as_of).toBe(hoursAgo(8));
    expect(f).toHaveBeenCalledTimes(2);
  });
});
