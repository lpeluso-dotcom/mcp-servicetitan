import { z } from 'zod';
import { readST } from '../../st';
import type { ToolDef } from '../index';

interface Args { invoiceId: number }

// T9 catalog correction: renamed from get_payment_status.
// /payments/{id} returns a payment object, not a status.
// Invoice balance lives on the invoice itself (invoice.balance field).
export const get_invoice_balance: ToolDef<Args> = {
  name: 'get_invoice_balance',
  description: 'Get the outstanding balance for an invoice. Returns balance, total, and payment summary from the invoice record. Source: D1 (invoices nightly-synced). Note: renamed from get_payment_status — /payments/{id} returns a payment object; balance lives on the invoice.',
  zodSchema: {
    invoiceId: z.number().int().positive().describe('ST invoice ID'),
  },
  stEndpoint: { method: 'GET', path: '/accounting/v2/tenant/{tid}/invoices/{invoiceId}', source: 'live' },
  async handler(env, args, { actor, correlation }) {
    const invoice = await readST<Record<string, unknown>>(
      env,
      { actor, correlation },
      `/accounting/v2/tenant/000000000/invoices/${args.invoiceId}`,
    );
    return {
      balance: {
        invoiceId: args.invoiceId,
        total: invoice.total,
        balance: invoice.balance,
        payments: invoice.payments,
      },
      _source: 'live',
    };
  },
};
