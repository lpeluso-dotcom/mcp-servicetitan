import { z } from 'zod';
import { McpError } from '../../errors';
import { cacheGet } from '../../cache';
import { readST, rejectUnsupportedSTFilters } from '../../st';
import type { ToolDef } from '../index';
import { defaultShaper } from '../../response-shape';

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
  description: 'Search ST customers by name or phone. Returns up to 10 slim records (id, name, type, address string, balance, do_not_service) by default — pass pageSize up to 50 for more. Source: live ST. NOTE: ServiceTitan has no email filter on this endpoint; passing `email` is rejected rather than silently ignored (QUA-1054).',
  zodSchema: {
    name: z.string().optional().describe('Customer name (partial match)'),
    phone: z.string().optional().describe('Phone number. Digits or formatted ("8432609814", "(843) 260-9814", "843-260-9814") — ST normalizes all three.'),
    email: z
      .string()
      .optional()
      .describe('NOT SUPPORTED by ServiceTitan on this endpoint — passing it returns a validation error. Look the customer up by phone or name instead.'),
    page: z.number().int().positive().optional().describe('Page number, default 1'),
    pageSize: z.number().int().positive().max(VOICE_MAX_PAGESIZE).optional().describe(`Page size, default ${VOICE_DEFAULT_PAGESIZE}, max ${VOICE_MAX_PAGESIZE}`),
  },
  // Envelope precise (count/customers/_source always present). `customers` is
  // our own slim() projection (fixed keys), but still typed permissively —
  // record(unknown) — so a future field tweak to slim() never fails runtime
  // structuredContent validation.
  outputSchema: {
    count: z.number(),
    customers: z.array(z.record(z.string(), z.unknown())),
    _source: z.string(),
  },
  stEndpoint: { method: 'GET', path: '/crm/v2/tenant/{tid}/customers', source: 'live' },
  async handler(env, args, { actor, correlation }) {
    if (!args.name && !args.phone && !args.email) {
      throw new McpError('validation_error', 'find_customer requires at least one of: name, phone', { correlation });
    }
    // QUA-1054: verified live 2026-08-04 — `email` on /crm/v2/.../customers is
    // discarded by ST (a real, matching address still returns all 11,783
    // customers). Reject before the cache key is built so a rejected call can
    // never be served from, or written to, the cache.
    rejectUnsupportedSTFilters(
      args as unknown as Record<string, unknown>,
      {
        email:
          'ServiceTitan exposes no email filter on /crm/v2/tenant/{tid}/customers. ' +
          'Search by `phone` or `name` instead; customer email addresses live on the ' +
          '/customers/contacts endpoint, which requires customer IDs up front.',
      },
      correlation,
    );
    const page = args.page ?? 1;
    const pageSize = Math.min(args.pageSize ?? VOICE_DEFAULT_PAGESIZE, VOICE_MAX_PAGESIZE);
    const cacheKey = JSON.stringify({ name: args.name ?? '', phone: args.phone ?? '', page, pageSize });

    return cacheGet(env, 'servicetitan:find_customer', cacheKey, 30, async () => {
      const query: Record<string, unknown> = { page, pageSize };
      if (args.name) query.name = args.name;
      // `phone`, NOT `phoneNumber`. Verified against live ST 2026-08-04:
      //   phone=8432609814       -> totalCount 1     (customer 261837)
      //   phone=8439072345       -> totalCount 0     (correctly empty)
      //   phoneNumber=8439072345 -> totalCount 11783 (the whole tenant)
      // The old mapping was the entire QUA-1054 defect.
      if (args.phone) query.phone = args.phone;

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
  transformResult: defaultShaper,
};
