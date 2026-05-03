// ============================================================
// F-07 — per-tool tokenTtlMs in WriteGate.
//
// Verifies that:
//   - Default TTL = DEFAULT_TOKEN_TTL_MS (15 min) when no override
//   - Per-tool 5-min TTL surfaces in expires_in_seconds
//   - tokenTtlMs above MAX is capped at MAX
//   - D1 expires_at drives the per-tool reject after the window passes
//   - The MAX_TOKEN_TTL_MS in-memory early-reject still fires for ancient tokens
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  WriteGate,
  DEFAULT_TOKEN_TTL_MS,
  MAX_TOKEN_TTL_MS,
} from '../../write-gate';
import type { Env } from '../../env';

interface TokenRow { token_hash: string; consumed_at: number | null; expires_at: number }

function makeStatefulDB() {
  const tokens: Map<string, TokenRow> = new Map();
  const inserts: unknown[][] = [];
  return {
    tokens,
    inserts,
    prepare: vi.fn((sql: string) => {
      const captured: unknown[] = [];
      const stmt = {
        bind: vi.fn(function (this: any, ...args: unknown[]) {
          captured.push(...args);
          return this;
        }),
        run: vi.fn(async () => {
          if (/INSERT OR IGNORE INTO confirmation_tokens/i.test(sql)) {
            inserts.push([...captured]);
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

function makeEnv() {
  const db = makeStatefulDB();
  const env = {
    DB: db,
    MCP_SYNC_KEY: 'test-secret-key',
    MCP_SERVICE_VERSION: '1.2.0-test',
  } as unknown as Env;
  return { env, db };
}

describe('WriteGate per-tool tokenTtlMs', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-03T12:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('defaults to DEFAULT_TOKEN_TTL_MS (15 min) when no override', async () => {
    const { env } = makeEnv();
    const gate = new WriteGate(env);
    const out = await gate.dryRun('test_tool', { x: 1 }, 'vitest', 'corr-1', { x: 1 }, '/test', 'POST');
    expect(out.expires_in_seconds).toBe(DEFAULT_TOKEN_TTL_MS / 1000);
    expect(out.expires_in_seconds).toBe(900);
  });

  it('honors a 5-min override', async () => {
    const { env } = makeEnv();
    const gate = new WriteGate(env);
    const out = await gate.dryRun('test_tool', { x: 1 }, 'vitest', 'corr-2', { x: 1 }, '/test', 'POST', 5 * 60 * 1000);
    expect(out.expires_in_seconds).toBe(300);
  });

  it('caps overrides above MAX_TOKEN_TTL_MS', async () => {
    const { env } = makeEnv();
    const gate = new WriteGate(env);
    // 1 hour requested, but ceiling enforces 15 min.
    const out = await gate.dryRun('test_tool', { x: 1 }, 'vitest', 'corr-3', { x: 1 }, '/test', 'POST', 60 * 60 * 1000);
    expect(out.expires_in_seconds).toBe(MAX_TOKEN_TTL_MS / 1000);
    expect(out.expires_in_seconds).toBe(900);
  });

  it('writes the per-tool expires_at to D1', async () => {
    const { env, db } = makeEnv();
    const gate = new WriteGate(env);
    await gate.dryRun('test_tool', { x: 1 }, 'vitest', 'corr-4', { x: 1 }, '/test', 'POST', 5 * 60 * 1000);
    expect(db.inserts).toHaveLength(1);
    // INSERT params: token_hash, tool, args_hash, actor, issued_at, expires_at, correlation
    const issuedAt = Number(db.inserts[0][4]);
    const expiresAt = Number(db.inserts[0][5]);
    expect(expiresAt - issuedAt).toBe(5 * 60 * 1000);
  });

  it('rejects a token after its per-tool expires_at, even within MAX window', async () => {
    const { env } = makeEnv();
    const gate = new WriteGate(env);
    const out = await gate.dryRun('test_tool', { x: 1 }, 'vitest', 'corr-5', { x: 1 }, '/test', 'POST', 5 * 60 * 1000);

    // Advance clock 6 min — past per-tool 5-min TTL but within 15-min absolute max.
    vi.setSystemTime(Date.now() + 6 * 60 * 1000);

    await expect(
      gate.verifyToken('test_tool', { x: 1 }, 'vitest', out.confirmation_token)
    ).rejects.toThrow(/expired \(per-tool TTL\)/);
  });

  it('still fires the MAX-window early reject for tokens older than MAX', async () => {
    const { env } = makeEnv();
    const gate = new WriteGate(env);
    const out = await gate.dryRun('test_tool', { x: 1 }, 'vitest', 'corr-6', { x: 1 }, '/test', 'POST');

    // Advance 16 min — past MAX_TOKEN_TTL_MS.
    vi.setSystemTime(Date.now() + 16 * 60 * 1000);

    await expect(
      gate.verifyToken('test_tool', { x: 1 }, 'vitest', out.confirmation_token)
    ).rejects.toThrow(/^confirmation_token expired$/);
  });

  it('verifies a fresh per-tool token within its window', async () => {
    const { env } = makeEnv();
    const gate = new WriteGate(env);
    const out = await gate.dryRun('test_tool', { x: 1 }, 'vitest', 'corr-7', { x: 1 }, '/test', 'POST', 5 * 60 * 1000);
    // Advance 1 min — well within both per-tool and MAX windows.
    vi.setSystemTime(Date.now() + 60 * 1000);
    await expect(
      gate.verifyToken('test_tool', { x: 1 }, 'vitest', out.confirmation_token)
    ).resolves.toBeUndefined();
  });
});
