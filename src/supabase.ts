// ============================================================
// supabase.ts — shared helpers for the Supabase-backed pricebook tools
// and the embedding-refresh Workflow. Read tools read; only the Workflow
// writes, and only pricebook_items.embedding.
// ============================================================
import type { Env } from './env';

export const EMBED_MODEL_ID = '@cf/baai/bge-base-en-v1.5';

// Per-fetch abort budget for Supabase calls. 25s, not 10s: diagnosed
// 2026-07-18 that the `authenticator` Postgres role (the login role
// PostgREST always uses, regardless of the caller's effective RLS role)
// carries its own `statement_timeout` in pg_roles.rolconfig, separate from
// the database-level default -- a role-level override is NOT reset by a
// mid-session `SET ROLE`. That role's timeout was raised 8s -> 30s to give
// pgvector queries room on cold cache pages; this client-side budget stays
// a few seconds under it so a genuine DB-side hang still surfaces as a
// clear Postgres error instead of a generic client abort.
const SUPABASE_FETCH_TIMEOUT_MS = 25_000;

// ── Transient-failure retry ─────────────────────────────────────────────
// Shape deliberately copied from `src/d1-proxy.ts` (MAX_RETRIES = 2, backoff
// [50, 200]) rather than invented fresh: this repo already has ONE retry
// idiom, and a second one with different attempt counts and different
// transient-status rules is a maintenance trap, not a feature. Same numbers,
// same classification, same "terminal 4xx short-circuits immediately".
//
// Before this, all four helpers were single-shot: one 502 from the edge in
// front of Supabase and a gold tool returned a hard error to the caller, with
// no attempt to find out whether the next 50ms would have worked.
const MAX_RETRIES = 2; // 1 initial + 2 retries = 3 attempts total
const BACKOFF_MS = [50, 200] as const;

/**
 * Ceiling on how much of an error body reaches an exception message.
 *
 * Every error path here used to interpolate the FULL `res.text()`. Supabase
 * sits behind Cloudflare, so a 522/524 answers with an HTML interstitial —
 * tens of KB — and that page landed whole in `error_log` AND in the MCP
 * response the model reads. 600 chars is comfortably more than any PostgREST
 * error envelope (`{"code","details","hint","message"}` runs ~100-300) while
 * cutting an HTML page down to its recognisable head.
 */
const ERROR_BODY_MAX_CHARS = 600;

/** Same classification as d1-proxy's `isTransientStatus`. */
function isTransientStatus(status: number): boolean {
  return status === 429 || status === 408 || (status >= 500 && status < 600);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Read an error body for an exception message, bounded and marked.
 *
 * Marked matters as much as bounded: a silently-cut body reads like the whole
 * story, so whoever is debugging goes looking for a cause that was clipped off
 * rather than for the rest of the page.
 */
async function errorBody(res: Response): Promise<string> {
  const t = await res.text().catch(() => '');
  if (t === '') return String(res.status);
  return t.length > ERROR_BODY_MAX_CHARS
    ? `${t.slice(0, ERROR_BODY_MAX_CHARS)} …[truncated, ${t.length} chars total]`
    : t;
}

/**
 * `fetch` with the shared abort budget plus retry-on-transient.
 *
 * Returns the LAST response — including a non-ok one — and lets each caller
 * build its own error message, so the existing per-helper wording
 * (`supabase rpc <fn> failed …` / `supabase count <path> failed …`) survives
 * unchanged. Throws only when every attempt failed at the network level.
 *
 * IDEMPOTENCE (why the PATCH in `sbWriteEmbedding` is retried too): retry is
 * safe when replaying the request cannot change the outcome. `sbRpc` bodies
 * are reads behind `/rpc/` and `sbSelect`/`sbCount` are GETs, so those are
 * trivially safe. The one write is
 * `PATCH pricebook_items?code=eq.X&item_type=eq.Y {embedding: <fixed vector>}`
 * — a full-value assignment on a keyed filter, computed BEFORE the first
 * attempt and byte-identical on every replay. Applying it twice leaves exactly
 * the state applying it once leaves, and the failure being protected against
 * is the ambiguous one (the PATCH reached Postgres, the response was lost) —
 * where the replay is a no-op. An INSERT, an upsert with a generated key, or
 * an increment would NOT qualify; this module has none of those. If one is
 * ever added, give it `retry: false` rather than assuming this comment covers
 * it.
 */
async function sbFetch(url: string, init: RequestInit): Promise<Response> {
  let lastNetworkError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        ...init,
        // A fresh signal per attempt: an AbortSignal is single-use, so reusing
        // one would make every retry after a timeout abort instantly.
        signal: AbortSignal.timeout(SUPABASE_FETCH_TIMEOUT_MS),
      });
      // Terminal (400/401/403/404/409/…) or success: hand it straight back.
      if (res.ok || !isTransientStatus(res.status)) return res;
      // Transient and out of attempts: return it so the caller reports the
      // real status rather than a synthesised network message.
      if (attempt === MAX_RETRIES) return res;
    } catch (err) {
      // A hit on the 25s abort budget is TERMINAL, not transient. The budget
      // is sized against the authenticator role's 30s statement_timeout, so
      // reaching it means the QUERY is too slow — the wire is fine. Retrying
      // would spend 3 x 25s = 75s of a caller's wall clock to be told the same
      // thing three times. Fast network failures below still retry.
      const name = (err as Error)?.name;
      if (name === 'TimeoutError' || name === 'AbortError') throw err;
      lastNetworkError = err as Error;
      if (attempt === MAX_RETRIES) break;
    }
    await sleep(BACKOFF_MS[attempt] ?? BACKOFF_MS[BACKOFF_MS.length - 1]);
  }

  throw lastNetworkError ?? new Error('supabase fetch failed: unknown');
}

/** Exact embed input the app uses (lib/refresh.ts embedMissing) — keep in lockstep. */
export function embedInputFor(row: {
  name?: string; description?: string | null; category_name?: string | null;
}): string {
  return [row.name, row.description ?? '', row.category_name ?? '']
    .filter(Boolean).join(' — ').slice(0, 1500);
}

/** Embed one query string → 768-float vector, or null on any failure (caller falls back to lexical). */
export async function embedQuery(env: Env, text: string): Promise<number[] | null> {
  try {
    const res: any = await (env.AI as any).run(EMBED_MODEL_ID, { text: [text] });
    const vec = res?.data?.[0];
    return Array.isArray(vec) && vec.length ? (vec as number[]) : null;
  } catch {
    return null;
  }
}

function headers(env: Env): Record<string, string> {
  return {
    apikey: env.SUPABASE_PB_KEY,
    Authorization: `Bearer ${env.SUPABASE_PB_KEY}`,
    'Content-Type': 'application/json',
  };
}

/**
 * Calls a Postgres function via PostgREST's `/rpc/<fn>` route.
 *
 * `schema`, when given, selects a non-`public` exposed schema via the
 * `Content-Profile` header (PostgREST's per-request schema switch for
 * write-method requests, which RPC POSTs are). Without it PostgREST
 * resolves the function name against the FIRST schema in the project's
 * `pgrst.db_schemas` list (`public`) and 404s (`PGRST202`) for a function
 * that only exists in another exposed schema — verified live 2026-07-18
 * calling `vec.match_entities` on project nlaaliehqpgskjmiuzze (which
 * exposes `public, gold, vec`): identical request minus this header
 * returns `PGRST202 Could not find the function public.match_entities`.
 * omit `schema` for `public`-schema RPCs (e.g. `search_pricebook_hybrid`)
 * — existing callers are unaffected.
 */
export async function sbRpc<T>(env: Env, fn: string, body: Record<string, unknown>, schema?: string): Promise<T> {
  const h = headers(env);
  if (schema) h['Content-Profile'] = schema;
  const res = await sbFetch(`${env.SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST', headers: h, body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`supabase rpc ${fn} failed ${res.status}: ${await errorBody(res)}`);
  }
  return res.json() as Promise<T>;
}

export async function sbSelect<T>(env: Env, pathAndQuery: string, schema?: string): Promise<T> {
  const h = headers(env);
  if (schema) h['Accept-Profile'] = schema;
  const res = await sbFetch(`${env.SUPABASE_URL}/rest/v1/${pathAndQuery}`, { headers: h });
  if (!res.ok) {
    throw new Error(`supabase select failed ${res.status}: ${await errorBody(res)}`);
  }
  return res.json() as Promise<T>;
}

/**
 * Row count for a PostgREST filter, read out of the `Content-Range` response
 * header rather than by pulling rows.
 *
 * `Prefer: count=exact` makes PostgREST answer `content-range: <range>/<total>`
 * (the range degrades to a bare `*` when the filtered set is empty, but the
 * total after the slash is still exact). `limit=1` is forced on so the body
 * stays one row: counting by reading rows would cap at the project's 1000-row
 * ceiling and silently under-report.
 *
 * Deliberately NOT `count=planned`: the planner estimate for
 * `vec.entity_chunks?trade_bu=is.null` measured 34,473 against an exact 31,203
 * on 2026-07-28 — 10% out, which is the sort of "close enough" that turns a
 * warning back into a lie. Callers that cannot afford an exact count should
 * cache the result, not downgrade its accuracy.
 */
export async function sbCount(env: Env, pathAndQuery: string, schema?: string): Promise<number> {
  const h = headers(env);
  if (schema) h['Accept-Profile'] = schema;
  h['Prefer'] = 'count=exact';
  const q = /[?&]limit=/.test(pathAndQuery)
    ? pathAndQuery
    : `${pathAndQuery}${pathAndQuery.includes('?') ? '&' : '?'}limit=1`;
  const res = await sbFetch(`${env.SUPABASE_URL}/rest/v1/${q}`, { headers: h });
  if (!res.ok) {
    throw new Error(`supabase count ${pathAndQuery} failed ${res.status}: ${await errorBody(res)}`);
  }
  const range = res.headers.get('content-range');
  const total = range?.split('/')[1];
  if (!total || !/^\d+$/.test(total)) {
    throw new Error(`supabase count ${pathAndQuery}: no exact count in content-range (${range ?? 'header absent'})`);
  }
  return Number(total);
}

/**
 * Provenance written alongside the vector once migration
 * supabase/migrations/0016 is applied: the `content_hash` the input text had
 * when it was embedded, and the model that produced the vector. Omit it
 * (pre-migration / legacy path) and ONLY `embedding` is named — PostgREST
 * rejects a PATCH that names a column the table does not have (PGRST204).
 */
export interface EmbeddingProvenance { contentHash: string | null; model: string }

export async function sbWriteEmbedding(
  env: Env, code: string, itemType: string, vector: number[], provenance?: EmbeddingProvenance,
): Promise<void> {
  const q = `pricebook_items?code=eq.${encodeURIComponent(code)}&item_type=eq.${encodeURIComponent(itemType)}`;
  // Body computed ONCE, outside sbFetch, so every retry replays byte-identical
  // bytes — the property that makes retrying this PATCH safe (see sbFetch).
  // The two provenance columns are full-value assignments on the same keyed
  // filter, so adding them keeps the replay idempotent.
  const embedding = `[${vector.join(',')}]`;
  const body = JSON.stringify(
    provenance
      ? { embedding, embedding_content_hash: provenance.contentHash, embedding_model: provenance.model }
      : { embedding },
  );
  const res = await sbFetch(`${env.SUPABASE_URL}/rest/v1/${q}`, {
    method: 'PATCH', headers: headers(env), body,
  });
  if (!res.ok && res.status !== 204) {
    throw new Error(
      `supabase embedding write ${code}/${itemType} failed ${res.status}: ${await errorBody(res)}`,
    );
  }
}

const PRICE_FIELDS = ['st_price', 'member_price', 'price', 'total_price_ref'] as const;

/** Dynamic-pricing honesty: 0/null/'0' → null; tag price_basis. Never emit $0. */
export function shapePriceRow<T extends Record<string, unknown>>(row: T): T & { price_basis: string } {
  const out: Record<string, unknown> = { ...row };
  let sawReference = false;
  for (const k of PRICE_FIELDS) {
    if (!(k in out)) continue;
    const v = out[k];
    if (v === 0 || v === null || v === undefined || v === '0') out[k] = null;
    else sawReference = true;
  }
  out.price_basis = sawReference ? 'reference (stored ST price)' : 'dynamic — computed at invoice';
  return out as T & { price_basis: string };
}
