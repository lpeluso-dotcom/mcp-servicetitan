import { z } from 'zod';
import { McpError } from '../errors';
import { WriteGate } from '../write-gate';
import type { ToolDef } from './index';

const TENANT = '431848990';

// ── Path middleware ──────────────────────────────────────────

function normalizePath(path: string, method: string): string {
  // Correction 1: /task-management/ → /taskmanagement/
  path = path.replace(/\/task-management\//g, '/taskmanagement/');

  // Correction 2: auto-inject /tenant/431848990/ after the versioned API segment if missing
  // Pattern: /{api}/{version}/... but NOT /{api}/{version}/tenant/...
  if (!path.includes(`/tenant/${TENANT}`)) {
    // Find the version segment (e.g. /v2/, /v3/) and inject tenant after it
    path = path.replace(/^(\/[^/]+\/v\d+)(\/|$)/, `$1/tenant/${TENANT}/`);
  }

  // Strip trailing slash on non-ODATA GET paths
  if (method === 'GET' && !path.includes('/$') && path.endsWith('/')) {
    path = path.slice(0, -1);
  }

  return path;
}

function normalizeBody(body: Record<string, unknown>): Record<string, unknown> {
  const out = { ...body };
  // Correction 3: isConfigurable → isConfigurableEquipment
  if ('isConfigurable' in out) {
    out.isConfigurableEquipment = out.isConfigurable;
    delete out.isConfigurable;
  }
  // Correction 4: useStaticPrice → useStaticPrices (plural)
  if ('useStaticPrice' in out) {
    out.useStaticPrices = out.useStaticPrice;
    delete out.useStaticPrice;
  }
  return out;
}

// ── Tool ─────────────────────────────────────────────────────

interface Args {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;
  query?: Record<string, unknown>;
  body?: Record<string, unknown>;
  dryRun?: boolean;
  confirmation_token?: string;
}

export const st_call: ToolDef<Args> = {
  name: 'st_call',
  description: 'Admin-only raw ST API gateway. Applies 4 path/body corrections automatically: /task-management/ → /taskmanagement/, tenant auto-inject, isConfigurable → isConfigurableEquipment, useStaticPrice → useStaticPrices. GET → /api/st/read. Non-GET defaults to dryRun=true → token → dryRun=false to write. ODATA paths (/$query) pass through as-is.',
  adminOnly: true,
  zodSchema: {
    method: z.enum(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']).describe('HTTP method'),
    path: z.string().min(1).describe('ST API path starting with / (tenant auto-injected if omitted)'),
    query: z.record(z.string(), z.unknown()).optional().describe('Query string parameters (merged into the URL)'),
    body: z.record(z.string(), z.unknown()).optional().describe('Request body for non-GET methods (body middleware applied)'),
    dryRun: z.boolean().default(true).describe('Non-GET only: true (default) = preview + token; false = execute write'),
    confirmation_token: z.string().optional().describe('Token from prior dryRun=true call (non-GET only)'),
  },
  async handler(env, args, { actor, correlation }) {
    const { method, query, dryRun = true, confirmation_token } = args;

    if (!args.path.startsWith('/')) {
      throw new McpError('validation_error', 'st_call: path must start with /', { correlation });
    }

    const path = normalizePath(args.path, method);

    // ── GET: route to read proxy ─────────────────────────────
    if (method === 'GET') {
      let endpointPath = path;
      if (query && Object.keys(query).length > 0) {
        const qs = new URLSearchParams();
        for (const [k, v] of Object.entries(query)) qs.set(k, String(v));
        endpointPath += `?${qs}`;
      }
      const resp = await env.TAYLOR_AI.fetch(
        `https://taylor-ai/api/st/read?endpoint=${encodeURIComponent(endpointPath)}`,
        {
          headers: {
            'x-sync-key': env.MCP_SYNC_KEY,
            'x-correlation-id': correlation,
            'x-actor': actor,
          },
        }
      );
      if (!resp.ok) throw new McpError('upstream_error', `st_call GET failed: ${resp.status}`, { correlation });
      return { result: await resp.json(), _path: path, method };
    }

    // ── Non-GET: route through WriteGate ────────────────────
    const rawBody = args.body ?? {};
    const payload = normalizeBody(rawBody);
    const businessArgs = { method, path, payload };
    const gate = new WriteGate(env);

    if (dryRun) {
      return gate.dryRun('st_call', businessArgs, actor, correlation, payload, path, method);
    }
    if (!confirmation_token) {
      throw new McpError('validation_error', 'confirmation_token required when dryRun=false', { correlation });
    }
    await gate.verifyToken('st_call', businessArgs, actor, confirmation_token);

    const resp = await env.TAYLOR_AI.fetch('https://taylor-ai/api/st/write', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-sync-key': env.MCP_SYNC_KEY,
        'x-correlation-id': correlation,
        'x-actor': actor,
      },
      body: JSON.stringify({ endpoint: path, method, payload }),
    });
    if (!resp.ok) throw new McpError('upstream_error', `st_call ${method} failed: ${resp.status}`, { correlation });
    return { dryRun: false, tool: 'st_call', result: await resp.json(), correlation };
  },
};
