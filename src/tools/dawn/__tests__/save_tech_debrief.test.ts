// ============================================================
// save_tech_debrief.test.ts — TDD for Dawn SMS tool (v1.6.0)
// ============================================================
import { describe, it, expect, vi } from 'vitest';
import { save_tech_debrief } from '../save_tech_debrief';
import type { Env } from '../../../env';
import type { ToolContext } from '../../index';

const ctx: ToolContext = { actor: 'test', correlation: 'test-corr' };

function makeEnvWithDB(runResult: unknown, shouldThrow?: boolean): Env {
  const mockRun = shouldThrow
    ? vi.fn().mockRejectedValue(new Error('D1 write failed'))
    : vi.fn().mockResolvedValue(runResult);

  const mockDB = {
    prepare: vi.fn().mockReturnValue({
      bind: vi.fn().mockReturnValue({
        run: mockRun,
      }),
    }),
  };
  return { DB: mockDB as unknown as D1Database } as unknown as Env;
}

const VALID_ARGS = {
  retell_chat_id: 'retell-session-abc123',
  tech_id: 'T789',
  tech_name: 'Mike Davis',
  tech_phone: '8435557890',
};

describe('save_tech_debrief', () => {
  it('returns {status: "saved", debrief_id: 42} on successful insert', async () => {
    const env = makeEnvWithDB({ results: [{ id: 42 }], success: true });

    const result = await save_tech_debrief.handler(env, VALID_ARGS, ctx) as any;
    expect(result.status).toBe('saved');
    expect(result.debrief_id).toBe(42);
  });

  it('returns {status: "db_error"} when DB throws and does NOT re-throw', async () => {
    const env = makeEnvWithDB(null, true /* shouldThrow */);

    // Should not throw — call directly and verify it resolves (not rejects)
    const result = await save_tech_debrief.handler(env, VALID_ARGS, ctx) as any;

    // If it had thrown, the line above would reject and the test would fail
    expect(result.status).toBe('db_error');
  });

  it('returns {status: "parse_error"} when retell_chat_id is empty string', async () => {
    const env = makeEnvWithDB({ results: [{ id: 1 }] });

    const result = await save_tech_debrief.handler(
      env,
      { ...VALID_ARGS, retell_chat_id: '' },
      ctx,
    ) as any;
    expect(result.status).toBe('parse_error');
    expect(result.message).toBeDefined();
  });
});
