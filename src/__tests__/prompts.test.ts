// ============================================================
// prompts.test.ts — Phase 2 Task 2.3 / TAI-STv2 guided-surface rebuild
//
// TDD for the 5 QSC workflow MCP prompts. Two layers:
//   1. Unit: PROMPTS array shape + build() orchestration text (fast, no
//      protocol machinery).
//   2. Protocol path: buildServer() + InMemoryTransport + SDK Client,
//      mirroring src/__tests__/mcp-protocol.test.ts's mocking pattern —
//      proves prompts/list and prompts/get actually work through the real
//      per-request McpServer, not just that PROMPTS is well-formed.
// ============================================================

import { describe, it, expect, vi } from 'vitest';
import { PROMPTS } from '../prompts/index';

describe('PROMPTS — unit', () => {
  it('has exactly 5 prompts with the expected names', () => {
    expect(PROMPTS.length).toBe(5);
    expect(PROMPTS.map((p) => p.name)).toEqual([
      'job-cost-margin', 'daily-review', 'pricebook-health', 'weekly-tech-review', 'drive-time',
    ]);
  });

  it('every prompt has a non-empty description and a build() returning a messages array', () => {
    for (const p of PROMPTS) {
      expect(p.description).toBeTruthy();
      expect(p.description!.length).toBeGreaterThan(0);
      const messages = p.build({} as any);
      expect(Array.isArray(messages)).toBe(true);
      expect(messages.length).toBeGreaterThan(0);
      for (const m of messages) {
        expect(m.role).toBe('user');
        expect(m.content.type).toBe('text');
        expect(typeof m.content.text).toBe('string');
        expect(m.content.text.length).toBeGreaterThan(0);
      }
    }
  });

  it('job-cost-margin job mode names job_cost_actuals; BU mode names gold_margin_by_bu', () => {
    const p = PROMPTS.find((p) => p.name === 'job-cost-margin')!;
    expect(p.build({ jobId: 123 })[0].content.text).toContain('job_cost_actuals');
    const bu = p.build({ businessUnitId: 10, from: '2026-06-01', to: '2026-06-30' })[0].content.text;
    expect(bu).toContain('gold_margin_by_bu');
  });

  it('daily-review orchestrates list_jobs_today, get_capacity, dispatch_pro_alerts_list', () => {
    const t = PROMPTS.find((p) => p.name === 'daily-review')!.build({ date: '2026-07-09' })[0].content.text;
    expect(t).toContain('list_jobs_today');
    expect(t).toContain('get_capacity');
    expect(t).toContain('dispatch_pro_alerts_list');
    expect(t).toContain('2026-07-09');
  });

  it('pricebook-health orchestrates the four pricebook composites', () => {
    const t = PROMPTS.find((p) => p.name === 'pricebook-health')!.build({})[0].content.text;
    for (const tool of ['pricebook_health_check_services', 'pricebook_markup_drift', 'pricebook_cost_drift', 'pricebook_vendor_part_gaps'])
      expect(t).toContain(tool);
  });

  it('weekly-tech-review names tech_scorecard', () => {
    expect(PROMPTS.find((p) => p.name === 'weekly-tech-review')!.build({})[0].content.text).toContain('tech_scorecard');
  });

  it('drive-time names tech_drive_time_summary and includes the tech id', () => {
    const t = PROMPTS.find((p) => p.name === 'drive-time')!
      .build({ technicianId: 7, startDate: '2026-07-01', endDate: '2026-07-07' })[0].content.text;
    expect(t).toContain('tech_drive_time_summary');
    expect(t).toContain('7');
  });
});

// ─── Protocol path — same mocking pattern as mcp-protocol.test.ts ─────────
vi.mock('agents/mcp', () => ({ createMcpHandler: () => () => new Response() }));
vi.mock('../oauth', () => ({
  createOAuthProvider: () => ({ fetch: async () => new Response() }),
  handleOAuthRoute: async () => new Response(),
}));

const { buildServer } = await import('../index');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');

function makeDB() {
  const stmt = {
    bind: vi.fn().mockReturnThis(),
    run: vi.fn().mockResolvedValue({ success: true }),
    first: vi.fn().mockResolvedValue(null),
  };
  return { prepare: vi.fn().mockReturnValue(stmt) };
}

function makeEnv(): any {
  return {
    DB: makeDB(),
    ST_PROXY: {
      fetch: vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 1, name: 'Fixture Customer' }] }), { status: 200 })),
    },
    MCP_SYNC_KEY: 'test-key',
    MCP_SERVICE_VERSION: '0.0.0-test',
    ST_TENANT_ID: '000000000',
  };
}

const execCtx = { waitUntil: () => undefined } as any;

async function connectedClient() {
  const server = buildServer(makeEnv(), execCtx, { actor: 'test-prompts', role: 'default' });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'prompts-test-client', version: '0.0.0-test' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe('MCP protocol layer — prompts via buildServer', () => {
  it('prompts/list returns exactly the 5 QSC workflow prompts with argument metadata', async () => {
    const client = await connectedClient();
    const listed = await client.listPrompts();

    const names = listed.prompts.map((p) => p.name).sort();
    expect(names).toEqual(
      ['daily-review', 'drive-time', 'job-cost-margin', 'pricebook-health', 'weekly-tech-review'].sort()
    );

    const jobCostMargin = listed.prompts.find((p) => p.name === 'job-cost-margin')!;
    expect(jobCostMargin.arguments).toBeDefined();
    const argNames = jobCostMargin.arguments!.map((a) => a.name);
    expect(argNames).toContain('jobId');
  });

  it('prompts/get on job-cost-margin returns a messages array with the orchestration text', async () => {
    const client = await connectedClient();
    const result = await client.getPrompt({ name: 'job-cost-margin', arguments: { jobId: '999' } });

    expect(result.messages.length).toBeGreaterThan(0);
    const text = (result.messages[0].content as { type: 'text'; text: string }).text;
    expect(text).toContain('job_cost_actuals');
    expect(text).toContain('999');
  });

  it('prompts/get on drive-time with technicianId/startDate/endDate args reflects them in the returned text', async () => {
    const client = await connectedClient();
    const result = await client.getPrompt({
      name: 'drive-time',
      arguments: { technicianId: '7', startDate: '2026-07-01', endDate: '2026-07-07' },
    });

    const text = (result.messages[0].content as { type: 'text'; text: string }).text;
    expect(text).toContain('7');
    expect(text).toContain('tech_drive_time_summary');
  });
});
