// ============================================================
// st_patch_service — PATCH a pricebook service by ID
// F3: dryRun=true (default) → confirmation_token → dryRun=false → durable write.
// ============================================================

import { z } from 'zod';
import type { Env } from '../env';
import { authHeaders } from '../auth';
import { McpError, mapUpstreamStatus } from '../errors';
import { WriteGate } from '../write-gate';
import type { ToolDef } from './index';
import { toStPricebookPayload } from './pricebook-payload';

// Polling budget for upstream durable workflow status. The workflow has 5 steps
// (precheck/gate/write/verify/commit-log) with their own retries; median ~5–15s
// but cold start + step scheduling regularly push past 60s. 90 × 2s = 180s covers
// the realistic ceiling; if we still time out the write probably DID land — GET
// the resource by code to confirm before retrying.
export const POLL_INTERVAL_MS = 2000;
export const POLL_MAX_ATTEMPTS = 90;

interface Args {
  id: number;
  name?: string;
  code?: string;
  description?: string;
  cost?: number;
  price?: number;
  memberPrice?: number;
  useStaticPrices?: boolean;
  hours?: number;
  isLabor?: boolean;
  taxable?: boolean;
  account?: string;
  paysCommission?: boolean;
  active?: boolean;
  categoryId?: number;
  categories?: number[];
  dryRun?: boolean;
  confirmation_token?: string;
}

export const st_patch_service: ToolDef<Args> = {
  name: 'st_patch_service',
  description:
    'PATCH a ServiceTitan pricebook service by ID. ' +
    'dryRun=true (default) validates and returns a confirmation_token — call again with dryRun=false + token to write. ' +
    'QSC default is dynamic pricing — do NOT set price/memberPrice unless this is a static-price service. ' +
    'Note: useStaticPrices cannot be flipped from false→true via PATCH on a service that was created without it (ST silent drop, 2026-05-08 incident). Use ST UI to flip. ' +
    'Source: live ST.',
  isWrite: true,
  stEndpoint: { method: 'PATCH', path: '/pricebook/v2/tenant/{tid}/services/{id}', source: 'live' },
  zodSchema: {
    id: z.number().int().positive().describe('ST pricebook service ID'),
    name: z.string().optional().describe('Display name (rewritten to displayName before submit)'),
    code: z.string().optional().describe('Service code (e.g. "HVAC-DIAG-01")'),
    description: z.string().optional().describe('Service description shown on invoices'),
    cost: z.number().optional().describe('Internal cost (required for correct job costing)'),
    price: z.number().optional().describe('Static price. Only meaningful when useStaticPrices=true.'),
    memberPrice: z.number().optional().describe('Member-tier static price. Only meaningful when useStaticPrices=true.'),
    useStaticPrices: z.boolean().optional().describe('Plural — the field ST actually accepts. CAN ONLY BE FLIPPED via UI post-create — PATCH attempts silently drop.'),
    hours: z.number().optional().describe('Labor hours (used for cost calc on isLabor=true services)'),
    isLabor: z.boolean().optional().describe('true = labor line item; false = part/equipment/fee'),
    taxable: z.boolean().optional().describe('Whether the service is taxable'),
    account: z.string().optional().describe('GL account name (e.g. "Revenue")'),
    paysCommission: z.boolean().optional().describe('Whether commission applies on sale'),
    active: z.boolean().optional().describe('Whether the service is active in the pricebook'),
    categoryId: z.number().int().positive().optional().describe('Pricebook category ID (single-cat shortcut; pass categories[] for multi-cat)'),
    categories: z.array(z.number().int().positive()).min(1).optional().describe('Multi-category. If passed, takes precedence over categoryId.'),
    dryRun: z.boolean().default(true).describe('true (default) = preview + token; false = execute write'),
    confirmation_token: z.string().optional().describe('Token from prior dryRun=true call, required when dryRun=false'),
  },
  async handler(env, args, { actor, correlation }) {
    const { id, dryRun = true, confirmation_token, ...payload } = args;
    if (Object.keys(payload).length === 0) {
      throw new McpError('validation_error', 'st_patch_service requires at least one field to update besides id', { correlation });
    }
    const businessArgs = { id, ...payload };
    const stPayload = toStPricebookPayload(payload);
    const gate = new WriteGate(env);
    const endpoint = `/pricebook/v2/tenant/000000000/services/${id}`;

    if (dryRun) {
      return gate.dryRun('st_patch_service', businessArgs, actor, correlation, stPayload, endpoint, 'PATCH', 5 * 60 * 1000);
    }
    if (!confirmation_token) {
      throw new McpError('validation_error', 'confirmation_token required when dryRun=false', { correlation });
    }
    await gate.verifyToken('st_patch_service', businessArgs, actor, confirmation_token);
    return durableWrite(env, { actor, operation: 'service.patch', target: { id: String(id), type: 'service' }, payload: stPayload, correlation });
  },
};

// ─── Shared durable write helper (used by all 4 write tools) ──────────────
interface DurableWriteOpts {
  actor: string;
  operation: string;
  target: { id: string; type?: string };
  payload: unknown;
  correlation: string;
  _pollIntervalMs?: number;
  _pollMaxAttempts?: number;
}

export async function durableWrite(env: Env, opts: DurableWriteOpts): Promise<unknown> {
  const {
    actor, operation, target, payload, correlation,
    _pollIntervalMs = POLL_INTERVAL_MS,
    _pollMaxAttempts = POLL_MAX_ATTEMPTS,
  } = opts;

  const submitResp = await env.ST_PROXY.fetch('https://servicetitan-proxy/api/st/durable-write', {
    method: 'POST',
    headers: { ...authHeaders(env, correlation, actor), 'Content-Type': 'application/json' },
    body: JSON.stringify({ actor, operation, target, payload, dry_run: false, correlation }),
  });

  if (!submitResp.ok) {
    const body = await submitResp.text().catch(() => '');
    throw new McpError(
      mapUpstreamStatus(submitResp.status),
      `durable-write submit failed ${submitResp.status}: ${body.slice(0, 200)}`,
      { correlation }
    );
  }

  const { instance_id } = (await submitResp.json()) as { instance_id: string };

  for (let i = 0; i < _pollMaxAttempts; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, _pollIntervalMs));
    const statusResp = await env.ST_PROXY.fetch(
      `https://servicetitan-proxy/api/st/durable-write/${instance_id}/status`,
      { headers: authHeaders(env, correlation, actor) }
    );
    if (!statusResp.ok) {
      if (statusResp.status < 500) {
        throw new McpError(mapUpstreamStatus(statusResp.status), `status poll failed ${statusResp.status} for instance ${instance_id}`, { correlation });
      }
      continue;
    }
    const s = (await statusResp.json()) as { status: string; output?: unknown; error?: unknown };
    if (s.status === 'complete') return s.output;
    if (s.status === 'errored') {
      const msg = typeof s.error === 'string' ? s.error : JSON.stringify(s.error);
      throw new McpError('upstream_error', `durable write errored: ${msg}`, { correlation });
    }
  }

  const elapsedSeconds = Math.round((_pollMaxAttempts * _pollIntervalMs) / 1000);
  throw new McpError(
    'timeout',
    `durable write ${instance_id} did not complete within ${elapsedSeconds}s — the write may still have landed; GET the resource to verify before retrying`,
    { correlation },
  );
}
