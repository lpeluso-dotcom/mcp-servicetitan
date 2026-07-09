// ============================================================
// sales/__tests__/helpers.ts — shared test harness for the estimate-template
// CRUD tools. Mirrors the makeEnv/makeStatefulDB pattern used across
// h1_write_tool_factory.test.ts and t7_estimates_dispatch_marketing.test.ts,
// factored out here since 5 sibling tool-test files in this directory need it.
// ============================================================
import { vi } from 'vitest';

export const CTX = { actor: 'vitest', correlation: 'test-corr' };

interface TokenRow {
  token_hash: string;
  consumed_at: number | null;
  expires_at: number;
}

/** Stateful D1 mock simulating the confirmation_tokens table so the
 * dryRun -> confirm round-trip exercises WriteGate.verifyToken end-to-end. */
export function makeStatefulDB() {
  const tokens: Map<string, TokenRow> = new Map();
  return {
    tokens,
    prepare: vi.fn((sql: string) => {
      const captured: unknown[] = [];
      const stmt = {
        bind: vi.fn(function (this: unknown, ...args: unknown[]) {
          captured.push(...args);
          return this;
        }),
        run: vi.fn(async () => {
          if (/INSERT OR IGNORE INTO confirmation_tokens/i.test(sql)) {
            const tokenHash = String(captured[0]);
            const expiresAt = Number(captured[5]);
            tokens.set(tokenHash, { token_hash: tokenHash, consumed_at: null, expires_at: expiresAt });
          } else if (/UPDATE confirmation_tokens SET consumed_at/i.test(sql)) {
            const consumedAt = Number(captured[0]);
            const tokenHash = String(captured[1]);
            const row = tokens.get(tokenHash);
            if (row) row.consumed_at = consumedAt;
          }
          return { success: true };
        }),
        first: vi.fn(async () => {
          if (/SELECT consumed_at, expires_at FROM confirmation_tokens/i.test(sql)) {
            const tokenHash = String(captured[0]);
            return tokens.get(tokenHash) ?? null;
          }
          return null;
        }),
      };
      return stmt;
    }),
  };
}

export function makeEnv(
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
  db: ReturnType<typeof makeStatefulDB> = makeStatefulDB(),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
  return {
    ST_PROXY: { fetch: vi.fn(fetchImpl) },
    MCP_SYNC_KEY: 'test-key',
    MCP_SERVICE_VERSION: '0.0.0-test',
    DB: db,
    PROXY_STATE: {},
    SIRO_API_TOKEN: '',
  };
}

/** Fetch impl that throws if ST_PROXY is ever hit — for dryRun-only assertions
 * where a live call would be a bug (dryRun must never reach ST_PROXY). */
export function noFetch() {
  return async (url: string) => {
    throw new Error(`ST_PROXY should not have been called on dryRun: ${url}`);
  };
}

export function liveOk(data: unknown) {
  return async () => new Response(JSON.stringify({ data }), { status: 200 });
}

export function liveOkDirect(data: unknown) {
  return async () => new Response(JSON.stringify(data), { status: 200 });
}
