// ============================================================
// prompts.test.ts — Phase 2 Task 2.3
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
    const names = PROMPTS.map((p) => p.name);
    expect(names).toEqual([
      'morning-dispatch-brief',
      'job-closeout-review',
      'ar-chase',
      'quote-follow-up',
      'membership-outreach',
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

  it('morning-dispatch-brief orchestrates list_jobs_today, get_capacity, dispatch_pro_alerts_list', () => {
    const p = PROMPTS.find((p) => p.name === 'morning-dispatch-brief')!;
    const text = p.build({ date: '2026-07-09' })[0].content.text;
    expect(text).toContain('list_jobs_today');
    expect(text).toContain('get_capacity');
    expect(text).toContain('dispatch_pro_alerts_list');
    expect(text).toContain('2026-07-09');
  });

  it('job-closeout-review orchestrates job_closeout_report, payroll_job_timesheets_list, job_cost_actuals and includes jobId', () => {
    const p = PROMPTS.find((p) => p.name === 'job-closeout-review')!;
    const text = p.build({ jobId: 123 })[0].content.text;
    expect(text).toContain('job_closeout_report');
    expect(text).toContain('payroll_job_timesheets_list');
    expect(text).toContain('job_cost_actuals');
    expect(text).toContain('123');
  });

  it('ar-chase orchestrates list_unpaid_invoices and get_customer', () => {
    const p = PROMPTS.find((p) => p.name === 'ar-chase')!;
    const text = p.build({ businessUnitId: 456 })[0].content.text;
    expect(text).toContain('list_unpaid_invoices');
    expect(text).toContain('get_customer');
    expect(text).toContain('456');
  });

  it('quote-follow-up orchestrates open_opportunities_pulitzer_feed and assigned_vs_sold_estimate_audit', () => {
    const p = PROMPTS.find((p) => p.name === 'quote-follow-up')!;
    const text = p.build({ daysBack: 30 })[0].content.text;
    expect(text).toContain('open_opportunities_pulitzer_feed');
    expect(text).toContain('assigned_vs_sold_estimate_audit');
    expect(text).toContain('30');
  });

  it('membership-outreach orchestrates list_memberships_expiring and get_customer_membership', () => {
    const p = PROMPTS.find((p) => p.name === 'membership-outreach')!;
    const text = p.build({ window: '60d' })[0].content.text;
    expect(text).toContain('list_memberships_expiring');
    expect(text).toContain('get_customer_membership');
    expect(text).toContain('60d');
  });

  it('quote-follow-up defaults daysBack to 14 when omitted', () => {
    const p = PROMPTS.find((p) => p.name === 'quote-follow-up')!;
    const text = p.build({})[0].content.text;
    expect(text).toContain('14');
  });

  it('membership-outreach defaults window to "30d" when omitted', () => {
    const p = PROMPTS.find((p) => p.name === 'membership-outreach')!;
    const text = p.build({})[0].content.text;
    expect(text).toContain('30d');
  });

  it('morning-dispatch-brief defaults date to "today" when omitted', () => {
    const p = PROMPTS.find((p) => p.name === 'morning-dispatch-brief')!;
    const text = p.build({})[0].content.text;
    expect(text.toLowerCase()).toContain('today');
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
      ['ar-chase', 'job-closeout-review', 'membership-outreach', 'morning-dispatch-brief', 'quote-follow-up'].sort()
    );

    const closeout = listed.prompts.find((p) => p.name === 'job-closeout-review')!;
    expect(closeout.arguments).toBeDefined();
    const argNames = closeout.arguments!.map((a) => a.name);
    expect(argNames).toContain('jobId');
  });

  it('prompts/get on ar-chase returns a messages array with the orchestration text', async () => {
    const client = await connectedClient();
    const result = await client.getPrompt({ name: 'ar-chase', arguments: {} });

    expect(result.messages.length).toBeGreaterThan(0);
    const text = (result.messages[0].content as { type: 'text'; text: string }).text;
    expect(text).toContain('list_unpaid_invoices');
    expect(text).toContain('get_customer');
  });

  it('prompts/get on job-closeout-review with jobId arg reflects it in the returned text', async () => {
    const client = await connectedClient();
    const result = await client.getPrompt({ name: 'job-closeout-review', arguments: { jobId: '999' } });

    const text = (result.messages[0].content as { type: 'text'; text: string }).text;
    expect(text).toContain('999');
    expect(text).toContain('job_closeout_report');
  });
});
