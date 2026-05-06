import { describe, it, expect, vi } from 'vitest';
import { handleWebhook } from '../../webhook-ingest';

describe('webhook-ingest', () => {
  function makeEnv(secret: string) {
    const stmt = {
      bind: vi.fn().mockReturnThis(),
      run: vi.fn().mockResolvedValue({ success: true }),
    };
    return {
      ST_WEBHOOK_SECRET: secret,
      DB: { prepare: vi.fn().mockReturnValue(stmt) },
    };
  }

  async function sign(secret: string, message: string): Promise<string> {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
    return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  it('accepts valid HMAC signature', async () => {
    const secret = 'test-secret';
    const payload = JSON.stringify({ eventId: 'evt-123', eventType: 'customerCreated' });
    const sig = await sign(secret, payload);
    const env = makeEnv(secret) as any;

    const req = new Request('http://localhost/webhooks/st', {
      method: 'POST',
      headers: { 'X-ST-Signature': sig },
      body: payload,
    });

    const resp = await handleWebhook(env, req);
    expect(resp.status).toBe(200);
    expect(env.DB.prepare).toHaveBeenCalled();
  });

  it('rejects invalid signature', async () => {
    const secret = 'test-secret';
    const payload = JSON.stringify({ eventId: 'evt-123', eventType: 'customerCreated' });
    const env = makeEnv(secret) as any;

    const req = new Request('http://localhost/webhooks/st', {
      method: 'POST',
      headers: { 'X-ST-Signature': 'invalid-signature' },
      body: payload,
    });

    const resp = await handleWebhook(env, req);
    expect(resp.status).toBe(401);
    const data = await resp.json<{ error: string }>();
    expect(data.error).toBe('invalid_signature');
  });

  it('rejects missing signature', async () => {
    const env = makeEnv('test-secret') as any;
    const payload = JSON.stringify({ eventId: 'evt-123' });

    const req = new Request('http://localhost/webhooks/st', {
      method: 'POST',
      body: payload,
    });

    const resp = await handleWebhook(env, req);
    expect(resp.status).toBe(401);
    const data = await resp.json<{ error: string }>();
    expect(data.error).toBe('missing_signature');
  });

  it('rejects invalid JSON', async () => {
    const secret = 'test-secret';
    const payload = 'not json';
    const sig = await sign(secret, payload);
    const env = makeEnv(secret) as any;

    const req = new Request('http://localhost/webhooks/st', {
      method: 'POST',
      headers: { 'X-ST-Signature': sig },
      body: payload,
    });

    const resp = await handleWebhook(env, req);
    expect(resp.status).toBe(400);
    const data = await resp.json<{ error: string }>();
    expect(data.error).toBe('invalid_json');
  });

  it('rejects missing eventId', async () => {
    const secret = 'test-secret';
    const payload = JSON.stringify({ eventType: 'customerCreated' });
    const sig = await sign(secret, payload);
    const env = makeEnv(secret) as any;

    const req = new Request('http://localhost/webhooks/st', {
      method: 'POST',
      headers: { 'X-ST-Signature': sig },
      body: payload,
    });

    const resp = await handleWebhook(env, req);
    expect(resp.status).toBe(400);
    const data = await resp.json<{ error: string }>();
    expect(data.error).toBe('missing_event_id');
  });

  it('handles INSERT OR IGNORE for duplicate eventId', async () => {
    const secret = 'test-secret';
    const payload = JSON.stringify({ eventId: 'evt-dup', eventType: 'customerCreated' });
    const sig = await sign(secret, payload);
    const env = makeEnv(secret) as any;

    const req = new Request('http://localhost/webhooks/st', {
      method: 'POST',
      headers: { 'X-ST-Signature': sig },
      body: payload,
    });

    const resp = await handleWebhook(env, req);
    expect(resp.status).toBe(200);
    expect(env.DB.prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT OR IGNORE'));
  });

  it('rejects non-POST methods', async () => {
    const env = makeEnv('test-secret') as any;

    const req = new Request('http://localhost/webhooks/st', {
      method: 'GET',
    });

    const resp = await handleWebhook(env, req);
    expect(resp.status).toBe(405);
  });
});

describe('webhook-ingest — event allowlist', () => {
  async function sign(secret: string, message: string): Promise<string> {
    const enc = new TextEncoder();
    const k = await crypto.subtle.importKey(
      'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    );
    const s = await crypto.subtle.sign('HMAC', k, enc.encode(message));
    return Array.from(new Uint8Array(s))
      .map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  function makeEnv() {
    const stmt = {
      bind: vi.fn().mockReturnThis(),
      run: vi.fn().mockResolvedValue({ success: true }),
    };
    return {
      ST_WEBHOOK_SECRET: 'sec',
      DB: { prepare: vi.fn().mockReturnValue(stmt) },
      MCP_METRICS: { writeDataPoint: vi.fn() },
    } as any;
  }

  it('rejects unknown event types with 400', async () => {
    const { handleWebhook } = await import('../../webhook-ingest');
    const env = makeEnv();
    const body = JSON.stringify({ eventId: 'e-1', eventType: 'nonsense' });
    const sig = await sign('sec', body);
    const req = new Request('http://x/webhooks/st', {
      method: 'POST',
      headers: { 'X-ST-Signature': sig },
      body,
    });
    const r = await handleWebhook(env, req);
    expect(r.status).toBe(400);
    const j = await r.json() as any;
    expect(j.error).toBe('unknown_event_type');
    expect(j.received).toBe('nonsense');
  });

  it('reads x-servicetitan-event header in preference to body', async () => {
    const { handleWebhook } = await import('../../webhook-ingest');
    const env = makeEnv();
    const body = JSON.stringify({ eventId: 'e-2', eventType: 'thiswillbeoverridden', data: {} });
    const sig = await sign('sec', body);
    const req = new Request('http://x/webhooks/st', {
      method: 'POST',
      headers: { 'X-ST-Signature': sig, 'x-servicetitan-event': 'jobCompleted' },
      body,
    });
    const r = await handleWebhook(env, req);
    expect(r.status).toBe(200);
    // The bind() call should have received 'jobCompleted' as the event_type column
    const stmtCall = (env.DB.prepare as any).mock.results[0].value.bind.mock.calls[0];
    expect(stmtCall[1]).toBe('jobCompleted');
  });

  it('emits a metric on accepted event with eventType in indexes', async () => {
    const { handleWebhook } = await import('../../webhook-ingest');
    const env = makeEnv();
    const body = JSON.stringify({ eventId: 'e-3', eventType: 'paymentReceived' });
    const sig = await sign('sec', body);
    const req = new Request('http://x/webhooks/st', {
      method: 'POST',
      headers: { 'X-ST-Signature': sig },
      body,
    });
    const r = await handleWebhook(env, req);
    expect(r.status).toBe(200);
    expect(env.MCP_METRICS.writeDataPoint).toHaveBeenCalledTimes(1);
    const point = (env.MCP_METRICS.writeDataPoint as any).mock.calls[0][0];
    expect(point.indexes).toContain('paymentReceived');
  });
});
