import { z } from 'zod';
import { readST } from '../../st';
import { McpError } from '../../errors';
import type { ToolDef } from '../index';

interface Args { callId: number }

export const get_call: ToolDef<Args> = {
  name: 'get_call',
  description:
    'Get details for a telecom call record including duration, campaign attribution, and recording info. ' +
    'Source: live ST — fetched by id via the list endpoint (telecom v3 has no /calls/{id} route). ' +
    'Returns the full envelope row as-is: the real call data is NESTED under `leadCall` — the row\'s ' +
    'top-level `id` is always 0/meaningless, so consumers must read `call.leadCall.id`/fields, not `call.id`. ' +
    'There is no by-id shape to preserve since a working by-id route never existed in prod.',
  zodSchema: {
    callId: z.number().int().positive().describe('ST call ID — matches leadCall.id in the returned row, not the row\'s top-level id'),
  },
  stEndpoint: { method: 'GET', path: '/telecom/v3/tenant/{tid}/calls', source: 'live' },
  async handler(env, args, { actor, correlation }) {
    const data = await readST<{ data?: unknown[] }>(
      env, { actor, correlation },
      '/telecom/v3/tenant/000000000/calls',
      { ids: args.callId },
    );
    const row = data.data?.[0] ?? null;
    if (!row) throw new McpError('not_found', `call ${args.callId} not found`, { correlation });
    // Guard: this list endpoint has a documented history elsewhere (invoicing)
    // of silently ignoring filter params. The row's own `id` is always 0, so
    // the guard must compare the NESTED leadCall.id — if ST ever ignores
    // `ids`, leadCall.id would be an arbitrary call; fail loudly instead of
    // returning silently wrong data.
    const nestedId = Number((row as { leadCall?: { id?: unknown } }).leadCall?.id);
    if (nestedId !== args.callId)
      throw new McpError('upstream_error', `ids filter not honored: asked ${args.callId}, got ${nestedId}`, { correlation });
    return { call: row, _source: 'live' };
  },
};
