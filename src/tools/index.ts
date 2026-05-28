// ============================================================
// tools/index.ts — Tool registry
// T5: CRM (6) + Jobs (8) tools added.
// T12: Inventory (4) + T13: Payroll (4) tools added 2026-05-06.
// ============================================================

import type { z } from 'zod';
import type { Env } from '../env';
// F1 legacy tools
import { st_list_customers } from './st_list_customers';
import { st_get_customer } from './st_get_customer';
import { st_list_jobs } from './st_list_jobs';
import { st_list_appointments } from './st_list_appointments';
import { st_get_pricebook } from './st_get_pricebook';
import { st_patch_service } from './st_patch_service';
import { st_create_service } from './st_create_service';
import { st_patch_material } from './st_patch_material';
import { st_create_material } from './st_create_material';
import { siro_list_mobile_events } from './siro_list_mobile_events';
import { siro_get_recording_summary } from './siro_get_recording_summary';
import { siro_get_engagement } from './siro_get_engagement';
// T5 — CRM
import { find_customer } from './crm/find_customer';
import { get_customer } from './crm/get_customer';
import { get_customer_locations } from './crm/get_customer_locations';
import { list_customer_jobs } from './crm/list_customer_jobs';
import { get_customer_membership } from './crm/get_customer_membership';
import { add_customer_note } from './crm/add_customer_note';
// T6 — Pricebook
import { search_pricebook_services } from './pricebook/search_pricebook_services';
import { get_service_details } from './pricebook/get_service_details';
import { search_materials } from './pricebook/search_materials';
import { get_configurable_equipment_children } from './pricebook/get_configurable_equipment_children';
import { list_service_categories } from './pricebook/list_service_categories';
// Miss Dawn adapter — merged pricebook search across pb_services + pb_materials + pb_equipment
import { search_pricebook_all } from './pricebook/search_pricebook_all';
// C10-C12 — L5 Composites
import { customer_snapshot } from './composites/customer_snapshot';
import { pricebook_health_check_services } from './composites/pricebook_health_check_services';
import { job_closeout_report } from './composites/job_closeout_report';
import { margin_audit } from './composites/margin_audit';
import { membership_outreach_list } from './composites/membership_outreach_list';
import { dispatch_override_audit } from './composites/dispatch_override_audit';
import { call_quality_review } from './composites/call_quality_review';
import { commercial_plumbing_opportunities } from './composites/commercial_plumbing_opportunities';
import { membership_jackpot_leaderboard } from './composites/membership_jackpot_leaderboard';
// T9 — Admin raw gateway
import { st_call } from './st_call';
// T8 — Memberships
import { list_memberships_active } from './memberships/list_memberships_active';
import { list_memberships_expiring } from './memberships/list_memberships_expiring';
import { create_recurring_service } from './memberships/create_recurring_service';
// T8 — Calls & Forms
import { get_call } from './calls_forms/get_call';
import { get_form_submission } from './calls_forms/get_form_submission';
// T8 — Tasks
import { create_task } from './tasks/create_task';
import { list_open_tasks } from './tasks/list_open_tasks';
// T7 — Estimates
import { list_estimates_job } from './estimates/list_estimates_job';
import { get_estimate } from './estimates/get_estimate';
import { dismiss_estimate, sell_estimate, unsell_estimate } from './estimates/update_estimate_status';
// T7 — Dispatch
import { get_capacity } from './dispatch/get_capacity';
import { list_technicians_available } from './dispatch/list_technicians_available';
import { get_technician_shifts } from './dispatch/get_technician_shifts';
import { list_non_job_events } from './dispatch/list_non_job_events';
// v1.2 F.1.a — Dispatch (slot finder)
import { st_get_capacity_slots } from './dispatch/st_get_capacity_slots';
// T7 — Marketing
import { list_campaigns } from './marketing/list_campaigns';
import { get_campaign_performance } from './marketing/get_campaign_performance';
import { create_call_with_campaign } from './marketing/create_call_with_campaign';
// v1.2 F.1.c — Marketing-attribution (kind discriminator)
import { st_post_marketing_attribution } from './marketing/st_post_marketing_attribution';
// v1.2 F.1.b — Reporting (mode discriminator)
import { st_run_report } from './reporting/st_run_report';
// T6 — Invoicing
import { get_invoice } from './invoicing/get_invoice';
import { list_invoices_job } from './invoicing/list_invoices_job';
import { get_invoice_balance } from './invoicing/get_invoice_balance';
import { list_unpaid_invoices } from './invoicing/list_unpaid_invoices';
// T5 — Jobs & Appointments
import { get_job } from './jobs/get_job';
import { list_jobs_today } from './jobs/list_jobs_today';
import { get_job_appointments } from './jobs/get_job_appointments';
import { add_job_note } from './jobs/add_job_note';
import { book_job } from './jobs/book_job';
import { reschedule_appointment } from './jobs/reschedule_appointment';
import { hold_appointment } from './jobs/hold_appointment';
import { assign_technicians } from './jobs/assign_technicians';
// T12 — Inventory (4)
import { inventory_vendors_list } from './inventory/inventory_vendors_list';
import { inventory_warehouses_list } from './inventory/inventory_warehouses_list';
import { inventory_receipts_list } from './inventory/inventory_receipts_list';
import { inventory_transfers_list } from './inventory/inventory_transfers_list';
// T13 — Payroll (5)
import { payroll_payrolls_list } from './payroll/payroll_payrolls_list';
import { payroll_non_job_timesheets_list } from './payroll/payroll_non_job_timesheets_list';
import { payroll_job_timesheets_list } from './payroll/payroll_job_timesheets_list';
import { payroll_location_rates_list } from './payroll/payroll_location_rates_list';
import { payroll_settings_get } from './payroll/payroll_settings_get';
// v1.5 — Opportunities (2)
import { opportunities_list } from './opportunities/opportunities_list';
import { opportunity_get } from './opportunities/opportunity_get';
// v1.5 — Dispatch Pro (3)
import { dispatch_pro_utilization_list } from './dispatch-pro/dispatch_pro_utilization_list';
import { dispatch_pro_ratio_list } from './dispatch-pro/dispatch_pro_ratio_list';
import { dispatch_pro_alerts_list } from './dispatch-pro/dispatch_pro_alerts_list';
// v1.5 — Composites (4)
import { job_cost_actuals } from './composites/job_cost_actuals';
import { tech_drive_time_summary } from './composites/tech_drive_time_summary';
import { assigned_vs_sold_estimate_audit } from './composites/assigned_vs_sold_estimate_audit';
import { open_opportunities_pulitzer_feed } from './composites/open_opportunities_pulitzer_feed';
// v1.5.1 ST-77 — Job hold reasons
import { jobs_hold_reasons_list } from './jobs/jobs_hold_reasons_list';
// v1.6.1 — Job history (audit-log per ticket)
import { get_job_history } from './jobs/get_job_history';
// Dawn — SMS support (v1.6.0)
import { identify_tech_by_phone } from './dawn/identify_tech_by_phone';
import { save_tech_debrief } from './dawn/save_tech_debrief';

export interface ToolContext {
  actor: string;
  correlation: string;
}

/**
 * Optional descriptor declaring which ServiceTitan endpoint a tool maps to.
 * Used by /admin/endpoints to inventory ST coverage and detect gaps.
 *
 * source semantics:
 *   - 'live'     — every call hits live ST via servicetitan-proxy /api/st/read|write
 *   - 'd1'       — D1-first read via read-router (live ST only on miss)
 *   - 'mixed'    — composite/fanout that touches both D1 and live ST
 *   - 'computed' — synthetic/derived (no single canonical ST endpoint)
 */
export interface StEndpointDescriptor {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** Templated path with {placeholders}. Tenant segment optional — st-path-builder injects. */
  path: string;
  source: 'live' | 'd1' | 'mixed' | 'computed';
}

export interface ToolDef<Args = Record<string, unknown>> {
  name: string;
  description: string;
  /** Zod raw shape — record of field name to ZodType. SDK derives JSON schema. */
  zodSchema: z.ZodRawShape;
  /** True for tools that modify state (writes). Informs registry + future role checks. */
  isWrite?: boolean;
  /** True for tools only registered when caller role === 'admin' (F1 placeholder; full gate in F2). */
  adminOnly?: boolean;
  /** Optional ST endpoint descriptor — populated for tools that map to a single ST API call. */
  stEndpoint?: StEndpointDescriptor;
  handler: (env: Env, args: Args, ctx: ToolContext) => Promise<unknown>;
  /**
   * Optional response shaper applied AFTER handler returns and BEFORE
   * audit/serialize. Use it to strip ST noise (`paginationToken`, `_meta`),
   * cap big arrays, or abbreviate verbose keys. See src/response-shape.ts.
   */
  transformResult?: (result: unknown) => unknown;
}

export const TOOLS: readonly ToolDef<any>[] = [
  // F1 legacy
  st_list_customers, st_get_customer, st_list_jobs, st_list_appointments, st_get_pricebook,
  st_patch_service, st_create_service, st_patch_material, st_create_material,
  // T5 CRM
  find_customer, get_customer, get_customer_locations, list_customer_jobs,
  get_customer_membership, add_customer_note,
  // T5 Jobs
  get_job, list_jobs_today, get_job_appointments, get_job_history, add_job_note,
  book_job, reschedule_appointment, hold_appointment, assign_technicians,
  // T6 Pricebook
  search_pricebook_services, get_service_details, search_materials,
  get_configurable_equipment_children, list_service_categories,
  search_pricebook_all,
  // T6 Invoicing
  get_invoice, list_invoices_job, get_invoice_balance, list_unpaid_invoices,
  // T7 Estimates
  list_estimates_job, get_estimate, dismiss_estimate, sell_estimate, unsell_estimate,
  // T7 Dispatch
  get_capacity, list_technicians_available, get_technician_shifts, list_non_job_events,
  st_get_capacity_slots,
  // T7 Marketing
  list_campaigns, get_campaign_performance, create_call_with_campaign,
  // T12 Marketing-attribution (v1.2)
  st_post_marketing_attribution,
  // T11 Reporting (v1.2)
  st_run_report,
  // T8 Memberships
  list_memberships_active, list_memberships_expiring, create_recurring_service,
  // T8 Calls & Forms
  get_call, get_form_submission,
  // T8 Tasks
  create_task, list_open_tasks,
  // T9 Admin gateway (adminOnly — omitted for default role)
  st_call,
  // C10-C12 Composites
  customer_snapshot, pricebook_health_check_services, job_closeout_report,
  margin_audit, membership_outreach_list, dispatch_override_audit,
  call_quality_review, commercial_plumbing_opportunities, membership_jackpot_leaderboard,
  // Siro
  siro_list_mobile_events, siro_get_recording_summary, siro_get_engagement,
  // T12 Inventory
  inventory_vendors_list, inventory_warehouses_list, inventory_receipts_list, inventory_transfers_list,
  // T13 Payroll
  payroll_payrolls_list, payroll_non_job_timesheets_list, payroll_job_timesheets_list, payroll_location_rates_list, payroll_settings_get,
  // v1.5 Opportunities
  opportunities_list, opportunity_get,
  // v1.5 Dispatch Pro (D1 mirrors of native ST reports)
  dispatch_pro_utilization_list, dispatch_pro_ratio_list, dispatch_pro_alerts_list,
  // v1.5 Composites
  job_cost_actuals, tech_drive_time_summary, assigned_vs_sold_estimate_audit, open_opportunities_pulitzer_feed,
  // v1.5.1 ST-77
  jobs_hold_reasons_list,
  // Dawn — SMS support (v1.6.0)
  identify_tech_by_phone,
  save_tech_debrief,
] as const;

export function findTool(name: string): ToolDef<any> | undefined {
  return TOOLS.find((t) => t.name === name);
}

/**
 * Filter tools by caller role.
 *   - 'lockdown' (v1.5.2): read-only mode. Strips every isWrite=true tool and
 *     adminOnly tools. Composites stay (they're reads with extra D1 work).
 *   - 'admin':   full catalog including st_call escape hatch.
 *   - 'default': everything except adminOnly tools.
 */
export function toolsForRole(role: 'default' | 'admin' | 'lockdown'): readonly ToolDef<any>[] {
  if (role === 'lockdown') return TOOLS.filter((t) => !t.isWrite && !t.adminOnly);
  if (role === 'admin') return TOOLS;
  return TOOLS.filter((t) => !t.adminOnly);
}
