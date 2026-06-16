// ============================================================
// write-tool-factory.ts — H1: defineWriteTool() removes ~80 lines of
// boilerplate across 10+ ST write tools.
//
// Every write tool repeats the same 5-step shape:
//   1. Pull dryRun + confirmation_token out of args.
//   2. Branch dryRun=true → gate.dryRun(...) envelope.
//   3. Validate confirmation_token presence.
//   4. gate.verifyToken(...) — HMAC + expiry + consume.
//   5. POST /api/st/write via the ST_PROXY service binding.
//
// The factory takes a small per-tool spec (endpoint, method, payload
// shape, businessArgs key) and emits a ToolDef that does the rest.
//
// Migration plan: ship behind no flag (additive). Migrate one tool
// (add_customer_note — append-only, low blast). Soak. Then batch.
// Per v1.1 plan, do NOT batch-migrate without soak — TDD catches
// shape regressions but not "ServiceTitan returns 422 on this exact
// payload."
// ============================================================

import type { ZodTypeAny } from 'zod';
import { z } from 'zod';
import { McpError } from './errors';
import { WriteGate } from './write-gate';
import { rewriteTenantPlaceholders } from './tenant';
import { cachePurgeNamespace } from './cache';
import type { ToolDef } from './tools/index';
import type { Env } from './env';

export type StWriteMethod = 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface WriteToolSpec<TArgs> {
  name: string;
  description: string;
  /** Business-field schema only. The factory adds dryRun + confirmation_token. */
  zodSchema: Record<string, ZodTypeAny>;
  /** Optional pre-handler validation hook for cross-field rules that the raw
   * zodSchema cannot express (e.g., "soldBy required when status=Sold").
   * Throw any Error to reject — the factory wraps non-McpError throws into
   * McpError(validation_error). Runs on BOTH dryRun and live paths so the
   * confirmation_token can never be issued for invalid input. */
  validate?: (args: TArgs) => void;
  /** Build the ST endpoint path from the parsed args. */
  endpoint: (args: TArgs) => string;
  /** HTTP method on the ST endpoint (passed through to servicetitan-proxy write proxy). */
  method: StWriteMethod;
  /** Build the request body payload from the parsed args. */
  payload: (args: TArgs) => unknown;
  /** Optional: shape the args used as the HMAC keying material (defaults to all
   * args minus dryRun + confirmation_token). Useful when the dryRun-side hash
   * should differ from the live payload (e.g., omitting computed fields). */
  businessArgs?: (args: TArgs) => Record<string, unknown>;
  /** Optional: templated ST endpoint path (e.g. '/jpm/v2/tenant/{tid}/jobs').
   * When provided, the factory sets `stEndpoint` on the resulting ToolDef so
   * /admin/endpoints can inventory ST coverage. Source is always 'live' for
   * defineWriteTool (writes never short-circuit through D1). */
  stEndpointTemplate?: string;
  /** Optional: cache namespaces to purge after a confirmed write. Runs after
   * the ST write succeeds, before the response returns. Each purge is a single
   * D1 DELETE (~5ms); they fire in parallel via Promise.all. Failures are
   * swallowed inside cachePurgeNamespace so a purge error never fails the write. */
  invalidatesCache?: (args: TArgs) => string[];
  /** Optional: shorter confirmation-token TTL (ms) for tools that don't need the
   * default 15-min LLM-rumination buffer. Capped at MAX_TOKEN_TTL_MS in
   * write-gate.ts. Use 5 * 60 * 1000 for automated single-call writes. */
  tokenTtlMs?: number;
}

const DRY_RUN_ZOD = z
  .boolean()
  .default(true)
  .describe('true (default) = preview + token; false = execute write');

const TOKEN_ZOD = z
  .string()
  .optional()
  .describe('Token from prior dryRun=true call');

interface BaseWriteArgs {
  dryRun?: boolean;
  confirmation_token?: string;
}

function defaultBusinessArgs<TArgs extends BaseWriteArgs>(args: TArgs): Record<string, unknown> {
  const { dryRun: _dr, confirmation_token: _ct, ...rest } = args as Record<string, unknown> &
    BaseWriteArgs;
  return rest;
}

export function defineWriteTool<TArgs extends BaseWriteArgs>(
  spec: WriteToolSpec<TArgs>
): ToolDef<TArgs> {
  return {
    name: spec.name,
    description: spec.description,
    isWrite: true,
    ...(spec.stEndpointTemplate
      ? {
          stEndpoint: {
            method: spec.method,
            path: spec.stEndpointTemplate,
            source: 'live' as const,
          },
        }
      : {}),
    zodSchema: {
      ...spec.zodSchema,
      dryRun: DRY_RUN_ZOD,
      confirmation_token: TOKEN_ZOD,
    },
    async handler(env: Env, args: TArgs, { actor, correlation }) {
      if (spec.validate) {
        try {
          spec.validate(args);
        } catch (e) {
          if (e instanceof McpError) throw e;
          throw new McpError('validation_error', e instanceof Error ? e.message : String(e), { correlation });
        }
      }
      const dryRun = args.dryRun ?? true;
      const confirmation_token = args.confirmation_token;
      const businessArgs = spec.businessArgs ? spec.businessArgs(args) : defaultBusinessArgs(args);
      const gate = new WriteGate(env);
      // Resolve /tenant/000000000/ to the real tenant at the call site before the
      // write reaches /api/st/write. Previously this relied on the (unreliable,
      // now-retired) withTenantRewrite wrapper, so confirmed writes could be sent
      // to tenant 000000000.
      const endpoint = rewriteTenantPlaceholders(env, spec.endpoint(args));
      const payload = spec.payload(args);

      if (dryRun) {
        return gate.dryRun(spec.name, businessArgs, actor, correlation, payload, endpoint, spec.method, spec.tokenTtlMs);
      }
      if (!confirmation_token) {
        throw new McpError('validation_error', 'confirmation_token required when dryRun=false', { correlation });
      }
      await gate.verifyToken(spec.name, businessArgs, actor, confirmation_token);

      const resp = await env.ST_PROXY.fetch('https://servicetitan-proxy/api/st/write', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-sync-key': env.MCP_SYNC_KEY,
          'x-correlation-id': correlation,
          'x-actor': actor,
        },
        body: JSON.stringify({ endpoint, method: spec.method, payload }),
      });
      if (!resp.ok) {
        throw new McpError('upstream_error', `${spec.name} failed: ${resp.status}`, { correlation });
      }
      const result = await resp.json();
      if (spec.invalidatesCache) {
        const namespaces = spec.invalidatesCache(args);
        await Promise.all(namespaces.map((ns) => cachePurgeNamespace(env, ns)));
      }
      return { dryRun: false, tool: spec.name, result, correlation };
    },
  };
}
