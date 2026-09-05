// ============================================================
// PricebookEmbedWorkflow — durable backstop that keeps the Supabase
// pricebook vector column fresh.
//
// Drain source (decided once per run, in its own durable step):
//   'view'        — public.pricebook_items_needing_embedding
//                   (supabase/migrations/0016): active rows whose vector is
//                   NULL, whose text changed (content_hash drifted), or that
//                   were embedded with another model. Writes embedding +
//                   embedding_content_hash + embedding_model together.
//   'unavailable' — the view does not exist yet (migration not applied):
//                   fall back to the original `embedding IS NULL` predicate
//                   and write ONLY the embedding column.
//
// One durable step PER BATCH (`embed-batch-<n>`), so a retry after a failure
// resumes at the batch that failed rather than re-running the whole drain.
// Progress is still persisted in Postgres (a written row leaves the view), so
// a retried batch is idempotent — it just re-selects whatever is still pending.
// Embeds with the locked model + app projection so the shared vector space
// stays consistent.
// ============================================================
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { Env } from '../env';
import { EMBED_MODEL_ID, embedInputFor, sbCount, sbSelect, sbWriteEmbedding } from '../supabase';

export const EMBED_BATCH = 100;
/** Max rows EMBEDDED per run. Steps are additionally capped at ceil(ceiling / batch). */
export const RUN_CEILING = 5000;
/** Change-detection view (Postgres, supabase/migrations/0016). PostgREST reads views like tables. */
export const NEEDING_VIEW = 'pricebook_items_needing_embedding';

const LEGACY_QUERY = 'pricebook_items?is_active=eq.1&embedding=is.null';
const ROW_COLUMNS = 'code,item_type,name,description,category_name';

export type ChangeDetection = 'view' | 'unavailable';

interface PendingRow {
  code: string; item_type: string;
  name?: string; description?: string | null; category_name?: string | null;
  /** Present on the view only. */
  content_hash?: string | null;
}

/** What one `embed-batch-<n>` step returns (persisted by the Workflow runtime). */
export interface BatchResult {
  fetched: number;
  embedded: number;
  /** Vector produced but the PATCH failed — row stays pending, next run retries it. */
  failed: number;
  /** No usable vector came back for the row — row stays pending, next run retries it. */
  skipped: number;
}

export interface DrainResult extends BatchResult {
  batches: number;
  /** Stopped at a bound (row ceiling or step cap) with the last page full — rows very likely remain. */
  bounded_stop: boolean;
  /** A full page made zero forward progress (no-progress guard) — ended early, NOT at a bound. */
  stalled: boolean;
  /** Exact count still pending after the run (`Prefer: count=exact`), or null if PostgREST gave none. */
  remaining_estimate: number | null;
  change_detection: ChangeDetection;
  model: string;
}

interface StepRetryConfig {
  retries?: { limit: number; delay: string | number; backoff?: 'constant' | 'linear' | 'exponential' };
  timeout?: string | number;
}

/** The slice of WorkflowStep the drain needs — lets unit tests drive it with a recorder. */
export interface StepLike {
  do<T>(name: string, config: StepRetryConfig, fn: () => Promise<T>): Promise<T>;
}

const BATCH_RETRY: StepRetryConfig = { retries: { limit: 5, delay: '10 seconds', backoff: 'exponential' } };
const CHEAP_RETRY: StepRetryConfig = { retries: { limit: 1, delay: '5 seconds' } };

/** Runs step callbacks inline — for callers without a Workflow runtime. */
const inlineStep: StepLike = { do: (_name, _config, fn) => fn() };

/** PostgREST answers a missing relation with 404 (PGRST205 on v12+, 42P01 on older builds). */
function isRelationMissing(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err);
  return /\bfailed 404\b/.test(msg) || /PGRST205|42P01/.test(msg);
}

/** Probe the view once; anything other than "relation missing" is a real error and propagates. */
export async function detectSource(env: Env): Promise<ChangeDetection> {
  try {
    await sbSelect<unknown>(env, `${NEEDING_VIEW}?select=code&limit=1`);
    return 'view';
  } catch (err) {
    if (isRelationMissing(err)) return 'unavailable';
    throw err;
  }
}

function pendingQuery(source: ChangeDetection): string {
  return source === 'view'
    ? `${NEEDING_VIEW}?select=${ROW_COLUMNS},content_hash`
    : `${LEGACY_QUERY}&select=${ROW_COLUMNS}`;
}

/** One page: select → embed → per-row PATCH. Pure w.r.t. the Workflow runtime. */
export async function embedBatch(env: Env, source: ChangeDetection, limit: number): Promise<BatchResult> {
  const rows = (await sbSelect<PendingRow[]>(env, `${pendingQuery(source)}&limit=${limit}`)) ?? [];
  const out: BatchResult = { fetched: rows.length, embedded: 0, failed: 0, skipped: 0 };
  if (rows.length === 0) return out;

  const res: any = await (env.AI as any).run(EMBED_MODEL_ID, { text: rows.map(embedInputFor) });
  const vectors: number[][] = res?.data ?? [];

  // Per-row PATCH: PostgREST has no per-row bulk UPDATE, and a bulk upsert
  // (POST + Prefer: resolution=merge-duplicates) would INSERT on a missing key
  // and break the retry-safety contract documented on sbFetch. Kept per-row.
  for (let i = 0; i < rows.length; i++) {
    const v = vectors[i];
    if (!Array.isArray(v) || v.length === 0) { out.skipped += 1; continue; } // poisoned row; next run retries it
    const { code, item_type } = rows[i];
    // Hash as READ with the row, not re-read at write time: if the text changes
    // between select and PATCH the stored hash no longer matches and the view
    // re-selects the row next run — exactly the behaviour wanted.
    const provenance = source === 'view'
      ? { contentHash: rows[i].content_hash ?? null, model: EMBED_MODEL_ID }
      : undefined;
    try {
      await sbWriteEmbedding(env, code, item_type, v, provenance);
      out.embedded += 1;
    } catch (err) {
      out.failed += 1;
      console.error(`[pricebook-embed] write failed ${code}/${item_type}:`, (err as Error)?.message ?? err);
    }
  }
  return out;
}

/**
 * Drain pending rows in per-batch durable steps, up to `ceiling` embedded rows.
 * `step` defaults to inline execution so the drain is unit-testable without a Workflow runtime.
 */
export async function drainOnce(
  env: Env, opts: { batch: number; ceiling: number }, step: StepLike = inlineStep,
): Promise<DrainResult> {
  const source = await step.do('detect-source', CHEAP_RETRY, () => detectSource(env));

  const totals: BatchResult = { fetched: 0, embedded: 0, failed: 0, skipped: 0 };
  let batches = 0;
  let stalled = false;
  let lastPageFull = false;
  // Two bounds: the row ceiling (embedded) and a step cap so a run where most
  // rows skip/fail cannot spin up thousands of tiny steps.
  const maxBatches = Math.max(1, Math.ceil(opts.ceiling / opts.batch));
  let n = 0;

  while (totals.embedded < opts.ceiling && n < maxBatches) {
    n += 1;
    const limit = Math.min(opts.batch, opts.ceiling - totals.embedded);
    const r = await step.do(`embed-batch-${n}`, BATCH_RETRY, () => embedBatch(env, source, limit));
    if (r.fetched === 0) break; // backlog exhausted — an empty page is not a batch

    batches += 1;
    totals.fetched += r.fetched;
    totals.embedded += r.embedded;
    totals.failed += r.failed;
    totals.skipped += r.skipped;
    lastPageFull = r.fetched === limit;
    if (!lastPageFull) break; // short page — backlog exhausted
    // No forward progress on a full page (every row skipped or failed): re-issuing the same
    // unordered select would return the same stuck rows forever. End this run cleanly; the next
    // scheduled run gets a fresh attempt.
    if (r.embedded === 0) { stalled = true; break; }
  }

  const hitBound = totals.embedded >= opts.ceiling || n >= maxBatches;
  const bounded_stop = lastPageFull && !stalled && hitBound;

  const remaining_estimate = await step.do('count-remaining', CHEAP_RETRY, async () => {
    try {
      return await sbCount(env, `${pendingQuery(source)}`);
    } catch (err) {
      console.error('[pricebook-embed] remaining count unavailable:', (err as Error)?.message ?? err);
      return null;
    }
  });

  return { ...totals, batches, bounded_stop, stalled, remaining_estimate, change_detection: source, model: EMBED_MODEL_ID };
}

export class PricebookEmbedWorkflow extends WorkflowEntrypoint<Env, Record<string, never>> {
  async run(_event: WorkflowEvent<Record<string, never>>, step: WorkflowStep): Promise<DrainResult> {
    return drainOnce(this.env, { batch: EMBED_BATCH, ceiling: RUN_CEILING }, step);
  }
}
