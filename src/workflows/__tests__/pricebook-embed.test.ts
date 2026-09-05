// ============================================================
// PricebookEmbedWorkflow — drain tests driven through a fake PostgREST.
//
// The fake models the two read sources the workflow can drain from:
//   * the change-detection VIEW `pricebook_items_needing_embedding`
//     (active AND (embedding IS NULL OR hash drifted OR model drifted)), and
//   * the legacy `pricebook_items?embedding=is.null` predicate the workflow
//     falls back to when the view does not exist yet (migration not applied).
// It also records every PATCH so the write shape can be asserted per path.
// ============================================================
import { describe, it, expect, vi, afterEach } from 'vitest';
import wranglerToml from '../../../wrangler.toml?raw';
import {
  drainOnce, EMBED_BATCH, RUN_CEILING, NEEDING_VIEW, type StepLike,
} from '../pricebook-embed';
import { EMBED_MODEL_ID } from '../../supabase';

// Vite injects `import.meta.glob` at transform time; `vite/client` types are
// not in this repo's `types` list, so declare just the one member (same as
// src/__tests__/read-router-removed.test.ts).
declare global {
  interface ImportMeta {
    glob(
      pattern: string,
      opts: { query: string; import: string; eager: true },
    ): Record<string, string>;
  }
}

/** Postgres migrations authored in this repo (applied by Luke, never by code). */
const PG_MIGRATIONS: Record<string, string> = import.meta.glob('../../../supabase/migrations/*.sql', {
  query: '?raw',
  import: 'default',
  eager: true,
});

afterEach(() => vi.unstubAllGlobals());

function env(aiRun: any) {
  return { SUPABASE_URL: 'https://p.supabase.co', SUPABASE_PB_KEY: 'k', AI: { run: aiRun } } as any;
}

/** AI stub: one vector per input, always well-formed. */
const okAi = () => vi.fn(async (_m: string, { text }: { text: string[] }) => ({ data: text.map((_, i) => [i + 0.5]) }));

interface FakeRow {
  code: string; item_type: string; name: string; description?: string | null; category_name?: string | null;
  is_active?: number;
  content_hash: string;
  embedding?: string | null;
  embedding_content_hash?: string | null;
  embedding_model?: string | null;
}

interface FakeOpts {
  rows: FakeRow[];
  viewExists: boolean;
  /** When false, PostgREST answers without a usable content-range total. */
  countHeader?: boolean;
  /** Pre-migration the hash/model columns do not exist — a PATCH naming them is a 400. */
  hashColumnsExist?: boolean;
  /** Force every PATCH to fail with this status (write-failure accounting). */
  patchStatus?: number;
}

function fakePostgrest(o: FakeOpts) {
  const rows = o.rows.map((r) => ({ is_active: 1, embedding: null, embedding_content_hash: null, embedding_model: null, ...r }));
  const viewSelects: string[] = [];
  const legacySelects: string[] = [];
  const patches: { url: string; body: any }[] = [];
  const hashColumnsExist = o.hashColumnsExist ?? o.viewExists;

  const needsEmbedding = (r: typeof rows[number]) =>
    r.is_active === 1 && (r.embedding == null || r.embedding_content_hash !== r.content_hash || r.embedding_model !== EMBED_MODEL_ID);

  const page = (matched: typeof rows, url: URL, init: any) => {
    const limit = Number(url.searchParams.get('limit') ?? matched.length);
    const body = matched.slice(0, limit).map(({ code, item_type, name, description, category_name, content_hash }) =>
      ({ code, item_type, name, description, category_name, content_hash }));
    const headers: Record<string, string> = {};
    const prefer = init?.headers?.['Prefer'] ?? init?.headers?.['prefer'] ?? '';
    if (/count=exact/.test(prefer)) {
      headers['content-range'] = (o.countHeader ?? true)
        ? (matched.length === 0 ? `*/${0}` : `0-${Math.min(limit, matched.length) - 1}/${matched.length}`)
        : '0-0/*';
    }
    return new Response(JSON.stringify(body), { status: 200, headers });
  };

  const fetchMock = vi.fn(async (u: string, init: any) => {
    const url = new URL(String(u));
    const path = url.pathname.replace('/rest/v1/', '');
    if (path === NEEDING_VIEW && (!init?.method || init.method === 'GET')) {
      viewSelects.push(url.search);
      if (!o.viewExists) {
        return new Response(JSON.stringify({
          code: 'PGRST205', details: null, hint: null,
          message: `Could not find the table 'public.${NEEDING_VIEW}' in the schema cache`,
        }), { status: 404 });
      }
      return page(rows.filter(needsEmbedding), url, init);
    }
    if (path === 'pricebook_items' && (!init?.method || init.method === 'GET')) {
      legacySelects.push(url.search);
      expect(url.searchParams.get('embedding')).toBe('is.null');
      return page(rows.filter((r) => r.is_active === 1 && r.embedding == null), url, init);
    }
    if (path === 'pricebook_items' && init?.method === 'PATCH') {
      const body = JSON.parse(init.body);
      patches.push({ url: String(u), body });
      if (o.patchStatus) return new Response('boom', { status: o.patchStatus });
      if (!hashColumnsExist && ('embedding_content_hash' in body || 'embedding_model' in body)) {
        return new Response(JSON.stringify({ code: 'PGRST204', message: "Could not find the 'embedding_content_hash' column" }), { status: 400 });
      }
      const code = url.searchParams.get('code')!.replace('eq.', '');
      const itemType = url.searchParams.get('item_type')!.replace('eq.', '');
      for (const r of rows) if (r.code === code && r.item_type === itemType) Object.assign(r, body);
      return new Response(null, { status: 204 });
    }
    throw new Error(`fake PostgREST: unexpected ${init?.method ?? 'GET'} ${url.pathname}${url.search}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { rows, viewSelects, legacySelects, patches, fetchMock };
}

/** Records step names and the value each step returned; executes callbacks inline. */
function recordingStep() {
  const names: string[] = [];
  const results: Record<string, unknown> = {};
  const step: StepLike = {
    async do<T>(name: string, _config: unknown, fn: () => Promise<T>): Promise<T> {
      names.push(name);
      const v = await fn();
      results[name] = v;
      return v;
    },
  };
  return { step, names, results };
}

const nullRow = (i: number): FakeRow => ({ code: `C${i}`, item_type: 'material', name: `n${i}`, content_hash: `h${i}`, embedding: null });

describe('wrangler.toml cron schedule', () => {
  const section = (header: string) => {
    const m = wranglerToml.match(new RegExp(`\\n\\[${header.replace(/\./g, '\\.')}\\]\\n([\\s\\S]*?)(?=\\n\\[|$)`));
    return m ? m[1] : null;
  };

  it('(a) dev has NO unattended cron — manual trigger only', () => {
    const dev = section('env.dev.triggers');
    expect(dev).not.toBeNull();
    expect(dev).toMatch(/^crons\s*=\s*\[\s*\]/m);
    expect(dev).not.toContain('0 10 * * *');
  });

  it('(a) prod keeps the daily 10:00 UTC cron', () => {
    const prod = section('triggers');
    expect(prod).not.toBeNull();
    expect(prod).toMatch(/crons\s*=\s*\["0 10 \* \* \*"\]/);
  });
});

describe('PricebookEmbedWorkflow drainOnce', () => {
  it('(b) drains from the change-detection view when it exists and writes embedding + hash + model together', async () => {
    const aiRun = okAi();
    const pg = fakePostgrest({
      viewExists: true,
      rows: [{ code: 'CAP-240', item_type: 'material', name: 'Capacitor', description: 'Dual run', category_name: 'HVAC', content_hash: 'abc', embedding: null }],
    });

    const out = await drainOnce(env(aiRun), { batch: 100, ceiling: 5000 });

    expect(aiRun).toHaveBeenCalledWith('@cf/baai/bge-base-en-v1.5', { text: ['Capacitor — Dual run — HVAC'] });
    expect(out.change_detection).toBe('view');
    expect(out.model).toBe(EMBED_MODEL_ID);
    expect(out.embedded).toBe(1);
    expect(pg.legacySelects).toEqual([]);
    expect(pg.viewSelects.some((q) => q.includes('select=code,item_type,name,description,category_name,content_hash'))).toBe(true);
    expect(pg.patches).toHaveLength(1);
    expect(pg.patches[0].url).toContain('pricebook_items?code=eq.CAP-240&item_type=eq.material');
    expect(pg.patches[0].body).toEqual({ embedding: '[0.5]', embedding_content_hash: 'abc', embedding_model: EMBED_MODEL_ID });
  });

  it('(c) falls back to embedding=is.null when the view 404s, writes ONLY the embedding column, and reports change_detection unavailable', async () => {
    const aiRun = okAi();
    const pg = fakePostgrest({
      viewExists: false,
      rows: [{ code: 'CAP-240', item_type: 'material', name: 'Capacitor', description: 'Dual run', category_name: 'HVAC', content_hash: 'abc', embedding: null }],
    });

    const out = await drainOnce(env(aiRun), { batch: 100, ceiling: 5000 });

    expect(out.change_detection).toBe('unavailable');
    expect(out.embedded).toBe(1);
    expect(pg.viewSelects.length).toBeGreaterThanOrEqual(1); // probed once, then abandoned
    expect(pg.legacySelects.length).toBeGreaterThanOrEqual(1);
    expect(pg.legacySelects.every((q) => q.includes('is_active=eq.1') && q.includes('embedding=is.null'))).toBe(true);
    expect(pg.patches[0].body).toEqual({ embedding: '[0.5]' }); // pre-migration columns must not be named
  });

  it('(d) runs one durable step per batch with the batch counts, plus detect/count steps', async () => {
    const aiRun = okAi();
    fakePostgrest({ viewExists: true, rows: [0, 1, 2, 3, 4].map(nullRow) });
    const rec = recordingStep();

    const out = await drainOnce(env(aiRun), { batch: 2, ceiling: 5000 }, rec.step);

    expect(rec.names).toEqual(['detect-source', 'embed-batch-1', 'embed-batch-2', 'embed-batch-3', 'count-remaining']);
    expect(rec.results['embed-batch-1']).toEqual({ fetched: 2, embedded: 2, failed: 0, skipped: 0 });
    expect(rec.results['embed-batch-3']).toEqual({ fetched: 1, embedded: 1, failed: 0, skipped: 0 });
    expect(out).toMatchObject({
      embedded: 5, batches: 3, fetched: 5, failed: 0, skipped: 0,
      bounded_stop: false, stalled: false, remaining_estimate: 0, change_detection: 'view', model: EMBED_MODEL_ID,
    });
  });

  it('(e) reports bounded_stop:true when the ceiling is hit on a full page, with a remaining count', async () => {
    const aiRun = okAi();
    fakePostgrest({ viewExists: true, rows: [0, 1, 2, 3, 4, 5].map(nullRow) });
    const rec = recordingStep();

    const out = await drainOnce(env(aiRun), { batch: 2, ceiling: 4 }, rec.step);

    expect(out.embedded).toBe(4);
    expect(out.batches).toBe(2);
    expect(out.bounded_stop).toBe(true);
    expect(out.stalled).toBe(false);
    expect(out.remaining_estimate).toBe(2);
    expect(rec.names.filter((n) => n.startsWith('embed-batch-'))).toEqual(['embed-batch-1', 'embed-batch-2']);
    expect(EMBED_BATCH).toBe(100);
    expect(RUN_CEILING).toBe(5000);
  });

  it('(f) a row whose text changed (content_hash drifted) is re-embedded even though its embedding is non-null; an up-to-date row is left alone', async () => {
    const aiRun = okAi();
    const pg = fakePostgrest({
      viewExists: true,
      rows: [
        { code: 'CHANGED', item_type: 'service', name: 'Tune-up', description: 'now 21 points', content_hash: 'new',
          embedding: '[9]', embedding_content_hash: 'old', embedding_model: EMBED_MODEL_ID },
        { code: 'FRESH', item_type: 'service', name: 'Fresh', content_hash: 'same',
          embedding: '[9]', embedding_content_hash: 'same', embedding_model: EMBED_MODEL_ID },
      ],
    });

    const out = await drainOnce(env(aiRun), { batch: 100, ceiling: 5000 });

    expect(out.embedded).toBe(1);
    expect(aiRun).toHaveBeenCalledWith(EMBED_MODEL_ID, { text: ['Tune-up — now 21 points'] });
    expect(pg.patches).toHaveLength(1);
    expect(pg.patches[0].url).toContain('code=eq.CHANGED');
    expect(pg.patches[0].body).toMatchObject({ embedding_content_hash: 'new', embedding_model: EMBED_MODEL_ID });
    expect(pg.rows.find((r) => r.code === 'CHANGED')!.embedding_content_hash).toBe('new');
  });

  it('(f) a row embedded under a previous model is re-embedded', async () => {
    const aiRun = okAi();
    const pg = fakePostgrest({
      viewExists: true,
      rows: [{ code: 'OLDMODEL', item_type: 'service', name: 'X', content_hash: 'h',
        embedding: '[9]', embedding_content_hash: 'h', embedding_model: '@cf/baai/bge-small-en-v1.5' }],
    });
    const out = await drainOnce(env(aiRun), { batch: 100, ceiling: 5000 });
    expect(out.embedded).toBe(1);
    expect(pg.patches[0].body.embedding_model).toBe(EMBED_MODEL_ID);
  });

  it('(f) the authored (unapplied) migration encodes the same predicate the fake models', () => {
    const files = Object.keys(PG_MIGRATIONS);
    expect(files.length).toBeGreaterThan(0);
    const sql = Object.values(PG_MIGRATIONS).join('\n').toLowerCase();
    expect(sql).toMatch(/alter table public\.pricebook_items[\s\S]*add column if not exists content_hash text generated always as \(md5\(/);
    expect(sql).toContain("coalesce(name,'')||'|'||coalesce(description,'')||'|'||coalesce(category_name,'')");
    expect(sql).toContain('embedding_content_hash text');
    expect(sql).toContain('embedding_model text');
    expect(sql).toContain(`view public.${NEEDING_VIEW}`);
    expect(sql).toContain('embedding is null');
    expect(sql).toContain('embedding_content_hash is distinct from content_hash');
    expect(sql).toContain(`embedding_model is distinct from '${EMBED_MODEL_ID}'`);
    expect(sql).toMatch(/is_active\s*=\s*1/);
    // Never committed to the D1 scan path: wrangler applies migrations/*.sql to SQLite.
    expect(files.every((f) => f.includes('/supabase/migrations/'))).toBe(true);
  });

  it('is a no-op when the backlog is empty', async () => {
    const aiRun = vi.fn();
    fakePostgrest({ viewExists: true, rows: [] });
    const out = await drainOnce(env(aiRun), { batch: 100, ceiling: 5000 });
    expect(out.embedded).toBe(0);
    expect(out.batches).toBe(0);
    expect(out.bounded_stop).toBe(false);
    expect(aiRun).not.toHaveBeenCalled();
  });

  it('remaining_estimate is null when PostgREST gives no exact count', async () => {
    const aiRun = okAi();
    fakePostgrest({ viewExists: true, countHeader: false, rows: [nullRow(0)] });
    const out = await drainOnce(env(aiRun), { batch: 100, ceiling: 5000 });
    expect(out.embedded).toBe(1);
    expect(out.remaining_estimate).toBeNull();
  });

  it('stops on a stuck full page with zero forward progress (no-progress guard) and flags stalled', async () => {
    const aiRun = vi.fn(async () => ({ data: [] })); // malformed/empty response — no row gets a vector
    const pg = fakePostgrest({ viewExists: true, rows: [0, 1, 2, 3].map(nullRow) });
    const rec = recordingStep();

    const out = await drainOnce(env(aiRun), { batch: 2, ceiling: 4 }, rec.step);

    expect(out.embedded).toBe(0);
    expect(out.skipped).toBe(2);
    expect(out.stalled).toBe(true);
    expect(out.bounded_stop).toBe(false);
    expect(rec.names.filter((n) => n.startsWith('embed-batch-'))).toEqual(['embed-batch-1']);
    expect(pg.patches).toHaveLength(0);
  });

  it('counts a failed per-row write as failed and keeps going', async () => {
    const aiRun = okAi();
    fakePostgrest({ viewExists: true, rows: [nullRow(0)], patchStatus: 500 });
    const out = await drainOnce(env(aiRun), { batch: 100, ceiling: 5000 });
    expect(out).toMatchObject({ embedded: 0, failed: 1, fetched: 1, batches: 1, stalled: false });
  });
});
