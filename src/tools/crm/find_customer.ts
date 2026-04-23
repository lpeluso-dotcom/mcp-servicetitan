import { z } from 'zod';
import { McpError } from '../../errors';
import { authHeaders, newCorrelationId } from '../../auth';
import type { ToolDef } from '../index';

interface Args { name?: string; phone?: string; email?: string; page?: number; pageSize?: number }

export const find_customer: ToolDef<Args> = {
  name: 'find_customer',
  description: 'Search ST customers by name, phone, or email. Source: live ST.',
  zodSchema: {
    name: z.string().optional().describe('Customer name (partial match)'),
    phone: z.string().optional().describe('Phone number'),
    email: z.string().optional().describe('Email address'),
    page: z.number().int().positive().optional().describe('Page number, default 1'),
    pageSize: z.number().int().positive().max(200).optional().describe('Page size, max 200'),
  },
  async handler(env, args, { actor, correlation }) {
    if (!args.name && !args.phone && !args.email) {
      throw new McpError('validation_error', 'find_customer requires at least one of: name, phone, email', { correlation });
    }
    const qs = new URLSearchParams();
    if (args.name) qs.set('name', args.name);
    if (args.phone) qs.set('phoneNumber', args.phone);
    if (args.email) qs.set('email', args.email);
    if (args.page) qs.set('page', String(args.page));
    if (args.pageSize) qs.set('pageSize', String(args.pageSize));

    const resp = await env.TAYLOR_AI.fetch(
      `https://taylor-ai/api/st/read?endpoint=${encodeURIComponent(`/crm/v2/tenant/431848990/customers?${qs}`)}`,
      { headers: authHeaders(env, correlation, actor) }
    );
    if (!resp.ok) throw new McpError('upstream_error', `find_customer failed: ${resp.status}`, { correlation });
    const data = await resp.json<{ data?: unknown[] }>();
    return { customers: data.data ?? [], _source: 'live' };
  },
};
