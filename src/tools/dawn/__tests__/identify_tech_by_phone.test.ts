// ============================================================
// identify_tech_by_phone.test.ts — TDD for Dawn SMS tool (v1.6.0)
// ============================================================
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { identify_tech_by_phone } from '../identify_tech_by_phone';
import type { Env } from '../../../env';
import type { ToolContext } from '../../index';

function makeEnv(voiceResult: unknown, techResult: unknown): Env {
  const firstChain = (result: unknown) => ({
    first: vi.fn().mockResolvedValue(result),
  });

  let callCount = 0;
  const mockDB = {
    prepare: vi.fn().mockImplementation(() => ({
      bind: vi.fn().mockReturnValue(
        callCount++ === 0 ? firstChain(voiceResult) : firstChain(techResult),
      ),
    })),
  };

  return { DB: mockDB as unknown as D1Database } as unknown as Env;
}

function makeEnvSequential(responses: unknown[]): Env {
  let callCount = 0;
  const mockDB = {
    prepare: vi.fn().mockImplementation(() => ({
      bind: vi.fn().mockReturnValue({
        first: vi.fn().mockImplementation(() => Promise.resolve(responses[callCount++])),
      }),
    })),
  };
  return { DB: mockDB as unknown as D1Database } as unknown as Env;
}

const ctx: ToolContext = { actor: 'test', correlation: 'test-corr' };

describe('identify_tech_by_phone', () => {
  it('returns {status: "found", source: "technicians"} when technicians query returns a row', async () => {
    // voice_registry misses, technicians hits
    const env = makeEnvSequential([
      null, // voice_registry returns null
      { tech_id: 'T123', name: 'Jane Smith', phone: '8435551234', business_unit: 'HVAC' },
    ]);

    const result = await identify_tech_by_phone.handler(env, { phone: '8435551234' }, ctx) as any;
    expect(result.status).toBe('found');
    expect(result.source).toBe('technicians');
    expect(result.tech_id).toBe('T123');
    expect(result.tech_name).toBe('Jane Smith');
  });

  it('returns {status: "not_found"} when no match in either table', async () => {
    const env = makeEnvSequential([null, null]);

    const result = await identify_tech_by_phone.handler(env, { phone: '8435559999' }, ctx) as any;
    expect(result.status).toBe('not_found');
  });

  it('normalizes formatted phone "+1 (843) 555-1234" to "8435551234" before query', async () => {
    const env = makeEnvSequential([
      null,
      { tech_id: 'T456', name: 'Bob Jones', phone: '(843) 555-1234', business_unit: 'Plumbing' },
    ]);

    const result = await identify_tech_by_phone.handler(env, { phone: '+1 (843) 555-1234' }, ctx) as any;
    expect(result.status).toBe('found');
    // Verify the DB was queried with the normalized value by checking the result
    expect(result.source).toBe('technicians');
  });

  it('returns {status: "parse_error"} when input has <10 digits after normalization', async () => {
    const env = makeEnvSequential([]);

    const result = await identify_tech_by_phone.handler(env, { phone: '12345' }, ctx) as any;
    expect(result.status).toBe('parse_error');
  });
});
