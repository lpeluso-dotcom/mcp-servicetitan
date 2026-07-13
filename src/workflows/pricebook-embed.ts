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
    const embeddedBeforeBatch = embedded;

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
    // No forward progress on a full batch (every row failed to produce a writable vector) —
    // re-issuing the same unordered select would return the same stuck rows forever. End this
    // run cleanly; the Workflow step's own retry gives a fresh attempt next scheduled run.
    if (embedded === embeddedBeforeBatch) break;
  }
  return { embedded, batches };
}

export class PricebookEmbedWorkflow extends WorkflowEntrypoint<Env, Record<string, never>> {
  async run(_event: WorkflowEvent<Record<string, never>>, step: WorkflowStep) {
    // One durable step wraps the whole drain (not one step per batch). That's still safe to
    // retry: progress is persisted as writes to the Supabase embedding column, not in step
    // state, so a retried or re-run attempt just resumes against whatever rows are still NULL.
    const result = await step.do(
      'drain-null-embeddings',
      { retries: { limit: 5, delay: '10 seconds', backoff: 'exponential' } },
      async () => drainOnce(this.env, { batch: EMBED_BATCH, ceiling: RUN_CEILING }),
    );
    return result;
  }
}
