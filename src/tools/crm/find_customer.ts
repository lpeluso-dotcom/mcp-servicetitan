import { z } from 'zod';
import { McpError } from '../../errors';
import { cacheGet } from '../../cache';
import { readST } from '../../st';
import type { ToolDef } from '../index';

interface Args { name?: string; phone?: string; email?: string; page?: number; pageSize?: number }

interface RawCustomer {
  id: number;
  active?: boolean;
  name?: string;
  type?: string;
  address?: { street?: string; unit?: string | null; city?: string; state?: string; zip?: string };
  balance?: number;
  doNotService?: boolean;
  doNotMail?: boolean;
}

interface SlimCustomer {
  id: number;
  name: string;
  type: string;
  address: string;
  balance: number;
  do_not_service: boolean;
}

function slim(c: RawCustomer): SlimCustomer {
  const a = c.address || {};
  const parts = [a.street, a.unit, a.city, a.state, a.zip].filter(Boolean);
  return {
    id: c.id,
    name: c.name ?? '',
    type: c.type ?? '',
    address: parts.join(', ') || '',
    balance: c.balance ?? 0,
    do_not_service: !!c.doNotService,
  };
}

// Voice tier: cap default pageSize hard so a generic phone-only call (which
// can return ST's full default page of 50 customers, ~28KB JSON) doesn't blow
// up the LLM's context and cause dead air. Caller can opt into more via
// pageSize, but the slim() shape keeps each row to ~6 small fields.
const VOICE_DEFAULT_PAGESIZE = 10;
const VOICE_MAX_PAGESIZE = 50;

export const find_customer: ToolDef<Args> = {
  name: 'find_customer',
  description: 'Search ST customers by name, phone, or email. Returns up to 10 slim records (id, name, type, address string, balance, do_not_service) by default — pass pageSize up to 50 for more. Source: live ST.',
  zodSchema: {
    name: z.string().optional().describe('Customer name (partial match)'),
    phone: z.string().optional().describe('Phone number'),
    email: z.string().optional().describe('Email address'),
    page: z.number().int().positive().optional().describe('Page number, default 1'),
    pageSize: z.number().int().positive().max(VOICE_MAX_PAGESIZE).optional().describe(`Page size, default ${VOICE_DEFAULT_PAGESIZE}, max ${VOICE_MAX_PAGESIZE}`),
  },
  stEndpoint: { method: 'GET', path: '/crm/v2/tenant/{tid}/customers', source: 'live' },
  async handler(env, args, { actor, correlation }) {
    if (!args.name && !args.phone && !args.email) {
      throw new McpError('validation_error', 'find_customer requires at least one of: name, phone, email', { correlation });
    }
    const page = args.page ?? 1;
    const pageSize = Math.min(args.pageSize ?? VOICE_DEFAULT_PAGESIZE, VOICE_MAX_PAGESIZE);
    const cacheKey = JSON.stringify({ name: args.name ?? '', phone: args.phone ?? '', email: args.email ?? '', page, pageSize });

    return cacheGet(env, 'servicetitan:find_customer', cacheKey, 30, async () => {
      const query: Record<string, unknown> = { page, pageSize };
      if (args.name) query.name = args.name;
      if (args.phone) query.phoneNumber = args.phone;
      if (args.email) query.email = args.email;

      const data = await readST<{ data?: RawCustomer[] }>(
        env,
        { actor, correlation },
        `/crm/v2/tenant/000000000/customers`,
        query,
      );
      const rows = (data.data ?? []).map(slim);
      return { count: rows.length, customers: rows, _source: 'live' };
    });
  },
};
