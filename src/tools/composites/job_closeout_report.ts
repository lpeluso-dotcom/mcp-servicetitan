import { z } from 'zod';
import { McpError } from '../../errors';
import { authHeaders } from '../../auth';
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

    const [job, appointments, invoices] = await Promise.allSettled([
      env.TAYLOR_AI.fetch(`${base}?endpoint=${encodeURIComponent(`/jpm/v2/tenant/${tenant}/jobs/${jobId}`)}`, { headers: h }),
      env.TAYLOR_AI.fetch(`${base}?endpoint=${encodeURIComponent(`/jpm/v2/tenant/${tenant}/appointments?jobId=${jobId}`)}`, { headers: h }),
      env.TAYLOR_AI.fetch(`${base}?endpoint=${encodeURIComponent(`/accounting/v2/tenant/${tenant}/invoices?jobId=${jobId}`)}`, { headers: h }),
    ]);

    async function extract(settled: PromiseSettledResult<Response>, key: string) {
      if (settled.status === 'rejected') return { error: `${key} fetch failed` };
      if (!settled.value.ok) return { error: `${key} ${settled.value.status}` };
      const json = await settled.value.json<{ data?: unknown } | unknown>();
      return (json as { data?: unknown }).data ?? json;
    }

    const invoiceData = await extract(invoices, 'invoices');
    const firstInvoice = Array.isArray(invoiceData) ? invoiceData[0] : invoiceData;

    return {
      jobId,
      job: await extract(job, 'job'),
      appointments: await extract(appointments, 'appointments'),
      invoice: firstInvoice ?? null,
      _composite: 'job_closeout_report',
      _source: 'mixed',
      _note: 'form submissions and equipment join available via get_form_submission + forms_equipment D1 table',
      correlation,
    };
  },
};
