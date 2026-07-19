// ============================================================
// prompts/index.ts — Phase 2 Task 2.3
//
// 5 MCP prompts (guided QSC workflows) so clients get one-tap multi-tool
// orchestration instead of having to know which tools to chain and how.
// Each prompt returns a single user-role text message that names the EXACT
// tool names to call, the arg mapping, and the expected output shape — this
// is where QSC workflow knowledge (which tools, in what order, producing
// what report) gets encoded for the calling model to follow.
//
// Registered into the per-request McpServer by registerPrompts() (called
// from buildServer() in src/index.ts, after the tool-registration loop).
//
// SDK shape (confirmed against node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.d.ts):
//   server.registerPrompt(name, { title?, description?, argsSchema? }, cb)
//   argsSchema is a ZodRawShape (plain object of zod validators — NOT z.object(...)).
//   cb(args, extra) => GetPromptResult = { messages: [{ role, content: { type: 'text', text } }] }
//
// Prompt arguments always arrive over the wire as strings (MCP prompts/get
// params.arguments is Record<string, string>), so numeric args below use
// z.coerce.number() rather than z.number() — the SDK runs argsSchema.parse()
// on the raw string args before invoking build().
// ============================================================

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { completable } from '@modelcontextprotocol/sdk/server/completable.js';
import type { Env } from '../env';
import { listBusinessUnits } from '../name-cache';

type PromptMessage = {
  role: 'user';
  content: { type: 'text'; text: string };
};

// Loosely typed on purpose: each prompt's build() takes its own args shape,
// and PROMPTS is a heterogeneous array. Callers (tests, registerPrompts) only
// need name/description/build to be present with these signatures.
export interface PromptDef {
  name: string;
  title: string;
  description: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  argsSchema: Record<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  build: (args: any) => PromptMessage[];
}

function userText(text: string): PromptMessage[] {
  return [{ role: 'user', content: { type: 'text', text } }];
}

export const PROMPTS: readonly PromptDef[] = [
  // ── 1. job-cost-margin ──────────────────────────────────────────────────
  {
    name: 'job-cost-margin',
    title: 'Job / BU Margin',
    description:
      'Real margin for one job (labor-inclusive) or a business unit over a window (item/material margin from gold).',
    argsSchema: {
      jobId: z.coerce.number().optional().describe('Single job to margin-review (labor-inclusive).'),
      businessUnitId: z.coerce.number().optional().describe('Business unit ID for a windowed roll-up.'),
      from: z.string().optional().describe('Window start YYYY-MM-DD (BU mode).'),
      to: z.string().optional().describe('Window end YYYY-MM-DD (BU mode).'),
    },
    build(args: { jobId?: number; businessUnitId?: number; from?: string; to?: string }) {
      if (args.jobId !== undefined) {
        return userText(
          `Produce a labor-inclusive margin review for job ${args.jobId}. Call:\n` +
            `1. job_cost_actuals (jobId=${args.jobId}) — revenue, invoice, and computed labor burden ` +
            `(drive+work minutes × rate) plus material/equipment cost lines.\n\n` +
            `Report: revenue, total actual cost (labor + material), GP$ and GP% for job ${args.jobId}. ` +
            `Note if any cost line looks incomplete. If the TAI-QBO connector is also connected, you may layer ` +
            `in QBO-posted vendor/overhead cost for a fuller picture — otherwise report ST/D1 cost only.`,
        );
      }
      const from = args.from ?? '(start of month)';
      const to = args.to ?? '(today)';
      const buClause = args.businessUnitId !== undefined ? `businessUnitId=${args.businessUnitId}` : '(all business units)';
      return userText(
        `Produce an item/material margin roll-up for ${buClause} from ${from} to ${to}. Call:\n` +
          `1. gold_margin_by_bu (from=${from}, to=${to}${args.businessUnitId !== undefined ? `, businessUnitId=${args.businessUnitId}` : ''}) ` +
          `— gold-sourced revenue, cost, GP$ and GP% by business unit.\n\n` +
          `Report a table sorted by revenue descending: BU, revenue, cost, GP$, GP%. ` +
          `IMPORTANT: this margin is item/material only — it EXCLUDES labor burden (gold has no timesheet grain). ` +
          `Say so explicitly. For a single job's labor-inclusive margin, use the jobId form of this prompt instead.`,
      );
    },
  },

  // ── 2. daily-review ─────────────────────────────────────────────────────
  {
    name: 'daily-review',
    title: 'Daily Review',
    description: "Today's job load, capacity, holds, dispatch-pro alerts and a quick AR glance for the day.",
    argsSchema: { date: z.string().optional().describe('ISO date (default: "today").') },
    build(args: { date?: string }) {
      const date = args.date ?? 'today';
      return userText(
        `Produce a daily operations review for ${date}. Call in order:\n` +
          `1. list_jobs_today (date=${date}) — the day's job load.\n` +
          `2. get_capacity — capacity for the BUs with jobs on ${date}.\n` +
          `3. dispatch_pro_alerts_list — open Dispatch Pro alerts for ${date}.\n` +
          `4. jobs_hold_reasons_list — any jobs on hold and why.\n` +
          `5. list_unpaid_invoices — a brief top-balances glance (top 5 only).\n\n` +
          `Produce a scannable brief: jobs by BU, capacity gaps, open alerts (severity + affected job/tech), ` +
          `held jobs, and the 5 largest open balances. Read in under a minute before the day starts.`,
      );
    },
  },

  // ── 3. pricebook-health ─────────────────────────────────────────────────
  {
    name: 'pricebook-health',
    title: 'Pricebook Health',
    description: 'Pricebook margin-discipline sweep: health check + markup/cost drift + vendor part gaps.',
    argsSchema: { businessUnitId: z.coerce.number().optional().describe('Restrict to one BU (optional).') },
    build(args: { businessUnitId?: number }) {
      const bu = args.businessUnitId !== undefined ? ` (businessUnitId=${args.businessUnitId})` : '';
      return userText(
        `Run a pricebook health + margin-discipline sweep${bu}. Call:\n` +
          `1. pricebook_health_check_services — structural health of the services catalog.\n` +
          `2. pricebook_markup_drift — items whose markup has drifted from policy.\n` +
          `3. pricebook_cost_drift — items whose cost has drifted.\n` +
          `4. pricebook_vendor_part_gaps — items missing vendor part links.\n\n` +
          `Summarize the worst offenders by category. DYNAMIC PRICING: a 0/null reference price does NOT mean ` +
          `"unpriced" — QSC uses Pricebook Pro dynamic pricing, so never flag an item as unpriced from a 0 price ` +
          `field; report the price_basis instead.`,
      );
    },
  },

  // ── 4. weekly-tech-review ───────────────────────────────────────────────
  {
    name: 'weekly-tech-review',
    title: 'Weekly Tech Review',
    description: "A technician's week: jobs, drive%, labor burden, dispatch-pro utilization and assigned-vs-sold gap.",
    argsSchema: {
      technicianId: z.coerce.number().optional().describe('One tech (optional; omitted = all techs).'),
      weekStart: z.string().optional().describe('Week start YYYY-MM-DD.'),
      weekEnd: z.string().optional().describe('Week end YYYY-MM-DD.'),
    },
    build(args: { technicianId?: number; weekStart?: string; weekEnd?: string }) {
      const ws = args.weekStart ?? '(Monday of the target week)';
      const we = args.weekEnd ?? '(Sunday of the target week)';
      const techClause = args.technicianId !== undefined ? `technicianId=${args.technicianId}, ` : '';
      return userText(
        `Build a weekly technician review for ${ws}..${we}. Call:\n` +
          `1. tech_scorecard (${techClause}weekStart=${ws}, weekEnd=${we}) — jobs, drive%, labor burden per tech.\n` +
          `2. dispatch_pro_utilization_list and dispatch_pro_ratio_list — utilization + booked/available ratio.\n` +
          `3. assigned_vs_sold_estimate_audit — estimates assigned to the tech that never sold.\n\n` +
          `Produce a per-tech scorecard sorted by jobs descending: tech, jobs, drive%, labor burden, utilization, ` +
          `assigned-vs-sold gap. Flag high drive% (>25%) and large unsold-estimate gaps for a coaching conversation.`,
      );
    },
  },

  // ── 5. drive-time ───────────────────────────────────────────────────────
  {
    name: 'drive-time',
    title: 'Drive Time',
    description: 'Per-tech drive/working-time rollup + windshield cost over a date window.',
    argsSchema: {
      technicianId: z.coerce.number().describe('ST technician ID (required).'),
      startDate: z.string().describe('Window start YYYY-MM-DD.'),
      endDate: z.string().describe('Window end YYYY-MM-DD.'),
    },
    build(args: { technicianId: number; startDate: string; endDate: string }) {
      return userText(
        `Produce a drive-time rollup for technician ${args.technicianId} from ${args.startDate} to ${args.endDate}. Call:\n` +
          `1. tech_drive_time_summary (technicianId=${args.technicianId}, startDate=${args.startDate}, endDate=${args.endDate}).\n\n` +
          `Report the window totals: days worked, jobs/day, drive vs working minutes, drive%, avg first-call drive, ` +
          `and windshield cost. Call out days with unusually high drive%.`,
      );
    },
  },
] as const;

// ── Argument completions (Task 2.6) ─────────────────────────────────────
//
// Two SDK quirks (confirmed empirically against the installed SDK — see
// node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js — no public
// doc covers this) drive the shape below:
//
// 1. completable(schema, complete) decorates a zod schema IN PLACE with a
//    non-configurable symbol property. Calling it twice on the SAME schema
//    object throws ("Cannot redefine property"). registerPrompts() runs on
//    every request (buildServer builds a fresh McpServer per request — see
//    src/index.ts), so every completable-wrapped schema must be a BRAND
//    NEW object each call — never the shared PROMPTS[].argsSchema
//    reference — or the second request throws.
//
// 2. For an OPTIONAL arg (all 3 of ours are), the SDK's two completion
//    code paths disagree about where the decoration must live:
//      - _createRegisteredPrompt's hasCompletable gate (decides whether to
//        enable the `completions` capability AT ALL) unwraps ONE
//        ZodOptional layer and checks the INNER type:
//          `field instanceof ZodOptional ? field._def.innerType : field`
//      - handlePromptCompletion (the actual per-request dispatch) does
//        NOT unwrap — it checks isCompletable() on the field EXACTLY as
//        stored in the shape.
//    completable(base.optional(), fn) satisfies #2 but not #1 (decoration
//    sits on the outer ZodOptional; unwrapping to the inner loses it —
//    the whole server ends up with completions disabled: "Method not
//    found"). completable(base, fn).optional() satisfies #1 but not #2
//    (decoration sits on the inner type; the outer ZodOptional stored in
//    the shape isn't decorated — completion silently returns no values).
//    completableOptional() below double-decorates: the inner AND the
//    optional wrapper around it, so both paths find what they need.
function completableOptional<T extends z.ZodTypeAny>(base: T, complete: CompleteFn, description: string): z.ZodTypeAny {
  // completable()'s declared CompleteCallback<T> is generic on the WRAPPED
  // schema's zod input type (e.g. `unknown` for z.coerce.number(), since
  // coercion accepts any input). At runtime the callback only ever
  // receives the raw wire STRING (MCP's CompleteRequest.argument.value is
  // always a string, regardless of the arg's own coercion) — CompleteFn
  // reflects that real contract, hence the cast at each completable() call.
  const decoratedInner = completable(base, complete as unknown as Parameters<typeof completable<T>>[1]);
  const wrapped = decoratedInner.optional().describe(description);
  return completable(wrapped, complete as unknown as Parameters<typeof completable<typeof wrapped>>[1]);
}

/**
 * completion/complete always hands the callback the raw typed-so-far
 * STRING (per MCP's CompleteRequest.argument.value), regardless of the
 * arg's own coercion/output type — so every completion callback below is
 * typed on `value: string` and returns `string[]`.
 */
type CompleteFn = (value: string, context?: { arguments?: Record<string, string> }) => Promise<string[]>;

const MAX_COMPLETIONS = 20;

/**
 * businessUnitId completion (used by job-cost-margin and pricebook-health):
 * businessUnitId coerces to a number (z.coerce.number()), so the
 * completion returns numeric-id STRINGS (the
 * form the arg itself parses cleanly), filtered by the typed prefix
 * matching either the BU name (case-insensitive) or the id itself. Backed
 * by listBusinessUnits() (KV-cached, D1 `business_units` source) — never
 * throws; an upstream failure just yields no BUs to filter, so this
 * degrades to an empty completion list rather than breaking the prompt.
 */
export function businessUnitIdCompletion(env: Env): CompleteFn {
  return async (value: string) => {
    const bus = await listBusinessUnits(env);
    const v = (value ?? '').trim().toLowerCase();
    const matches = v
      ? bus.filter((b) => b.name.toLowerCase().includes(v) || String(b.id).includes(v))
      : bus;
    return matches.slice(0, MAX_COMPLETIONS).map((b) => String(b.id));
  };
}

export function registerPrompts(server: McpServer, env: Env): void {
  for (const p of PROMPTS) {
    const argsSchema: Record<string, z.ZodTypeAny> = { ...p.argsSchema };

    // Each branch builds a BRAND NEW base schema (z.coerce.number() /
    // z.string()) rather than reusing/mutating p.argsSchema's shared
    // object — required by quirk #1 above. The original arg's `.describe`
    // text is read (not mutated) off the shared schema so prompts/list
    // metadata is unchanged.
    if (p.name === 'job-cost-margin' && argsSchema.businessUnitId) {
      argsSchema.businessUnitId = completableOptional(
        z.coerce.number(),
        businessUnitIdCompletion(env),
        argsSchema.businessUnitId.description ?? '',
      );
    }
    if (p.name === 'pricebook-health' && argsSchema.businessUnitId) {
      argsSchema.businessUnitId = completableOptional(
        z.coerce.number(),
        businessUnitIdCompletion(env),
        argsSchema.businessUnitId.description ?? '',
      );
    }

    server.registerPrompt(
      p.name,
      { title: p.title, description: p.description, argsSchema },
      (args: unknown) => ({ messages: p.build(args) })
    );
  }
}
