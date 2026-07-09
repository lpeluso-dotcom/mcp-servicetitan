// ============================================================
// read_shaper_sweep.test.ts
//
// Table-driven wiring check for the 42-tool defaultShaper sweep
// (see commit "chore(tools): apply defaultShaper to 42 read tools
// for response consistency").
//
// This proves the WIRING only: each tool's transformResult is
// defaultShaper and defaultShaper does what it says on a raw
// passthrough-shaped payload. For tools that hand-project their
// return fields (slim()/trim() helpers) or read from D1, none of
// the 5 stripped names (paginationToken/requestId/eTag/_links/_meta)
// can appear in production output, so the strip is a harmless no-op
// there — this test does not claim otherwise. It only guarantees
// that if a raw ST payload ever *did* leak one of those fields
// through a passthrough tool, the shaper would catch it.
// ============================================================
import { describe, it, expect } from 'vitest';
import type { ToolDef } from '../index';

import { get_call } from '../calls_forms/get_call';
import { get_form_submission } from '../calls_forms/get_form_submission';
import { find_customer } from '../crm/find_customer';
import { get_customer } from '../crm/get_customer';
import { get_customer_locations } from '../crm/get_customer_locations';
import { get_customer_membership } from '../crm/get_customer_membership';
import { list_customer_jobs } from '../crm/list_customer_jobs';
import { identify_tech_by_phone } from '../dawn/identify_tech_by_phone';
import { get_capacity } from '../dispatch/get_capacity';
import { get_technician_shifts } from '../dispatch/get_technician_shifts';
import { list_non_job_events } from '../dispatch/list_non_job_events';
import { list_technicians_available } from '../dispatch/list_technicians_available';
import { st_get_capacity_slots } from '../dispatch/st_get_capacity_slots';
import { get_estimate } from '../estimates/get_estimate';
import { list_estimates_job } from '../estimates/list_estimates_job';
import { get_invoice } from '../invoicing/get_invoice';
import { get_invoice_balance } from '../invoicing/get_invoice_balance';
import { list_invoices_job } from '../invoicing/list_invoices_job';
import { list_unpaid_invoices } from '../invoicing/list_unpaid_invoices';
import { get_job } from '../jobs/get_job';
import { get_job_appointments } from '../jobs/get_job_appointments';
import { get_job_history } from '../jobs/get_job_history';
import { list_jobs_today } from '../jobs/list_jobs_today';
import { get_campaign_performance } from '../marketing/get_campaign_performance';
import { list_campaigns } from '../marketing/list_campaigns';
import { list_memberships_active } from '../memberships/list_memberships_active';
import { list_memberships_expiring } from '../memberships/list_memberships_expiring';
import { get_configurable_equipment_children } from '../pricebook/get_configurable_equipment_children';
import { get_service_details } from '../pricebook/get_service_details';
import { list_service_categories } from '../pricebook/list_service_categories';
import { search_materials } from '../pricebook/search_materials';
import { search_pricebook_all } from '../pricebook/search_pricebook_all';
import { search_pricebook_semantic } from '../pricebook/search_pricebook_semantic';
import { search_pricebook_services } from '../pricebook/search_pricebook_services';
import { st_run_report } from '../reporting/st_run_report';
import { get_estimate_template } from '../sales/get_estimate_template';
import { list_estimate_templates } from '../sales/list_estimate_templates';
import { st_get_customer } from '../st_get_customer';
import { st_get_pricebook } from '../st_get_pricebook';
import { st_list_appointments } from '../st_list_appointments';
import { st_list_jobs } from '../st_list_jobs';
import { list_open_tasks } from '../tasks/list_open_tasks';

const SWEPT_TOOLS: ToolDef<any>[] = [
  get_call,
  get_form_submission,
  find_customer,
  get_customer,
  get_customer_locations,
  get_customer_membership,
  list_customer_jobs,
  identify_tech_by_phone,
  get_capacity,
  get_technician_shifts,
  list_non_job_events,
  list_technicians_available,
  st_get_capacity_slots,
  get_estimate,
  list_estimates_job,
  get_invoice,
  get_invoice_balance,
  list_invoices_job,
  list_unpaid_invoices,
  get_job,
  get_job_appointments,
  get_job_history,
  list_jobs_today,
  get_campaign_performance,
  list_campaigns,
  list_memberships_active,
  list_memberships_expiring,
  get_configurable_equipment_children,
  get_service_details,
  list_service_categories,
  search_materials,
  search_pricebook_all,
  search_pricebook_semantic,
  search_pricebook_services,
  st_run_report,
  get_estimate_template,
  list_estimate_templates,
  st_get_customer,
  st_get_pricebook,
  st_list_appointments,
  st_list_jobs,
  list_open_tasks,
];

function samplePayload() {
  return {
    data: [
      {
        id: 1,
        name: 'x',
        _links: { a: 1 },
        eTag: 'e',
        paginationToken: 't',
        requestId: 'r',
        _meta: {},
      },
    ],
    _source: 'live',
  };
}

describe('read_shaper_sweep — 42-tool defaultShaper wiring', () => {
  it('swept exactly 42 tools', () => {
    expect(SWEPT_TOOLS).toHaveLength(42);
  });

  it.each(SWEPT_TOOLS.map((t) => [t.name, t] as const))(
    '%s carries transformResult: defaultShaper and it strips ST noise fields',
    (_name, tool) => {
      expect(typeof tool.transformResult).toBe('function');

      const shaped = tool.transformResult!(samplePayload()) as {
        data: Array<Record<string, unknown>>;
        _source: string;
      };

      const row = shaped.data[0];
      expect(row).not.toHaveProperty('_links');
      expect(row).not.toHaveProperty('eTag');
      expect(row).not.toHaveProperty('paginationToken');
      expect(row).not.toHaveProperty('requestId');
      expect(row).not.toHaveProperty('_meta');
      expect(row.id).toBe(1);
      expect(row.name).toBe('x');
      expect(shaped._source).toBe('live');
    },
  );
});
