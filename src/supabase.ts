// ============================================================
// supabase.ts — shared helpers for the Supabase-backed pricebook tools
// and the embedding-refresh Workflow. Read tools read; only the Workflow
// writes, and only pricebook_items.embedding.
// ============================================================
import type { Env } from './env';

export const EMBED_MODEL_ID = '@cf/baai/bge-base-en-v1.5';

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

export async function sbRpc<T>(env: Env, fn: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST', headers: headers(env), body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => String(res.status));
    throw new Error(`supabase rpc ${fn} failed ${res.status}: ${t}`);
  }
  return res.json() as Promise<T>;
}

export async function sbSelect<T>(env: Env, pathAndQuery: string): Promise<T> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
    headers: headers(env), signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => String(res.status));
    throw new Error(`supabase select failed ${res.status}: ${t}`);
  }
  return res.json() as Promise<T>;
}

export async function sbWriteEmbedding(
  env: Env, code: string, itemType: string, vector: number[],
): Promise<void> {
  const q = `pricebook_items?code=eq.${encodeURIComponent(code)}&item_type=eq.${encodeURIComponent(itemType)}`;
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${q}`, {
    method: 'PATCH', headers: headers(env),
    body: JSON.stringify({ embedding: `[${vector.join(',')}]` }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok && res.status !== 204) {
    const t = await res.text().catch(() => String(res.status));
    throw new Error(`supabase embedding write ${code}/${itemType} failed ${res.status}: ${t}`);
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
