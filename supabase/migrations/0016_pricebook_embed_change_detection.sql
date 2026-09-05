-- ============================================================
-- supabase/migrations/0016_pricebook_embed_change_detection.sql
--
-- Target: Supabase project nlaaliehqpgskjmiuzze (shared pricebook vector
-- store), schema `public`, table `pricebook_items`. POSTGRES, not D1.
--
-- APPLY MANUALLY — Luke runs this. Never applied by code, CI, wrangler, the
-- Supabase CLI, or an MCP tool. Idempotent; safe to re-run.
--
-- Where this file lives, and why: the numbering continues the
-- qsc-pricebook-search series (0001–0015 are applied to this same project
-- from that repo; 0012 added `embedding vector(768)`). It is committed here
-- because the only consumer of the view is this repo's PricebookEmbedWorkflow.
-- It is deliberately NOT under `migrations/` — that directory is this worker's
-- D1 (SQLite) migration set and `wrangler d1 migrations apply` would try to
-- run it.
--
-- Why: the embed backstop only ever filled NULL vectors. When the D1→Supabase
-- sync (qsc-pricebook-search, 09:00 UTC) overwrites name/description/
-- category_name, the old vector silently stays. `content_hash` tracks the
-- exact embed-input text; a row is re-embedded when the hash or the model it
-- was embedded with no longer matches. The workflow reads the view and writes
-- `embedding`, `embedding_content_hash = content_hash`, `embedding_model`
-- together, so a row leaves the view the moment its vector is current.
--
-- Effect on first application: every existing row has
-- embedding_content_hash / embedding_model NULL, so the view selects the
-- whole active catalog (~14.4k rows) and the workflow re-embeds it across
-- ~3 daily runs at the 5,000/run ceiling (bounded_stop:true until done).
-- If you would rather trust the existing vectors — skipping that one-time
-- re-embed and accepting that text drift from BEFORE this migration stays
-- undetected — run the OPTIONAL backfill at the bottom right after this file.
--
-- Until this is applied the workflow detects the missing view (PostgREST
-- 404 / PGRST205 / 42P01) and falls back to `embedding=is.null`, reporting
-- change_detection:'unavailable' and writing only `embedding`.
-- ============================================================

-- 1. Hash of the embed input text. Must stay in lockstep with `embedInputFor`
--    (mcp-servicetitan/src/supabase.ts) and the app's lib/refresh.ts — same
--    three columns. Generated + stored, so the sync's text overwrite updates it
--    with no app change. md5 is immutable → allowed in a generated column.
alter table public.pricebook_items
  add column if not exists content_hash text generated always as (md5(coalesce(name,'')||'|'||coalesce(description,'')||'|'||coalesce(category_name,''))) stored;

-- 2. What the current vector was computed from. NULL = unknown (pre-migration).
alter table public.pricebook_items add column if not exists embedding_content_hash text;
alter table public.pricebook_items add column if not exists embedding_model text;

comment on column public.pricebook_items.content_hash is
  'md5 of name|description|category_name — the embed input. Generated; compare to embedding_content_hash to detect stale vectors.';
comment on column public.pricebook_items.embedding_content_hash is
  'content_hash at the time `embedding` was written. Set by PricebookEmbedWorkflow together with the vector.';
comment on column public.pricebook_items.embedding_model is
  'Workers AI model id that produced `embedding`. Set by PricebookEmbedWorkflow together with the vector.';

-- 3. The drain source. Active rows whose vector is missing, stale, or from
--    another model. The model literal MUST match EMBED_MODEL_ID in
--    mcp-servicetitan/src/supabase.ts — bumping the model there means a new
--    migration that re-creates this view with the new id (and a full
--    re-embed, by design). security_invoker keeps the caller's privileges
--    (Supabase advisor flags definer views). ~14k rows: a seq scan is cheap,
--    so no partial index on the OR predicate.
create or replace view public.pricebook_items_needing_embedding
  with (security_invoker = true) as
select code, item_type, name, description, category_name, content_hash
  from public.pricebook_items
 where is_active = 1
   and (
        embedding is null
     or embedding_content_hash is distinct from content_hash
     or embedding_model is distinct from '@cf/baai/bge-base-en-v1.5'
   );

comment on view public.pricebook_items_needing_embedding is
  'Rows PricebookEmbedWorkflow must (re)embed: active AND (no vector OR text changed OR embedded with another model).';

grant select on public.pricebook_items_needing_embedding to anon, authenticated, service_role;

-- PostgREST picks up new relations via Supabase's DDL event trigger; the
-- explicit reload is a harmless belt-and-braces so the view is visible at once.
notify pgrst, 'reload schema';

-- ------------------------------------------------------------
-- OPTIONAL backfill — NOT run by default (see header). Trusts every existing
-- vector as current so the view starts near-empty instead of ~14.4k rows.
--
-- update public.pricebook_items
--    set embedding_content_hash = content_hash,
--        embedding_model        = '@cf/baai/bge-base-en-v1.5'
--  where embedding is not null
--    and embedding_content_hash is null;
--
-- ------------------------------------------------------------
-- Rollback (manual):
--
-- drop view if exists public.pricebook_items_needing_embedding;
-- alter table public.pricebook_items
--   drop column if exists embedding_model,
--   drop column if exists embedding_content_hash,
--   drop column if exists content_hash;
