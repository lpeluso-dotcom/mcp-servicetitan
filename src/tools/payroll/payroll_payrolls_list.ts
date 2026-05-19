import { z } from 'zod';
import { defaultShaper } from '../../response-shape';
import { readST } from '../../st';
import type { ToolDef } from '../index';

interface Args {
  employeeId?: number;
  payrollPeriodId?: number;
  status?: 'Pending' | 'Approved' | 'Posted';
  page?: number;
  pageSize?: number;
}

interface RawPayroll {
  id: number;
  employeeId?: number;
  payrollPeriodId?: number;
  status?: string;
  grossPay?: number;
  netPay?: number;
  periodStart?: string;
  periodEnd?: string;
}

interface SlimPayroll {
  id: number;
  employee_id: number | null;
  payroll_period_id: number | null;
  status: string;
  gross_pay: number;
  net_pay: number;
  period_start: string | null;
  period_end: string | null;
}

function slim(p: RawPayroll): SlimPayroll {
  return {
    id: p.id,
    employee_id: p.employeeId ?? null,
    payroll_period_id: p.payrollPeriodId ?? null,
    status: p.status ?? '',
    gross_pay: p.grossPay ?? 0,
    net_pay: p.netPay ?? 0,
    period_start: p.periodStart ?? null,
    period_end: p.periodEnd ?? null,
  };
}

// Back-office tool (no voice consumer); pageSize tuned for PO/receipt
// enumeration, not voice-tier readback. Compare find_customer's tighter caps.
const DEFAULT_PAGESIZE = 25;
const MAX_PAGESIZE = 100;

export const payroll_payrolls_list: ToolDef<Args> = {
  name: 'payroll_payrolls_list',
  description:
    'List ServiceTitan payroll records (per-employee payroll runs). Filter by employee, payroll period, or status. Source: live ST.',
  zodSchema: {
    employeeId: z.number().int().positive().optional().describe('Filter by employee ID'),
    payrollPeriodId: z.number().int().positive().optional().describe('Filter by payroll period ID'),
    status: z
      .enum(['Pending', 'Approved', 'Posted'])
      .optional()
      .describe('Filter by payroll status'),
    page: z.number().int().positive().optional().describe('Page number, default 1'),
    pageSize: z
      .number()
      .int()
      .positive()
      .max(MAX_PAGESIZE)
      .optional()
      .describe(`Page size, default ${DEFAULT_PAGESIZE}, max ${MAX_PAGESIZE}`),
  },
  stEndpoint: { method: 'GET', path: '/payroll/v2/tenant/{tid}/payrolls', source: 'live' },
  async handler(env, args, { actor, correlation }) {
    const page = args.page ?? 1;
    const pageSize = Math.min(args.pageSize ?? DEFAULT_PAGESIZE, MAX_PAGESIZE);
    const query: Record<string, unknown> = {
      employeeId: args.employeeId,
      payrollPeriodId: args.payrollPeriodId,
      status: args.status,
      page,
      pageSize,
    };

    const data = await readST<{ data?: RawPayroll[]; hasMore?: boolean }>(
      env,
      { actor, correlation },
      `/payroll/v2/tenant/${env.ST_TENANT_ID}/payrolls`,
      query,
    );
    return {
      count: (data.data ?? []).length,
      payrolls: (data.data ?? []).map(slim),
      has_more: !!data.hasMore,
      _source: 'live',
    };
  },
  transformResult: defaultShaper,
};
