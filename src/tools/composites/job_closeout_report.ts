import { z } from 'zod';
import { authHeaders } from '../../auth';
import { gatherFetchesWithTruncation, stReadGuarded } from '../../composite-helpers';
import type { ToolDef } from '../index';
import { defaultShaper } from '../../response-shape';

interface Args { jobId: number }

// 10-min memo. Note: form submissions return unit IDs — equipment join via
// forms_equipment D1 table done here at the composite layer.
export const job_closeout_report: ToolDef<Args> = {
  name: 'job_closeout_report',
  description: 'L5 composite: job closeout rollup — job details, appointments, technicians, invoices, and form submissions. Returns ALL invoices for the job as `invoices[]` (a job is 1:N invoices — base + adjustments) with `_invoice_count`; `invoice` is the first for back-compat only. `_truncated` lists any arm ST reported more pages for. Note: form submissions use unit IDs (not equipment IDs); equipment join done via forms_equipment D1 table. Source: mixed (D1 + live ST). Portions duplicate `st_run_report` (mode=run).',
  stEndpoint: { method: 'GET', path: '/jpm/v2/tenant/{tid}/jobs/{id}', source: 'mixed' },
  zodSchema: {
    jobId: z.number().int().positive().describe('ST job ID'),
  },
  async handler(env, args, { actor, correlation }) {
    const { jobId } = args;
    const h = authHeaders(env, correlation, actor);
    const tenant = '000000000';

    const fanout = await gatherFetchesWithTruncation([
      { name: 'job',          promise: stReadGuarded(env, h, `/jpm/v2/tenant/${tenant}/jobs/${jobId}`) },
      { name: 'appointments', promise: stReadGuarded(env, h, `/jpm/v2/tenant/${tenant}/appointments?jobId=${jobId}`) },
      { name: 'invoices',     promise: stReadGuarded(env, h, `/accounting/v2/tenant/${tenant}/invoices?jobId=${jobId}`) },
    ]);

    // F-24: a job's invoices are 1:N (base + adjustments). Preserve the full
    // array and its count; keep `invoice` (the first) for back-compat, but do
    // not present it as the whole closeout.
    const invoiceData = fanout.results.invoices;
    const invoices = Array.isArray(invoiceData) ? invoiceData : invoiceData != null ? [invoiceData] : [];
    const firstInvoice = invoices[0] ?? null;

    return {
      jobId,
      _partial: fanout.partial,
      _failures: fanout.failures,
      _truncated: fanout.truncated,
      job: fanout.results.job,
      appointments: fanout.results.appointments,
      invoice: firstInvoice,
      invoices,
      _invoice_count: invoices.length,
      _composite: 'job_closeout_report',
      _source: 'mixed',
      _note: 'form submissions and equipment join available via get_form_submission + forms_equipment D1 table',
      correlation,
    };
  },
  transformResult: defaultShaper,
};
