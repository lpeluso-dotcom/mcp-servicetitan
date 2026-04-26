import { z } from 'zod';
import { authHeaders } from '../../auth';
import { gatherFetches } from '../../composite-helpers';
import type { ToolDef } from '../index';

interface Args { jobId: number }

// 10-min memo. Note: form submissions return unit IDs — equipment join via
// forms_equipment D1 table done here at the composite layer.
export const job_closeout_report: ToolDef<Args> = {
  name: 'job_closeout_report',
  description: 'L5 composite: full job closeout report — job details, appointments, technicians, invoice, and form submissions. Note: form submissions use unit IDs (not equipment IDs); equipment join done via forms_equipment D1 table. Source: mixed (D1 + live ST).',
  zodSchema: {
    jobId: z.number().int().positive().describe('ST job ID'),
  },
  async handler(env, args, { actor, correlation }) {
    const { jobId } = args;
    const base = `https://taylor-ai/api/st/read`;
    const h = authHeaders(env, correlation, actor);
    const tenant = '431848990';

    const fanout = await gatherFetches([
      { name: 'job',          promise: env.TAYLOR_AI.fetch(`${base}?endpoint=${encodeURIComponent(`/jpm/v2/tenant/${tenant}/jobs/${jobId}`)}`, { headers: h }) },
      { name: 'appointments', promise: env.TAYLOR_AI.fetch(`${base}?endpoint=${encodeURIComponent(`/jpm/v2/tenant/${tenant}/appointments?jobId=${jobId}`)}`, { headers: h }) },
      { name: 'invoices',     promise: env.TAYLOR_AI.fetch(`${base}?endpoint=${encodeURIComponent(`/accounting/v2/tenant/${tenant}/invoices?jobId=${jobId}`)}`, { headers: h }) },
    ]);

    const invoiceData = fanout.results.invoices;
    const firstInvoice = Array.isArray(invoiceData) ? invoiceData[0] : invoiceData;

    return {
      jobId,
      job: fanout.results.job,
      appointments: fanout.results.appointments,
      invoice: firstInvoice ?? null,
      _composite: 'job_closeout_report',
      _source: 'mixed',
      _partial: fanout.partial,
      _failures: fanout.failures,
      _note: 'form submissions and equipment join available via get_form_submission + forms_equipment D1 table',
      correlation,
    };
  },
};
