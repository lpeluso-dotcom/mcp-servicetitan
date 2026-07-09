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
  // ── 1. morning-dispatch-brief ──────────────────────────────────────────
  {
    name: 'morning-dispatch-brief',
    title: 'Morning Dispatch Brief',
    description:
      'Pull today\'s job load, capacity, and Dispatch Pro alerts, and produce a capacity/risk brief for the dispatch team.',
    argsSchema: {
      date: z.string().optional().describe('ISO date to brief on (default: "today")'),
    },
    build(args: { date?: string }) {
      const date = args.date ?? 'today';
      return userText(
        `Produce a morning dispatch brief for ${date}. Call these tools in order:\n` +
          `1. list_jobs_today (date=${date}) — get the full job load for the day.\n` +
          `2. get_capacity — check dispatch capacity for the business units that have jobs scheduled on ${date}.\n` +
          `3. dispatch_pro_alerts_list — pull any open Dispatch Pro alerts for ${date}.\n\n` +
          `From these three results, produce a capacity/risk brief with:\n` +
          `- Jobs count by business unit for ${date}.\n` +
          `- Capacity gaps: any BU/skill combination where booked jobs exceed available capacity.\n` +
          `- Any open dispatch-pro alerts, listed with severity and the job/technician they affect.\n` +
          `Keep it scannable — dispatch needs to read this in under a minute before the day starts.`
      );
    },
  },

  // ── 2. job-closeout-review ─────────────────────────────────────────────
  {
    name: 'job-closeout-review',
    title: 'Job Closeout Review',
    description:
      'Review a completed job for margin and completeness — revenue, labor burden, GP%, and any missing closeout items.',
    argsSchema: {
      jobId: z.coerce.number().describe('The job ID to review (required)'),
    },
    build(args: { jobId: number }) {
      const jobId = args.jobId;
      return userText(
        `Produce a margin + completeness review for job ${jobId}. Call these tools:\n` +
          `1. job_closeout_report (jobId=${jobId}) — revenue, invoiced amount, and closeout status for job ${jobId}.\n` +
          `2. payroll_job_timesheets_list (jobId=${jobId}) — technician time logged against job ${jobId}, to compute labor burden.\n` +
          `3. job_cost_actuals (jobId=${jobId}) — actual material/labor/equipment cost lines for job ${jobId}.\n\n` +
          `From these three results, produce a margin + completeness review for job ${jobId} with:\n` +
          `- Revenue (invoiced total) for job ${jobId}.\n` +
          `- Labor burden: technician hours × loaded labor rate from the timesheets.\n` +
          `- GP% = (revenue - total actual cost) / revenue, computed from job_cost_actuals.\n` +
          `- Missing items: anything job_closeout_report flags as incomplete (unclosed appointment, missing invoice, unsigned form, etc.) for job ${jobId}.`
      );
    },
  },

  // ── 3. ar-chase ─────────────────────────────────────────────────────────
  {
    name: 'ar-chase',
    title: 'AR Chase',
    description:
      'Build a prioritized collections list from unpaid invoices, with customer contact context for the top balances.',
    argsSchema: {
      businessUnitId: z.coerce.number().optional().describe('Restrict to this business unit ID (optional)'),
    },
    build(args: { businessUnitId?: number }) {
      const buId = args.businessUnitId;
      const buClause = buId !== undefined ? ` (businessUnitId=${buId})` : ' (all business units)';
      return userText(
        `Build a prioritized collections list. Call these tools:\n` +
          `1. list_unpaid_invoices${buClause} — get all unpaid invoices${buId !== undefined ? ` for business unit ${buId}` : ''}.\n` +
          `2. For the top unpaid invoices by balance (largest first, and oldest-aged first as a tiebreaker), call get_customer for` +
          ` each invoice's customer to get contact info (phone/email) and account context.\n\n` +
          `From these results, produce a prioritized collections list, sorted by balance descending, with one row per invoice:\n` +
          `- Customer name\n` +
          `- Outstanding balance\n` +
          `- Invoice age (days since invoice date)\n` +
          `- Best contact (phone/email from get_customer)\n` +
          `Flag anything over 60 days as high priority.`
      );
    },
  },

  // ── 4. quote-follow-up ──────────────────────────────────────────────────
  {
    name: 'quote-follow-up',
    title: 'Quote Follow-Up',
    description:
      'Surface stale open estimates and assigned-vs-sold gaps into a follow-up queue for sales/CSR to work.',
    argsSchema: {
      daysBack: z.coerce.number().optional().describe('How many days back to look for stale estimates (default: 14)'),
    },
    build(args: { daysBack?: number }) {
      const daysBack = args.daysBack ?? 14;
      return userText(
        `Build a stale-estimate follow-up queue covering the last ${daysBack} days. Call these tools:\n` +
          `1. open_opportunities_pulitzer_feed — get open sales opportunities/estimates from the last ${daysBack} days.\n` +
          `2. assigned_vs_sold_estimate_audit — get estimates assigned to a technician that were never sold, over the same ${daysBack}-day window.\n\n` +
          `From these two results, produce a stale-estimate follow-up queue, sorted oldest-first, with one row per estimate:\n` +
          `- Estimate ID/name\n` +
          `- Customer\n` +
          `- Assigned technician\n` +
          `- Age (days since presented, within the ${daysBack}-day window)\n` +
          `- Dollar value\n` +
          `Flag any estimate over ${daysBack} days old with no sold status as needing an immediate follow-up call.`
      );
    },
  },

  // ── 5. membership-outreach ──────────────────────────────────────────────
  {
    name: 'membership-outreach',
    title: 'Membership Outreach',
    description:
      'Build a call sheet of memberships expiring in the given window, with plan and contact detail for renewal outreach.',
    argsSchema: {
      window: z.string().optional().describe('Expiration window, e.g. "30d" (default: "30d")'),
    },
    build(args: { window?: string }) {
      const window = args.window ?? '30d';
      return userText(
        `Build an expiring-membership call sheet for the next ${window}. Call these tools:\n` +
          `1. list_memberships_expiring (window=${window}) — get memberships expiring within ${window}.\n` +
          `2. get_customer_membership — for each expiring membership, get full plan and customer contact detail.\n\n` +
          `From these results, produce an expiring-membership call sheet for the ${window} window, with one row per member:\n` +
          `- Member/customer name\n` +
          `- Plan tier\n` +
          `- Expiry date\n` +
          `- Best contact (phone/email)\n` +
          `Sort soonest-to-expire first so the Membership Coordinator works the most urgent renewals first.`
      );
    },
  },
] as const;

export function registerPrompts(server: McpServer): void {
  for (const p of PROMPTS) {
    server.registerPrompt(
      p.name,
      { title: p.title, description: p.description, argsSchema: p.argsSchema },
      (args: unknown) => ({ messages: p.build(args) })
    );
  }
}
