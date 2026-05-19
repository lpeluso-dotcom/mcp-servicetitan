import { describe, it, expect, vi } from 'vitest';
import { st_list_appointments } from '../st_list_appointments';
import { st_list_jobs } from '../st_list_jobs';
import { get_job } from '../jobs/get_job';
import { appointment_get } from '../jobs/appointment_get';
import { job_equipment_list } from '../jobs/job_equipment_list';
import { jobs_hold_reasons_list } from '../jobs/jobs_hold_reasons_list';
import { intacct_business_unit_mappings_get } from '../settings/intacct_business_unit_mappings_get';
import { service_agreements_list } from '../service-agreements/service_agreements_list';
import { service_agreement_get } from '../service-agreements/service_agreement_get';
import { TOOLS, TOOL_PACKS, toolsForRoleAndPack } from '../index';
import { expectForwardedQuery, endpointFromProxyUrl } from './filter-forwarding';

const CTX = { actor: 'test', correlation: 'c1' };

function envWith(body: object) {
  const fetcher = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
  return {
    ST_TENANT_ID: '431848990',
    ST_PROXY: { fetch: fetcher },
    MCP_SYNC_KEY: 'k',
  } as any;
}

describe('ST-77 API alignment', () => {
  it('forwards the appointment active filter added in ST-77', async () => {
    const env = envWith({ data: [{ id: 1, active: false }] });
    await st_list_appointments.handler(env, { active: false, page: 2 }, CTX);
    const [url] = env.ST_PROXY.fetch.mock.calls[0];
    expectForwardedQuery(url, 'active', 'false');
    expectForwardedQuery(url, 'page', '2');
  });

  it('keeps isAutoDispatched fields on live job list and get responses', async () => {
    const env = envWith({ data: [{ id: 10, isAutoDispatched: true, summaryOfWork: 'Repaired unit' }] });
    const list: any = await st_list_jobs.handler(env, { equipmentIds: [111, 222] }, CTX);
    expect(list.data[0].isAutoDispatched).toBe(true);
    expect(list.data[0].summaryOfWork).toBe('Repaired unit');
    const [url] = env.ST_PROXY.fetch.mock.calls[0];
    expectForwardedQuery(url, 'equipmentIds', '111,222');

    const getEnv = envWith({ id: 10, isAutoDispatched: true, summaryOfWork: 'Repaired unit' });
    const got: any = await get_job.handler(getEnv, { jobId: 10 }, CTX);
    expect(got.job.isAutoDispatched).toBe(true);
    expect(got.job.summaryOfWork).toBe('Repaired unit');
  });

  it('adds appointment get and preserves appointmentSummaries', async () => {
    const env = envWith({ id: 44, active: true, appointmentSummaries: [{ id: 1, text: 'Done' }] });
    const out: any = await appointment_get.handler(env, { appointmentId: 44 }, CTX);
    expect(out.appointment.appointmentSummaries[0].text).toBe('Done');
    const [url] = env.ST_PROXY.fetch.mock.calls[0];
    expect(endpointFromProxyUrl(url)).toContain('/appointments/44');
  });

  it('adds the ST-77.1 job hold reasons endpoint', async () => {
    const env = envWith({ data: [{ id: 5, name: 'Parts hold' }], hasMore: false });
    const out: any = await jobs_hold_reasons_list.handler(env, { pageSize: 25 }, CTX);
    expect(out.reasons[0].name).toBe('Parts hold');
    const [url] = env.ST_PROXY.fetch.mock.calls[0];
    expect(endpointFromProxyUrl(url)).toContain('/jobs/hold-reasons');
    expectForwardedQuery(url, 'pageSize', '25');
  });

  it('adds the ST-77.1 Intacct BU mapping endpoint', async () => {
    const env = envWith({ data: [{ businessUnitId: 7, dimension: 'HVAC' }] });
    const out: any = await intacct_business_unit_mappings_get.handler(env, {}, CTX);
    expect(out.mappings[0].businessUnitId).toBe(7);
    const [url] = env.ST_PROXY.fetch.mock.calls[0];
    expect(endpointFromProxyUrl(url)).toContain('/business-units/intacct');
  });

  it('adds ST-77.1 job equipment read coverage', async () => {
    const env = envWith({ data: [{ id: 88, name: 'RTU-1' }], hasMore: false });
    const out: any = await job_equipment_list.handler(env, { jobId: 10, pageSize: 10 }, CTX);
    expect(out.equipment[0].name).toBe('RTU-1');
    const [url] = env.ST_PROXY.fetch.mock.calls[0];
    expect(endpointFromProxyUrl(url)).toContain('/jobs/10/equipment');
    expectForwardedQuery(url, 'pageSize', '10');
  });

  it('adds ST-77 service agreement readers and preserves customFields', async () => {
    const listEnv = envWith({ data: [{ id: 2, billingScheduleType: 'Custom', customFields: [{ name: 'Segment' }] }] });
    const list: any = await service_agreements_list.handler(listEnv, {}, CTX);
    expect(list.service_agreements[0].billingScheduleType).toBe('Custom');
    expect(list.service_agreements[0].customFields[0].name).toBe('Segment');

    const getEnv = envWith({ id: 2, customFields: [{ name: 'Segment' }] });
    const got: any = await service_agreement_get.handler(getEnv, { serviceAgreementId: 2 }, CTX);
    expect(got.service_agreement.customFields[0].name).toBe('Segment');
    const [url] = getEnv.ST_PROXY.fetch.mock.calls[0];
    expect(endpointFromProxyUrl(url)).toContain('/service-agreements/2');
  });
});

describe('endpoint coverage and tool packs', () => {
  it('has endpoint metadata or an explicit undeclared reason for every tool', () => {
    const missing = TOOLS
      .filter((t) => !t.stEndpoint && !t.undeclaredReason)
      .map((t) => t.name)
      .sort();
    expect(missing).toEqual([]);
  });

  it('exposes focused workflow packs without leaking admin tools to default role', () => {
    expect(TOOL_PACKS.payroll).toContain('payroll_job_timesheets_list');
    expect(TOOL_PACKS.dispatch).toContain('dispatch_pro_alerts_list');
    expect(TOOL_PACKS.accounting).toContain('intacct_business_unit_mappings_get');
    expect(TOOL_PACKS.core).toContain('job_equipment_list');
    expect(TOOL_PACKS.sales).toContain('service_agreements_list');
    expect(toolsForRoleAndPack('default', 'admin').map((t) => t.name)).toEqual([]);
    expect(toolsForRoleAndPack('admin', 'admin').map((t) => t.name)).toEqual(['st_call']);
  });
});
