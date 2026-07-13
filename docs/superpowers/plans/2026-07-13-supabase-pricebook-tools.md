# Supabase-backed pricebook tools + embedding-refresh Workflow — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the mcp-servicetitan connector natural-language pricebook search by reading the shared Supabase vector store, plus a durable Cloudflare Workflow that keeps embeddings fresh — retiring the dormant taylor-ai Vectorize path.

**Architecture:** Five read tools (`ToolDef`s on the existing `agents/mcp` handler) call `env.AI` to embed a query, then POST to Supabase RPCs / GET PostgREST. A plain Cloudflare `WorkflowEntrypoint` (`PricebookEmbedWorkflow`), kicked by a daily cron in the worker's `scheduled()` handler, drains rows where `embedding IS NULL`. Both key on `(code, item_type)`.

**Tech Stack:** TypeScript, Cloudflare Workers (wrangler 4.94), `agents` SDK 0.13 (`createMcpHandler`), Workers AI (`@cf/baai/bge-base-en-v1.5`), Cloudflare Workflows (`cloudflare:workers`), Supabase PostgREST, Zod, Vitest 4.

## Global Constraints

- **Embed model is EXACTLY `@cf/baai/bge-base-en-v1.5`** (768-d). A different model corrupts the shared vector space. Pin as a const; assert in tests.
- **Embed input text MUST match the app** (`lib/refresh.ts` `embedMissing`): `[name, description, category_name].filter(Boolean).join(' — ').slice(0,1500)`.
- **Embedding rows key on `(code, item_type)`** — `code` is NOT unique across item types.
- **Dynamic-pricing honesty:** a price field of `0`/null/`'0'` → surface as `null` with `price_basis: "dynamic — computed at invoice"`. NEVER emit `$0` for a dynamic item. Non-zero stored prices → `price_basis: "reference (stored ST price)"`.
- **Supabase creds:** `env.SUPABASE_URL` + `env.SUPABASE_PB_KEY` (a dedicated second secret key). Read tools read; only the Workflow writes, and only the `embedding` column.
- **Outbound guards:** `AbortSignal.timeout(10_000)`; `topK ≤ 20`, `limit_rows ≤ 25`.
- **Supabase project:** `nlaaliehqpgskjmiuzze`. RPCs already applied to prod (migrations 0007–0015); `embedding vector(768)` column exists (0012).
- **New pricebook tools are ST-endpoint-exempt** — they hit Supabase, not ServiceTitan. Each must be added to `COVERAGE_EXEMPT` in both `src/tools/__tests__/coverage_gate.test.ts` and `src/routes/admin-endpoints.ts`.
- **Repo hygiene:** mcp-servicetitan `main` is the working branch here; taylor-ai has many concurrent worktrees — always `git branch --show-current` before writing there.
- Run tests with `npx vitest run <path>` from `/home/taylor/work/mcp-servicetitan`.

---

## File Structure

**Create (mcp-servicetitan):**
- `src/supabase.ts` — Supabase/emb/ shaper helpers: `embedQuery`, `sbRpc`, `sbSelect`, `sbWriteEmbedding`, `shapePriceRow`, `EMBED_MODEL_ID`, `embedInputFor`.
- `src/supabase.test.ts` — helper unit tests.
- `src/tools/pricebook/search_pricebook_templates.ts` + `__tests__/search_pricebook_templates.test.ts`
- `src/tools/pricebook/get_proposal_tiers.ts` + `__tests__/get_proposal_tiers.test.ts`
- `src/tools/pricebook/find_packages_with_item.ts` + `__tests__/find_packages_with_item.test.ts`
- `src/tools/pricebook/get_service_breakout.ts` + `__tests__/get_service_breakout.test.ts`
- `src/workflows/pricebook-embed.ts` + `src/workflows/__tests__/pricebook-embed.test.ts`

**Modify (mcp-servicetitan):**
- `src/env.ts` — add `AI`, `EMBED_WORKFLOW`, `SUPABASE_URL`, `SUPABASE_PB_KEY`.
- `src/tools/pricebook/search_pricebook_semantic.ts` — repoint to `env.AI` + Supabase hybrid RPC.
- `src/tools/pricebook/__tests__/search_pricebook_semantic.test.ts` — new/rewritten tests.
- `src/tools/index.ts` — import + register the 4 new tools.
- `src/tools/__tests__/coverage_gate.test.ts` + `src/routes/admin-endpoints.ts` — exempt the 4 new tools.
- `src/index.ts` — export the Workflow class; add `scheduled()` to the default export.
- `wrangler.toml` — `[ai]`, `[[workflows]]`, `[triggers] crons`, mirrored under `[env.dev]`.

**Modify (taylor-ai — separate PR):**
- `src/index.ts` — remove `/api/pricebook/semantic-search` route.
- `wrangler.toml` — remove the `PRICEBOOK_INDEX` `[[vectorize]]` binding.

**Docs:**
- `CHANGELOG.md`, `references/knowledge-base.md`, qsc-infra skill catalog + `protected-modules.md`.

---

## Task 1: Supabase helper module + env types

**Files:**
- Modify: `src/env.ts`
- Create: `src/supabase.ts`
- Test: `src/supabase.test.ts`

**Interfaces:**
- Consumes: `Env` (extended here).
- Produces:
  - `EMBED_MODEL_ID: '@cf/baai/bge-base-en-v1.5'`
  - `embedInputFor(row: { name?: string; description?: string | null; category_name?: string | null }): string`
  - `embedQuery(env: Env, text: string): Promise<number[] | null>` — null on failure (caller falls back to lexical).
  - `sbRpc<T>(env: Env, fn: string, body: Record<string, unknown>): Promise<T>`
  - `sbSelect<T>(env: Env, pathAndQuery: string): Promise<T>` — `pathAndQuery` is everything after `/rest/v1/`.
  - `sbWriteEmbedding(env: Env, code: string, itemType: string, vector: number[]): Promise<void>`
  - `shapePriceRow<T extends Record<string, unknown>>(row: T): T`

- [ ] **Step 1: Add env bindings**

Edit `src/env.ts` — inside `interface Env`, add after the existing Secrets block:

```typescript
  // Workers AI (native binding) — pricebook query + row embeddings
  AI: unknown; // Ai binding; typed as unknown to avoid @cloudflare/workers-types Ai coupling in helpers

  // Supabase pricebook vector store (project nlaaliehqpgskjmiuzze)
  SUPABASE_URL: string;      // secret — https://<ref>.supabase.co
  SUPABASE_PB_KEY: string;   // secret — dedicated connector service key

  // Embedding-refresh Workflow binding
  EMBED_WORKFLOW: Workflow;  // cloudflare Workflows binding
```

- [ ] **Step 2: Write the failing test**

Create `src/supabase.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  EMBED_MODEL_ID, embedInputFor, embedQuery, sbRpc, sbSelect, sbWriteEmbedding, shapePriceRow,
} from './supabase';

function env(overrides: Record<string, unknown> = {}) {
  return {
    SUPABASE_URL: 'https://proj.supabase.co',
    SUPABASE_PB_KEY: 'sb-key',
    AI: { run: vi.fn(async () => ({ data: [[0.1, 0.2, 0.3]] })) },
    ...overrides,
  } as any;
}

describe('supabase helpers', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('EMBED_MODEL_ID is the locked model', () => {
    expect(EMBED_MODEL_ID).toBe('@cf/baai/bge-base-en-v1.5');
  });

  it('embedInputFor matches the app projection and truncates to 1500', () => {
    expect(embedInputFor({ name: 'Capacitor', description: 'Dual run', category_name: 'HVAC' }))
      .toBe('Capacitor — Dual run — HVAC');
    expect(embedInputFor({ name: 'X', description: null, category_name: null })).toBe('X');
    expect(embedInputFor({ name: 'A'.repeat(2000) }).length).toBe(1500);
  });

  it('embedQuery returns the vector on success', async () => {
    const e = env();
    await expect(embedQuery(e, 'shower caulk')).resolves.toEqual([0.1, 0.2, 0.3]);
    expect(e.AI.run).toHaveBeenCalledWith('@cf/baai/bge-base-en-v1.5', { text: ['shower caulk'] });
  });

  it('embedQuery returns null when AI throws', async () => {
    const e = env({ AI: { run: vi.fn(async () => { throw new Error('rate limit'); }) } });
    await expect(embedQuery(e, 'x')).resolves.toBeNull();
  });

  it('sbRpc POSTs to /rest/v1/rpc/<fn> with apikey headers', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([{ code: 'CAP-240' }]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const out = await sbRpc(env(), 'search_pricebook_hybrid', { query_text: 'cap' });
    expect(out).toEqual([{ code: 'CAP-240' }]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://proj.supabase.co/rest/v1/rpc/search_pricebook_hybrid');
    expect(init.method).toBe('POST');
    expect(init.headers.apikey).toBe('sb-key');
    expect(init.headers.Authorization).toBe('Bearer sb-key');
  });

  it('sbRpc throws on non-2xx', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    await expect(sbRpc(env(), 'fn', {})).rejects.toThrow(/supabase rpc fn failed 500/);
  });

  it('sbSelect GETs /rest/v1/<pathAndQuery>', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([{ st_id: 1 }]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const out = await sbSelect(env(), 'pricebook_items?st_id=eq.1');
    expect(out).toEqual([{ st_id: 1 }]);
    expect(fetchMock.mock.calls[0][0]).toBe('https://proj.supabase.co/rest/v1/pricebook_items?st_id=eq.1');
  });

  it('sbWriteEmbedding PATCHes by (code,item_type) with a bracketed vector literal', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    await sbWriteEmbedding(env(), 'CAP-240', 'material', [0.5, 0.6]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://proj.supabase.co/rest/v1/pricebook_items?code=eq.CAP-240&item_type=eq.material');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ embedding: '[0.5,0.6]' });
  });

  it('shapePriceRow nulls zero/absent prices and tags basis dynamic', () => {
    const r = shapePriceRow({ code: 'X', st_price: 0, member_price: null });
    expect(r.st_price).toBeNull();
    expect(r.member_price).toBeNull();
    expect(r.price_basis).toBe('dynamic — computed at invoice');
  });

  it('shapePriceRow keeps a non-zero price and tags basis reference', () => {
    const r = shapePriceRow({ code: 'X', st_price: 3278.24 });
    expect(r.st_price).toBe(3278.24);
    expect(r.price_basis).toBe('reference (stored ST price)');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/supabase.test.ts`
Expected: FAIL — `Cannot find module './supabase'`.

- [ ] **Step 4: Write the implementation**

Create `src/supabase.ts`:

```typescript
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
export function shapePriceRow<T extends Record<string, unknown>>(row: T): T {
  const out: Record<string, unknown> = { ...row };
  let sawReference = false;
  for (const k of PRICE_FIELDS) {
    if (!(k in out)) continue;
    const v = out[k];
    if (v === 0 || v === null || v === undefined || v === '0') out[k] = null;
    else sawReference = true;
  }
  out.price_basis = sawReference ? 'reference (stored ST price)' : 'dynamic — computed at invoice';
  return out as T;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/supabase.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. (`Workflow` type resolves from `@cloudflare/workers-types`, already in this project.)

- [ ] **Step 7: Commit**

```bash
git add src/env.ts src/supabase.ts src/supabase.test.ts
git commit -m "feat(pricebook): Supabase/embed/shaper helpers + env bindings"
```

---

## Task 2: Repoint `search_pricebook_semantic` to Supabase hybrid RPC

**Files:**
- Modify: `src/tools/pricebook/search_pricebook_semantic.ts`
- Test: `src/tools/pricebook/__tests__/search_pricebook_semantic.test.ts` (replace existing)

**Interfaces:**
- Consumes: `embedQuery`, `sbRpc`, `shapePriceRow` (Task 1).
- Produces: unchanged tool name `search_pricebook_semantic`, args `{ query: string; topK?: number }`.

- [ ] **Step 1: Write the failing test**

Replace `src/tools/pricebook/__tests__/search_pricebook_semantic.test.ts`:

```typescript
import { describe, it, expect, vi, afterEach } from 'vitest';
import { search_pricebook_semantic } from '../search_pricebook_semantic';

function env(aiRun: any) {
  return { SUPABASE_URL: 'https://p.supabase.co', SUPABASE_PB_KEY: 'k', AI: { run: aiRun } } as any;
}
const ctx = { actor: 'test', correlation: 'c1' };

afterEach(() => vi.unstubAllGlobals());

describe('search_pricebook_semantic (Supabase hybrid)', () => {
  it('embeds the query and passes the vector to the hybrid RPC; shapes $0 prices', async () => {
    const aiRun = vi.fn(async () => ({ data: [[0.1, 0.2]] }));
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(
      [{ code: 'CAULK-1', name: 'Silicone', item_type: 'material', st_price: 0, match_kind: 'vector', rank: 0.9 }],
    ), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const out: any = await search_pricebook_semantic.handler(env(aiRun), { query: 'shower caulk', topK: 5 }, ctx);

    expect(aiRun).toHaveBeenCalledWith('@cf/baai/bge-base-en-v1.5', { text: ['shower caulk'] });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.query_text).toBe('shower caulk');
    expect(body.query_embedding).toEqual([0.1, 0.2]);
    expect(body.limit_rows).toBe(5);
    expect(out.matches[0].st_price).toBeNull();
    expect(out.matches[0].price_basis).toBe('dynamic — computed at invoice');
    expect(out._source).toBe('supabase-hybrid');
  });

  it('falls back to lexical (query_embedding=null) when embedding fails', async () => {
    const aiRun = vi.fn(async () => { throw new Error('AI down'); });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await search_pricebook_semantic.handler(env(aiRun), { query: 'diagnostic fee' }, ctx);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.query_embedding).toBeNull();
  });

  it('caps topK at 20', async () => {
    const aiRun = vi.fn(async () => ({ data: [[0.1]] }));
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await search_pricebook_semantic.handler(env(aiRun), { query: 'x', topK: 999 }, ctx);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).limit_rows).toBe(20);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tools/pricebook/__tests__/search_pricebook_semantic.test.ts`
Expected: FAIL — old handler proxies via `ST_PROXY`, `_source` is `'vectorize'`.

- [ ] **Step 3: Rewrite the tool**

Replace `src/tools/pricebook/search_pricebook_semantic.ts`:

```typescript
// ============================================================
// search_pricebook_semantic — hybrid (code + lexical + vector) search
// over the shared Supabase pricebook store. Embeds the query via Workers
// AI, then calls the search_pricebook_hybrid RPC (migration 0014).
// Natural-language OR code queries both work; embed failure degrades to
// lexical (query_embedding=null) — the RPC handles both.
// ============================================================
import { z } from 'zod';
import type { Env } from '../../env';
import type { ToolDef } from '../index';
import { embedQuery, sbRpc, shapePriceRow } from '../../supabase';

interface Args { query: string; topK?: number; }

export const search_pricebook_semantic: ToolDef<Args> = {
  name: 'search_pricebook_semantic',
  description:
    'Semantic/hybrid search over the QSC pricebook — services, materials, equipment, fees. ' +
    'Use for natural-language descriptions ("replace capacitor on heat pump") or codes ("CAP-240"). ' +
    'Returns matches ranked by a fusion of exact-code, lexical, and vector similarity, with match_kind. ' +
    'Note: price may be null — QSC uses dynamic pricing computed at invoice time; never treat null as free.',
  zodSchema: {
    query: z.string().min(1).max(500).describe('Natural-language description or a pricebook code'),
    topK: z.number().int().min(1).max(20).default(10).optional().describe('Max results (default 10, max 20)'),
  },
  async handler(env: Env, args: Args) {
    const limit = Math.min(args.topK ?? 10, 20);
    const embedding = await embedQuery(env, args.query);
    const rows = await sbRpc<Array<Record<string, unknown>>>(env, 'search_pricebook_hybrid', {
      query_text: args.query,
      limit_rows: limit,
      query_embedding: embedding,     // null → lexical-only path in the RPC
      match_count: 50,
    });
    return {
      matches: (rows ?? []).map((r) => shapePriceRow(r)),
      query: args.query,
      _source: 'supabase-hybrid',
      _embedded: embedding !== null,
    };
  },
};
```

Note: no `transformResult` (shaping happens per-row via `shapePriceRow`), no `stEndpoint` (already `COVERAGE_EXEMPT`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/tools/pricebook/__tests__/search_pricebook_semantic.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/tools/pricebook/search_pricebook_semantic.ts src/tools/pricebook/__tests__/search_pricebook_semantic.test.ts
git commit -m "feat(pricebook): repoint search_pricebook_semantic to Supabase hybrid RPC"
```

---

## Task 3: `search_pricebook_templates` tool

**Files:**
- Create: `src/tools/pricebook/search_pricebook_templates.ts`
- Test: `src/tools/pricebook/__tests__/search_pricebook_templates.test.ts`
- Modify: `src/tools/index.ts`, `src/tools/__tests__/coverage_gate.test.ts`, `src/routes/admin-endpoints.ts`

**Interfaces:**
- Consumes: `sbRpc`, `shapePriceRow`.
- Produces: tool `search_pricebook_templates`, args `{ query: string; limit?: number }`.
- RPC: `search_templates(query_text text, limit_rows int default 12)` → rows `{ kind, id, name, item_count, total_price_ref, tier_label, proposal_name, rank }`.

- [ ] **Step 1: Write the failing test**

Create `src/tools/pricebook/__tests__/search_pricebook_templates.test.ts`:

```typescript
import { describe, it, expect, vi, afterEach } from 'vitest';
import { search_pricebook_templates } from '../search_pricebook_templates';

const env = { SUPABASE_URL: 'https://p.supabase.co', SUPABASE_PB_KEY: 'k' } as any;
const ctx = { actor: 'test', correlation: 'c1' };
afterEach(() => vi.unstubAllGlobals());

describe('search_pricebook_templates', () => {
  it('calls search_templates and shapes total_price_ref', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(
      [{ kind: 'template', id: 5, name: 'HVAC Tune-Up', item_count: 4, total_price_ref: 0, rank: 0.8 }],
    ), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const out: any = await search_pricebook_templates.handler(env, { query: 'tune up', limit: 6 }, ctx);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://p.supabase.co/rest/v1/rpc/search_templates');
    expect(JSON.parse(init.body)).toEqual({ query_text: 'tune up', limit_rows: 6 });
    expect(out.results[0].total_price_ref).toBeNull();
    expect(out.results[0].price_basis).toBe('dynamic — computed at invoice');
  });

  it('caps limit at 25 and defaults to 12', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await search_pricebook_templates.handler(env, { query: 'x', limit: 999 }, ctx);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).limit_rows).toBe(25);
    await search_pricebook_templates.handler(env, { query: 'x' }, ctx);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).limit_rows).toBe(12);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tools/pricebook/__tests__/search_pricebook_templates.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the tool**

Create `src/tools/pricebook/search_pricebook_templates.ts`:

```typescript
// ============================================================
// search_pricebook_templates — natural-language search over QSC estimate
// templates + proposals (Supabase search_templates RPC, migration 0015).
// ============================================================
import { z } from 'zod';
import type { Env } from '../../env';
import type { ToolDef } from '../index';
import { sbRpc, shapePriceRow } from '../../supabase';

interface Args { query: string; limit?: number; }

export const search_pricebook_templates: ToolDef<Args> = {
  name: 'search_pricebook_templates',
  description:
    'Search QSC estimate templates and proposals by name/keyword. Returns template & proposal hits ' +
    'with item counts, tier/proposal context, and a reference total. ' +
    'Note: total_price_ref may be null — QSC uses dynamic pricing computed at invoice time.',
  zodSchema: {
    query: z.string().min(1).max(300).describe('Template or proposal name/keyword'),
    limit: z.number().int().min(1).max(25).default(12).optional().describe('Max results (default 12, max 25)'),
  },
  async handler(env: Env, args: Args) {
    const limit = Math.min(args.limit ?? 12, 25);
    const rows = await sbRpc<Array<Record<string, unknown>>>(env, 'search_templates', {
      query_text: args.query, limit_rows: limit,
    });
    return { results: (rows ?? []).map((r) => shapePriceRow(r)), query: args.query, _source: 'supabase' };
  },
};
```

- [ ] **Step 4: Register the tool + exempt it**

In `src/tools/index.ts`: add the import near the other pricebook imports (after the `search_pricebook_semantic` import, line ~38):

```typescript
import { search_pricebook_templates } from './pricebook/search_pricebook_templates';
```

and add `search_pricebook_templates,` to the `// T6 Pricebook` group of the `TOOLS` array (after `search_pricebook_all, search_pricebook_semantic,`).

In `src/tools/__tests__/coverage_gate.test.ts`, add to `COVERAGE_EXEMPT`:

```typescript
  // Supabase-backed pricebook tools — hit Supabase, not ServiceTitan.
  'search_pricebook_templates',
```

In `src/routes/admin-endpoints.ts`, add the same name to its `COVERAGE_EXEMPT` set (keep the two lists in sync).

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/tools/pricebook/__tests__/search_pricebook_templates.test.ts src/tools/__tests__/coverage_gate.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/tools/pricebook/search_pricebook_templates.ts src/tools/pricebook/__tests__/search_pricebook_templates.test.ts src/tools/index.ts src/tools/__tests__/coverage_gate.test.ts src/routes/admin-endpoints.ts
git commit -m "feat(pricebook): add search_pricebook_templates tool"
```

---

## Task 4: `get_proposal_tiers` tool

**Files:**
- Create: `src/tools/pricebook/get_proposal_tiers.ts`
- Test: `src/tools/pricebook/__tests__/get_proposal_tiers.test.ts`
- Modify: `src/tools/index.ts`, `src/tools/__tests__/coverage_gate.test.ts`, `src/routes/admin-endpoints.ts`

**Interfaces:**
- Consumes: `sbRpc`, `shapePriceRow`.
- Produces: tool `get_proposal_tiers`, args `{ proposalId: number }`.
- RPC: `get_proposal_tiers(pid bigint)` → rows `{ template_id, name, tier_rank, tier_label, item_count, total_price_ref }`.

- [ ] **Step 1: Write the failing test**

Create `src/tools/pricebook/__tests__/get_proposal_tiers.test.ts`:

```typescript
import { describe, it, expect, vi, afterEach } from 'vitest';
import { get_proposal_tiers } from '../get_proposal_tiers';

const env = { SUPABASE_URL: 'https://p.supabase.co', SUPABASE_PB_KEY: 'k' } as any;
const ctx = { actor: 'test', correlation: 'c1' };
afterEach(() => vi.unstubAllGlobals());

describe('get_proposal_tiers', () => {
  it('passes pid and shapes tier prices', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([
      { template_id: 10, name: 'Good', tier_rank: 1, tier_label: 'Good', item_count: 3, total_price_ref: 1200 },
      { template_id: 11, name: 'Best', tier_rank: 3, tier_label: 'Best', item_count: 6, total_price_ref: 0 },
    ]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const out: any = await get_proposal_tiers.handler(env, { proposalId: 42 }, ctx);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://p.supabase.co/rest/v1/rpc/get_proposal_tiers');
    expect(JSON.parse(init.body)).toEqual({ pid: 42 });
    expect(out.tiers[0].total_price_ref).toBe(1200);
    expect(out.tiers[0].price_basis).toBe('reference (stored ST price)');
    expect(out.tiers[1].total_price_ref).toBeNull();
    expect(out.tiers[1].price_basis).toBe('dynamic — computed at invoice');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tools/pricebook/__tests__/get_proposal_tiers.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the tool**

Create `src/tools/pricebook/get_proposal_tiers.ts`:

```typescript
// ============================================================
// get_proposal_tiers — Good/Better/Best tier ladder for a QSC proposal
// (Supabase get_proposal_tiers RPC, migrations 0007/0008).
// ============================================================
import { z } from 'zod';
import type { Env } from '../../env';
import type { ToolDef } from '../index';
import { sbRpc, shapePriceRow } from '../../supabase';

interface Args { proposalId: number; }

export const get_proposal_tiers: ToolDef<Args> = {
  name: 'get_proposal_tiers',
  description:
    'Return the tier ladder (e.g. Good/Better/Best) for a QSC proposal by proposal id, ' +
    'with each tier’s template, item count, and reference total. ' +
    'Note: total_price_ref may be null — QSC uses dynamic pricing computed at invoice time.',
  zodSchema: {
    proposalId: z.number().int().positive().describe('Proposal id (pb_proposal_templates.id)'),
  },
  async handler(env: Env, args: Args) {
    const rows = await sbRpc<Array<Record<string, unknown>>>(env, 'get_proposal_tiers', { pid: args.proposalId });
    return { tiers: (rows ?? []).map((r) => shapePriceRow(r)), proposalId: args.proposalId, _source: 'supabase' };
  },
};
```

- [ ] **Step 4: Register + exempt**

`src/tools/index.ts`: import after the templates import:

```typescript
import { get_proposal_tiers } from './pricebook/get_proposal_tiers';
```

Add `get_proposal_tiers,` to the T6 Pricebook group of `TOOLS`. Add `'get_proposal_tiers',` to `COVERAGE_EXEMPT` in both `coverage_gate.test.ts` and `admin-endpoints.ts`.

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/tools/pricebook/__tests__/get_proposal_tiers.test.ts src/tools/__tests__/coverage_gate.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/tools/pricebook/get_proposal_tiers.ts src/tools/pricebook/__tests__/get_proposal_tiers.test.ts src/tools/index.ts src/tools/__tests__/coverage_gate.test.ts src/routes/admin-endpoints.ts
git commit -m "feat(pricebook): add get_proposal_tiers tool"
```

---

## Task 5: `find_packages_with_item` tool

**Files:**
- Create: `src/tools/pricebook/find_packages_with_item.ts`
- Test: `src/tools/pricebook/__tests__/find_packages_with_item.test.ts`
- Modify: `src/tools/index.ts`, `src/tools/__tests__/coverage_gate.test.ts`, `src/routes/admin-endpoints.ts`

**Interfaces:**
- Consumes: `sbRpc`, `sbSelect`.
- Produces: tool `find_packages_with_item`, args `{ code: string; itemType?: 'service'|'material'|'equipment'|'fee' }`.
- RPCs: `templates_with_item(item_code text)` → template/proposal rows; `services_with_item(item_st_id bigint)` → service rows. Resolve `st_id` from `(code,item_type)` via `sbSelect` first (code isn't unique).

- [ ] **Step 1: Write the failing test**

Create `src/tools/pricebook/__tests__/find_packages_with_item.test.ts`:

```typescript
import { describe, it, expect, vi, afterEach } from 'vitest';
import { find_packages_with_item } from '../find_packages_with_item';

const env = { SUPABASE_URL: 'https://p.supabase.co', SUPABASE_PB_KEY: 'k' } as any;
const ctx = { actor: 'test', correlation: 'c1' };
afterEach(() => vi.unstubAllGlobals());

function route(u: string) {
  if (u.includes('/rest/v1/pricebook_items')) return [{ st_id: 555 }];
  if (u.includes('/rpc/templates_with_item')) return [{ kind: 'template', id: 1, name: 'Pkg A' }];
  if (u.includes('/rpc/services_with_item')) return [{ st_id: 900, code: 'SVC-1', name: 'Install' }];
  return [];
}

describe('find_packages_with_item', () => {
  it('resolves st_id then queries templates + services reverse links', async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (u: string) => { calls.push(String(u)); return new Response(JSON.stringify(route(String(u))), { status: 200 }); });
    vi.stubGlobal('fetch', fetchMock);

    const out: any = await find_packages_with_item.handler(env, { code: 'CAP-240', itemType: 'material' }, ctx);

    expect(calls.some((u) => u.includes('pricebook_items?code=eq.CAP-240&item_type=eq.material&select=st_id'))).toBe(true);
    expect(calls.some((u) => u.includes('/rpc/templates_with_item'))).toBe(true);
    expect(calls.some((u) => u.includes('/rpc/services_with_item'))).toBe(true);
    expect(out.templates).toHaveLength(1);
    expect(out.services).toHaveLength(1);
  });

  it('skips services_with_item when st_id cannot be resolved', async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (u: string) => {
      calls.push(String(u));
      const body = String(u).includes('/rest/v1/pricebook_items') ? [] : route(String(u));
      return new Response(JSON.stringify(body), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const out: any = await find_packages_with_item.handler(env, { code: 'NOPE', itemType: 'material' }, ctx);
    expect(calls.some((u) => u.includes('/rpc/services_with_item'))).toBe(false);
    expect(out.services).toEqual([]);
    expect(out.templates).toHaveLength(1); // templates_with_item keys on code, still runs
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tools/pricebook/__tests__/find_packages_with_item.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the tool**

Create `src/tools/pricebook/find_packages_with_item.ts`:

```typescript
// ============================================================
// find_packages_with_item — reverse lookup: which templates/proposals and
// which services contain a given pricebook item. templates_with_item keys
// on code; services_with_item keys on st_id, so we resolve st_id from
// (code,item_type) first (code is not unique across item types).
// ============================================================
import { z } from 'zod';
import type { Env } from '../../env';
import type { ToolDef } from '../index';
import { sbRpc, sbSelect } from '../../supabase';

interface Args { code: string; itemType?: 'service' | 'material' | 'equipment' | 'fee'; }

export const find_packages_with_item: ToolDef<Args> = {
  name: 'find_packages_with_item',
  description:
    'Reverse lookup for a pricebook item: returns the estimate templates/proposals that include it ' +
    'and the services whose breakout contains it. Pass the item `code`; add `itemType` to disambiguate ' +
    '(codes are not unique across services/materials/equipment).',
  zodSchema: {
    code: z.string().min(1).max(64).describe('Pricebook item code (e.g. "CAP-240")'),
    itemType: z.enum(['service', 'material', 'equipment', 'fee']).optional()
      .describe('Disambiguates the code when it exists in more than one item type'),
  },
  async handler(env: Env, args: Args) {
    // 1. Resolve st_id from (code,item_type) for the services reverse link.
    let stId: number | null = null;
    const typeFilter = args.itemType ? `&item_type=eq.${encodeURIComponent(args.itemType)}` : '';
    const idRows = await sbSelect<Array<{ st_id: number | null }>>(
      env, `pricebook_items?code=eq.${encodeURIComponent(args.code)}${typeFilter}&select=st_id&limit=1`,
    );
    if (idRows?.[0]?.st_id != null) stId = idRows[0].st_id;

    // 2. templates_with_item keys on code; services_with_item keys on st_id.
    const templates = await sbRpc<Array<Record<string, unknown>>>(env, 'templates_with_item', { item_code: args.code });
    const services = stId != null
      ? await sbRpc<Array<Record<string, unknown>>>(env, 'services_with_item', { item_st_id: stId })
      : [];

    return { code: args.code, st_id: stId, templates: templates ?? [], services: services ?? [], _source: 'supabase' };
  },
};
```

- [ ] **Step 4: Register + exempt**

`src/tools/index.ts`: import + add `find_packages_with_item,` to the T6 group. Add `'find_packages_with_item',` to `COVERAGE_EXEMPT` in both files.

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/tools/pricebook/__tests__/find_packages_with_item.test.ts src/tools/__tests__/coverage_gate.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/tools/pricebook/find_packages_with_item.ts src/tools/pricebook/__tests__/find_packages_with_item.test.ts src/tools/index.ts src/tools/__tests__/coverage_gate.test.ts src/routes/admin-endpoints.ts
git commit -m "feat(pricebook): add find_packages_with_item reverse-link tool"
```

---

## Task 6: `get_service_breakout` tool

**Files:**
- Create: `src/tools/pricebook/get_service_breakout.ts`
- Test: `src/tools/pricebook/__tests__/get_service_breakout.test.ts`
- Modify: `src/tools/index.ts`, `src/tools/__tests__/coverage_gate.test.ts`, `src/routes/admin-endpoints.ts`

**Interfaces:**
- Consumes: `sbSelect`, `shapePriceRow`.
- Produces: tool `get_service_breakout`, args `{ code: string }`.
- Data: `pricebook_items` row for the service carries jsonb link columns `service_materials`, `service_equipment`, `recommendations`, `upgrades` (migration 0009), each an array of `{ skuId, ... }`. Resolve component items in one batch `st_id=in.(…)` select.

- [ ] **Step 1: Write the failing test**

Create `src/tools/pricebook/__tests__/get_service_breakout.test.ts`:

```typescript
import { describe, it, expect, vi, afterEach } from 'vitest';
import { get_service_breakout } from '../get_service_breakout';

const env = { SUPABASE_URL: 'https://p.supabase.co', SUPABASE_PB_KEY: 'k' } as any;
const ctx = { actor: 'test', correlation: 'c1' };
afterEach(() => vi.unstubAllGlobals());

describe('get_service_breakout', () => {
  it('reads the service row then resolves component items by st_id, shaping prices', async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (u: string) => {
      calls.push(String(u));
      if (String(u).includes('code=eq.SVC-1')) {
        return new Response(JSON.stringify([{
          st_id: 900, code: 'SVC-1', name: 'AC Install', item_type: 'service', st_price: 0, labor_hours: 4,
          service_materials: [{ skuId: 111 }], service_equipment: [{ skuId: 222 }],
          recommendations: [], upgrades: [],
        }]), { status: 200 });
      }
      // batch component resolve
      return new Response(JSON.stringify([
        { st_id: 111, code: 'MAT-1', name: 'Lineset', item_type: 'material', st_price: 40 },
        { st_id: 222, code: 'EQ-1', name: 'Condenser', item_type: 'equipment', st_price: 0 },
      ]), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const out: any = await get_service_breakout.handler(env, { code: 'SVC-1' }, ctx);

    expect(out.service.code).toBe('SVC-1');
    expect(out.service.st_price).toBeNull();          // $0 dynamic → null
    expect(out.service.labor_hours).toBe(4);
    expect(out.materials.map((m: any) => m.code)).toEqual(['MAT-1']);
    expect(out.equipment.map((e: any) => e.code)).toEqual(['EQ-1']);
    expect(out.equipment[0].st_price).toBeNull();
    expect(out.materials[0].st_price).toBe(40);
    // batch select used a single in.() call
    expect(calls.some((u) => u.includes('st_id=in.(111,222)'))).toBe(true);
  });

  it('returns empty component arrays when the service has no links', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([{
      st_id: 5, code: 'SVC-2', name: 'Diag', item_type: 'service', st_price: 89,
      service_materials: [], service_equipment: [], recommendations: [], upgrades: [],
    }]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const out: any = await get_service_breakout.handler(env, { code: 'SVC-2' }, ctx);
    expect(out.materials).toEqual([]);
    expect(out.equipment).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1); // no batch resolve needed
  });

  it('returns not_found when no service row matches', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([]), { status: 200 })));
    const out: any = await get_service_breakout.handler(env, { code: 'MISSING' }, ctx);
    expect(out.service).toBeNull();
    expect(out.not_found).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tools/pricebook/__tests__/get_service_breakout.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the tool**

Create `src/tools/pricebook/get_service_breakout.ts`:

```typescript
// ============================================================
// get_service_breakout — a service's labor + component materials/equipment,
// plus recommendation/upgrade links. Reads the service's jsonb link columns
// (migration 0009) then resolves component items in one batch st_id=in.() select.
// ============================================================
import { z } from 'zod';
import type { Env } from '../../env';
import type { ToolDef } from '../index';
import { sbSelect, shapePriceRow } from '../../supabase';

interface Args { code: string; }

type Row = Record<string, unknown>;
const LINK_COLS = ['service_materials', 'service_equipment', 'recommendations', 'upgrades'] as const;

function skuIds(row: Row): number[] {
  const ids = new Set<number>();
  for (const col of LINK_COLS) {
    const arr = row[col];
    if (Array.isArray(arr)) for (const e of arr) {
      const id = (e as { skuId?: number })?.skuId;
      if (typeof id === 'number') ids.add(id);
    }
  }
  return [...ids];
}

const SELECT_COLS =
  'st_id,code,name,description,item_type,category_name,st_price,member_price,cost,labor_hours,material_cost,unit_of_measure,primary_vendor_name,primary_vendor_part_number,service_materials,service_equipment,recommendations,upgrades';

export const get_service_breakout: ToolDef<Args> = {
  name: 'get_service_breakout',
  description:
    'Break out a pricebook service into its labor plus component materials and equipment, with ' +
    'recommended add-ons and upgrade options. Pass the service `code`. ' +
    'Note: prices may be null — QSC uses dynamic pricing computed at invoice time.',
  zodSchema: {
    code: z.string().min(1).max(64).describe('Service code (e.g. "SVC-1")'),
  },
  async handler(env: Env, args: Args) {
    const svcRows = await sbSelect<Row[]>(
      env, `pricebook_items?code=eq.${encodeURIComponent(args.code)}&item_type=eq.service&select=${SELECT_COLS}&limit=1`,
    );
    const svc = svcRows?.[0];
    if (!svc) return { service: null, not_found: true, _source: 'supabase' };

    const ids = skuIds(svc);
    let components: Row[] = [];
    if (ids.length) {
      components = await sbSelect<Row[]>(
        env, `pricebook_items?st_id=in.(${ids.join(',')})&select=${SELECT_COLS}`,
      );
    }
    const byId = new Map(components.map((c) => [c.st_id as number, shapePriceRow(c)]));
    const pick = (col: typeof LINK_COLS[number]) =>
      (Array.isArray(svc[col]) ? (svc[col] as Array<{ skuId?: number }>) : [])
        .map((e) => byId.get(e.skuId as number)).filter(Boolean);

    return {
      service: shapePriceRow(svc),
      materials: pick('service_materials'),
      equipment: pick('service_equipment'),
      recommendations: pick('recommendations'),
      upgrades: pick('upgrades'),
      _source: 'supabase',
    };
  },
};
```

- [ ] **Step 4: Register + exempt**

`src/tools/index.ts`: import + add `get_service_breakout,` to the T6 group. Add `'get_service_breakout',` to `COVERAGE_EXEMPT` in both files.

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/tools/pricebook/__tests__/get_service_breakout.test.ts src/tools/__tests__/coverage_gate.test.ts`
Expected: PASS.

- [ ] **Step 6: Full suite + typecheck gate**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all green. (Confirms the 4 new tools + repoint register cleanly and no other test regressed.)

- [ ] **Step 7: Commit**

```bash
git add src/tools/pricebook/get_service_breakout.ts src/tools/pricebook/__tests__/get_service_breakout.test.ts src/tools/index.ts src/tools/__tests__/coverage_gate.test.ts src/routes/admin-endpoints.ts
git commit -m "feat(pricebook): add get_service_breakout tool"
```

---

## Task 7: `PricebookEmbedWorkflow`

**Files:**
- Create: `src/workflows/pricebook-embed.ts`
- Test: `src/workflows/__tests__/pricebook-embed.test.ts`

**Interfaces:**
- Consumes: `EMBED_MODEL_ID`, `embedInputFor`, `sbSelect`, `sbWriteEmbedding` (Task 1).
- Produces: class `PricebookEmbedWorkflow extends WorkflowEntrypoint<Env, {}>`; `run(event, step)` returns `{ embedded: number; batches: number }`. The drain logic is factored into an exported `drainOnce(env, { batch, ceiling })` so it's unit-testable without a live Workflow runtime.

- [ ] **Step 1: Write the failing test**

Create `src/workflows/__tests__/pricebook-embed.test.ts`:

```typescript
import { describe, it, expect, vi, afterEach } from 'vitest';
import { drainOnce, EMBED_BATCH, RUN_CEILING } from '../pricebook-embed';

afterEach(() => vi.unstubAllGlobals());

function env(aiRun: any) {
  return { SUPABASE_URL: 'https://p.supabase.co', SUPABASE_PB_KEY: 'k', AI: { run: aiRun } } as any;
}

describe('PricebookEmbedWorkflow drainOnce', () => {
  it('embeds NULL rows with the locked model + app projection, writes by (code,item_type)', async () => {
    const aiRun = vi.fn(async () => ({ data: [[0.1, 0.2]] }));
    let served = false;
    const patched: any[] = [];
    const fetchMock = vi.fn(async (u: string, init: any) => {
      const url = String(u);
      if (url.includes('select=code') && !served) {
        served = true;
        return new Response(JSON.stringify([
          { code: 'CAP-240', item_type: 'material', name: 'Capacitor', description: 'Dual run', category_name: 'HVAC' },
        ]), { status: 200 });
      }
      if (url.includes('select=code')) return new Response(JSON.stringify([]), { status: 200 }); // backlog drained
      patched.push({ url, body: init?.body }); // PATCH write
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const out = await drainOnce(env(aiRun), { batch: 100, ceiling: 5000 });

    expect(aiRun).toHaveBeenCalledWith('@cf/baai/bge-base-en-v1.5', { text: ['Capacitor — Dual run — HVAC'] });
    expect(out.embedded).toBe(1);
    expect(patched[0].url).toContain('code=eq.CAP-240&item_type=eq.material');
    expect(JSON.parse(patched[0].body)).toEqual({ embedding: '[0.1,0.2]' });
  });

  it('is a no-op when the backlog is empty', async () => {
    const aiRun = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([]), { status: 200 })));
    const out = await drainOnce(env(aiRun), { batch: 100, ceiling: 5000 });
    expect(out.embedded).toBe(0);
    expect(aiRun).not.toHaveBeenCalled();
  });

  it('honors the per-run ceiling', async () => {
    const aiRun = vi.fn(async () => ({ data: [[0.1]] }));
    // Always returns one full batch → would loop forever without the ceiling.
    const fetchMock = vi.fn(async (u: string) => {
      if (String(u).includes('select=code')) {
        return new Response(JSON.stringify(
          Array.from({ length: 2 }, (_, i) => ({ code: `C${i}`, item_type: 'material', name: `n${i}` })),
        ), { status: 200 });
      }
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const out = await drainOnce(env(aiRun), { batch: 2, ceiling: 4 });
    expect(out.embedded).toBe(4); // 2 batches of 2, then stop at ceiling
    expect(EMBED_BATCH).toBe(100);
    expect(RUN_CEILING).toBe(5000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/workflows/__tests__/pricebook-embed.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the Workflow**

Create `src/workflows/pricebook-embed.ts`:

```typescript
// ============================================================
// PricebookEmbedWorkflow — durable backstop that keeps the Supabase
// pricebook vector column fresh. Drains rows where embedding IS NULL,
// idempotent with the app's embedMissing step (same predicate, keyed on
// (code,item_type)). Embeds with the locked model + app projection so the
// shared vector space stays consistent. Only writes the embedding column.
// ============================================================
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { Env } from '../env';
import { EMBED_MODEL_ID, embedInputFor, sbSelect, sbWriteEmbedding } from '../supabase';

export const EMBED_BATCH = 100;
export const RUN_CEILING = 5000;

interface NullRow {
  code: string; item_type: string;
  name?: string; description?: string | null; category_name?: string | null;
}

/** Drain up to `ceiling` NULL-embedding rows in batches. Pure w.r.t. Workflow runtime — unit-testable. */
export async function drainOnce(
  env: Env, opts: { batch: number; ceiling: number },
): Promise<{ embedded: number; batches: number }> {
  let embedded = 0;
  let batches = 0;
  while (embedded < opts.ceiling) {
    const remaining = opts.ceiling - embedded;
    const limit = Math.min(opts.batch, remaining);
    const rows = await sbSelect<NullRow[]>(
      env,
      `pricebook_items?is_active=eq.1&embedding=is.null&select=code,item_type,name,description,category_name&limit=${limit}`,
    );
    if (!rows || rows.length === 0) break;
    batches += 1;

    const inputs = rows.map(embedInputFor);
    const res: any = await (env.AI as any).run(EMBED_MODEL_ID, { text: inputs });
    const vectors: number[][] = res?.data ?? [];

    for (let i = 0; i < rows.length; i++) {
      const v = vectors[i];
      if (!Array.isArray(v) || v.length === 0) continue; // skip poisoned row; next run retries it
      await sbWriteEmbedding(env, rows[i].code, rows[i].item_type, v);
      embedded += 1;
    }
    if (rows.length < limit) break; // backlog exhausted
  }
  return { embedded, batches };
}

export class PricebookEmbedWorkflow extends WorkflowEntrypoint<Env, Record<string, never>> {
  async run(_event: WorkflowEvent<Record<string, never>>, step: WorkflowStep) {
    // One durable step per batch so an eviction resumes at the last committed batch.
    const result = await step.do(
      'drain-null-embeddings',
      { retries: { limit: 5, delay: '10 seconds', backoff: 'exponential' } },
      async () => drainOnce(this.env, { batch: EMBED_BATCH, ceiling: RUN_CEILING }),
    );
    return result;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/workflows/__tests__/pricebook-embed.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. If `cloudflare:workers` types are missing, confirm `compatibility_flags` include `nodejs_compat` and `@cloudflare/workers-types` is present (both already true). The `WorkflowEntrypoint`/`WorkflowStep`/`WorkflowEvent` types ship with `@cloudflare/workers-types`.

- [ ] **Step 6: Commit**

```bash
git add src/workflows/pricebook-embed.ts src/workflows/__tests__/pricebook-embed.test.ts
git commit -m "feat(pricebook): add PricebookEmbedWorkflow durable embed backstop"
```

---

## Task 8: Wire the Workflow — export, `scheduled()` cron, wrangler bindings

**Files:**
- Modify: `src/index.ts`, `wrangler.toml`

**Interfaces:**
- Consumes: `PricebookEmbedWorkflow` (Task 7), `EMBED_WORKFLOW` binding (Task 1 env).
- Produces: worker default export gains a `scheduled` handler; `PricebookEmbedWorkflow` is exported from the entry point.

- [ ] **Step 1: Export the Workflow class + add the scheduled handler**

In `src/index.ts`, next to the DO exports (after line ~32):

```typescript
export { PricebookEmbedWorkflow } from './workflows/pricebook-embed';
```

Add an overlap-guarded scheduled handler above the default export (before `const oauthProvider = ...`):

```typescript
// ─── Cron: kick the pricebook embedding-refresh Workflow (daily 10:00 UTC) ──────
// Overlap guard: skip if the last instance is still running. Instance id in KV.
async function scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
  const KEY = 'embed_workflow:last_instance';
  try {
    const lastId = await env.PROXY_STATE.get(KEY);
    if (lastId) {
      const prev = await env.EMBED_WORKFLOW.get(lastId).catch(() => null);
      const status = prev ? await prev.status().catch(() => null) : null;
      if (status && (status.status === 'running' || status.status === 'queued')) return; // still working
    }
    const inst = await env.EMBED_WORKFLOW.create();
    await env.PROXY_STATE.put(KEY, inst.id, { expirationTtl: 60 * 60 * 24 * 2 });
  } catch (err) {
    console.error('[scheduled] embed workflow kick failed:', err);
  }
}
```

Update the default export to include it:

```typescript
export default {
  fetch: oauthProvider.fetch.bind(oauthProvider),
  scheduled,
} satisfies ExportedHandler<Env>;
```

- [ ] **Step 2: Add wrangler bindings (prod)**

In `wrangler.toml`, in the top-level (prod) section:

Add after the `[observability]` block:

```toml
[ai]
binding = "AI"

[[workflows]]
name = "pricebook-embed"
binding = "EMBED_WORKFLOW"
class_name = "PricebookEmbedWorkflow"
```

Change the empty triggers line:

```toml
[triggers]
crons = ["0 10 * * *"]
```

Document the two new secrets in the secrets comment block:

```toml
# SUPABASE_URL - Supabase project URL (https://nlaaliehqpgskjmiuzze.supabase.co)
# SUPABASE_PB_KEY - dedicated connector Supabase secret key (read + embedding-column write)
```

- [ ] **Step 3: Mirror the bindings under `[env.dev]`**

In the `# DEV ENVIRONMENT` section, add:

```toml
[env.dev.ai]
binding = "AI"

[[env.dev.workflows]]
name = "pricebook-embed-dev"
binding = "EMBED_WORKFLOW"
class_name = "PricebookEmbedWorkflow"

[env.dev.triggers]
crons = ["0 10 * * *"]
```

- [ ] **Step 4: Typecheck + full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: green. (`ScheduledController` and the `Workflow` binding methods `.get()/.create()/.status()` resolve from `@cloudflare/workers-types`.)

- [ ] **Step 5: Dry-run the config**

Run: `npx wrangler deploy --dry-run --outdir /tmp/mcp-st-dryrun 2>&1 | tail -20`
Expected: build succeeds; output lists the `AI`, `EMBED_WORKFLOW` bindings and the cron trigger. No deploy happens.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts wrangler.toml
git commit -m "feat(pricebook): wire PricebookEmbedWorkflow — export, cron scheduled(), bindings"
```

---

## Task 9: Provisioning + dev deploy verification (manual gate)

**Files:** none (operational). This task is a checklist executed with Luke; do not claim done without the command output.

- [ ] **Step 1: Provision secrets (Luke mints the key first)**

Luke: Supabase dashboard → project `nlaaliehqpgskjmiuzze` → API keys → create a second secret key named `mcp-servicetitan-pb`. Then:

```bash
cd /home/taylor/work/mcp-servicetitan
echo "https://nlaaliehqpgskjmiuzze.supabase.co" | npx wrangler secret put SUPABASE_URL
echo "<the-new-key>"                              | npx wrangler secret put SUPABASE_PB_KEY
# dev mirror:
echo "https://nlaaliehqpgskjmiuzze.supabase.co" | npx wrangler secret put SUPABASE_URL --env dev
echo "<the-new-key>"                              | npx wrangler secret put SUPABASE_PB_KEY --env dev
```

- [ ] **Step 2: Preflight + deploy to dev**

Run: `bash scripts/preflight.sh && npx wrangler deploy --env dev`
Expected: preflight green (vitest + typecheck), dev worker deploys, output confirms `AI` + `EMBED_WORKFLOW` bindings and the cron.

- [ ] **Step 3: MCP probe the read tools (dev)**

Use the probe script from the mcp-servicetitan skill against `https://mcp-servicetitan-dev.lpeluso.workers.dev/mcp`. Call `tools/call` for each and assert no `$0` on any dynamic item:
- `search_pricebook_semantic` `{query:"shower caulk"}` → caulk/sealant rows, `_source:"supabase-hybrid"`, `_embedded:true`.
- `search_pricebook_semantic` `{query:"3 ton AC condenser"}` → condenser rows.
- `search_pricebook_semantic` `{query:"cap240"}` → CAP-240 as a code-tier hit.
- `search_pricebook_templates` `{query:"tune up"}` → ≥1 template.
- `get_service_breakout` `{code:"<known service code>"}` → labor + component arrays.
- `get_proposal_tiers` `{proposalId:<known id>}` → tier ladder.
- `find_packages_with_item` `{code:"<known material code>", itemType:"material"}` → templates and/or services.

- [ ] **Step 4: Verify the Workflow drains (dev)**

```bash
# Force one dev row's embedding to NULL (via Supabase MCP execute_sql or the dashboard):
#   update pricebook_items set embedding = null where code = '<known code>' and item_type = 'material';
# Kick the workflow immediately instead of waiting for cron:
npx wrangler workflows instances create pricebook-embed-dev --env dev
# Watch it:
npx wrangler workflows instances describe pricebook-embed-dev latest --env dev
# Confirm the row is re-embedded:
#   select code, (embedding is not null) as has_vec from pricebook_items where code='<known code>';
```
Expected: instance completes; the forced-null row has a vector again.

- [ ] **Step 5: Deploy to prod**

Run: `npx wrangler deploy` (or let CI deploy from `main`). Verify `/health` shows the 4 new tool names; run one prod `/mcp` probe of `search_pricebook_semantic`. Confirm the first prod cron run (or a manual `wrangler workflows instances create pricebook-embed`) logs an embedded count.

- [ ] **Step 6: Commit any config tweaks surfaced during verification** (e.g. `RUN_CEILING`/cron adjustment). Otherwise nothing to commit.

---

## Task 10: Decommission the taylor-ai Vectorize path (separate repo/PR)

**Files (taylor-ai):**
- Modify: `src/index.ts` (remove the `/api/pricebook/semantic-search` route)
- Modify: `wrangler.toml` (remove the `PRICEBOOK_INDEX` `[[vectorize]]` binding)

Do this only after Task 9 Step 5 confirms the connector serves search from Supabase in prod.

- [ ] **Step 1: Confirm branch state**

Run: `cd /home/taylor/work/taylor-ai && git branch --show-current && git fetch && git status -u`
Expected: a clean branch off `main` (create `chore/retire-pricebook-vectorize` if on `main`). Do NOT write onto an unrelated in-progress branch.

- [ ] **Step 2: Remove the route**

Delete the `// ── Pricebook semantic search (Vectorize) ──` block in `src/index.ts` (the `app.get('/api/pricebook/semantic-search', dualAuth, …)` handler, ~line 1343–1361). **Leave `VOICE_VECTORIZE` and every `/api/rag/*` route intact** — separate, dev-gated feature.

- [ ] **Step 3: Remove the binding**

In `wrangler.toml`, delete the `PRICEBOOK_INDEX` `[[vectorize]]` block (the first one, ~line 160–164, under `# ── Vectorize — semantic pricebook search ──`). Leave the `VOICE_VECTORIZE` vectorize block.

- [ ] **Step 4: Typecheck + build-check**

Run: `cd /home/taylor/work/taylor-ai && npx tsc --noEmit && npx wrangler deploy --dry-run --outdir /tmp/tai-dryrun 2>&1 | tail -20`
Expected: builds; dry-run output no longer lists `PRICEBOOK_INDEX`.

- [ ] **Step 5: Commit + deploy**

```bash
git add src/index.ts wrangler.toml
git commit -m "chore: retire dormant pricebook Vectorize path (moved to mcp-servicetitan + Supabase)"
```
Deploy (or PR → merge → CI). After the binding-drop deploy is live:

```bash
npx wrangler vectorize delete <pricebook-index-name>   # name from the removed [[vectorize]] block
```
Expected: index deleted. (The path was already dead — it embedded with bge-**small** 384-d against a 768-d index.)

---

## Task 11: Docs + memory

**Files:**
- Modify: `CHANGELOG.md`, `references/knowledge-base.md` (mcp-servicetitan)
- Modify: qsc-infra skill catalog (`.claude/skills/mcp-servicetitan/SKILL.md`) + `.claude/rules/protected-modules.md`

- [ ] **Step 1: CHANGELOG + knowledge-base**

Add a CHANGELOG entry (new minor version): the 4 new pricebook tools + repointed semantic search + `PricebookEmbedWorkflow` + daily cron. In `references/knowledge-base.md`, add the 5 tools to the pricebook section and document the Workflow/cron + the two Supabase secrets.

- [ ] **Step 2: Skill catalog (qsc-infra canonical)**

In `/home/taylor/qsc-infra/.claude/skills/mcp-servicetitan/SKILL.md`, add the 4 new tools to the Pricebook row of the tool catalog and bump the tool count. Note the Supabase-backed source + the embedding Workflow.

- [ ] **Step 3: protected-modules**

If the Workflow class warrants protection, add `src/workflows/pricebook-embed.ts` + `src/supabase.ts` to the mcp-servicetitan protected-files list in `/home/taylor/qsc-infra/.claude/rules/protected-modules.md`.

- [ ] **Step 4: Memory graph**

Add an observation to the `mcp-servicetitan` (or `qsc-pricebook-search`) entity: the connector now serves pricebook search from the shared Supabase store and owns a durable embed-backstop Workflow; the taylor-ai Vectorize path is retired. Link `[[qsc-pricebook-search]]`.

- [ ] **Step 5: Commit**

```bash
cd /home/taylor/work/mcp-servicetitan && git add CHANGELOG.md references/knowledge-base.md && git commit -m "docs: Supabase pricebook tools + embed Workflow"
cd /home/taylor/qsc-infra && git add .claude/skills/mcp-servicetitan .claude/rules/protected-modules.md && git commit -m "docs(skill): mcp-servicetitan Supabase pricebook tools + embed Workflow"
```

---

## Self-Review

**Spec coverage:**
- §2 five tools → Tasks 2–6. ✓
- §3.1 `[ai]` + `[[workflows]]` + cron → Task 8. ✓
- §3.2 secrets → Task 1 (types) + Task 9 (provisioning). ✓
- §3.3 pricing honesty → `shapePriceRow` (Task 1) applied in every read tool (Tasks 2–6). ✓
- §3.4 security/failure → timeout + caps in helpers (Task 1); embed→lexical fallback (Task 2); Supabase-error throws (helpers). ✓
- §4.1 Vectorize decommission → Task 10. ✓
- §4.2 provisioning → Task 9. ✓
- §4.3 testing → unit tests each task; dev/prod probes Task 9. ✓
- §5 Workflow (shape/steps/consistency/safety) → Task 7 + Task 8. ✓
- §5.4 stale-on-change gap → out of scope, noted; no task (correct). ✓

**Placeholder scan:** `<the-new-key>`, `<known service code>`, `<pricebook-index-name>` in Task 9/10 are runtime values Luke supplies at execution — acceptable operational placeholders, not code placeholders. No `TODO`/`TBD` in code.

**Type consistency:** `embedQuery/sbRpc/sbSelect/sbWriteEmbedding/shapePriceRow/embedInputFor/EMBED_MODEL_ID` defined in Task 1, consumed with matching signatures in Tasks 2–7. `drainOnce/EMBED_BATCH/RUN_CEILING` defined in Task 7, consumed in its test. `EMBED_WORKFLOW`/`AI`/`SUPABASE_*` defined in Task 1 env, used in Tasks 7–8. Consistent. ✓
