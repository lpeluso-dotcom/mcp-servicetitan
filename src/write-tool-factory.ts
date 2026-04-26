// ============================================================
// write-tool-factory.ts — H1: defineWriteTool() removes ~80 lines of
// boilerplate across 10+ ST write tools.
//
// Every write tool repeats the same 5-step shape:
//   1. Pull dryRun + confirmation_token out of args.
//   2. Branch dryRun=true → gate.dryRun(...) envelope.
//   3. Validate confirmation_token presence.
//   4. gate.verifyToken(...) — HMAC + expiry + consume.
//   5. POST /api/st/write via the TAYLOR_AI service binding.
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
import type { ToolDef } from './tools/index';
import type { Env } from './env';

export type StWriteMethod = 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface WriteToolSpec<TArgs> {
  name: string;
  description: string;
  /** Business-field schema only. The factory adds dryRun + confirmation_token. */
  zodSchema: Record<string, ZodTypeAny>;
  /** Build the ST endpoint path from the parsed args. */
  endpoint: (args: TArgs) => string;
  /** HTTP method on the ST endpoint (passed through to taylor-ai write proxy). */
  method: StWriteMethod;
  /** Build the request body payload from the parsed args. */
  payload: (args: TArgs) => unknown;
  /** Optional: shape the args used as the HMAC keying material (defaults to all
   * args minus dryRun + confirmation_token). Useful when the dryRun-side hash
   * should differ from the live payload (e.g., omitting computed fields). */
  businessArgs?: (args: TArgs) => Record<string, unknown>;
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
    zodSchema: {
      ...spec.zodSchema,
      dryRun: DRY_RUN_ZOD,
      confirmation_token: TOKEN_ZOD,
    },
    async handler(env: Env, args: TArgs, { actor, correlation }) {
      const dryRun = args.dryRun ?? true;
      const confirmation_token = args.confirmation_token;
      const businessArgs = spec.businessArgs ? spec.businessArgs(args) : defaultBusinessArgs(args);
      const gate = new WriteGate(env);
      const endpoint = spec.endpoint(args);
      const payload = spec.payload(args);

      if (dryRun) {
        return gate.dryRun(spec.name, businessArgs, actor, correlation, payload, endpoint, spec.method);
      }
      if (!confirmation_token) {
        throw new McpError('validation_error', 'confirmation_token required when dryRun=false', { correlation });
      }
      await gate.verifyToken(spec.name, businessArgs, actor, confirmation_token);

      const resp = await env.TAYLOR_AI.fetch('https://taylor-ai/api/st/write', {
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
      return { dryRun: false, tool: spec.name, result: await resp.json(), correlation };
    },
  };
}
