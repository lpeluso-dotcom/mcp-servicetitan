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
    const payload = JSON.stringify({ eventId: 'evt-123', eventType: 'customer.created' });
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
    const payload = JSON.stringify({ eventId: 'evt-123', eventType: 'customer.created' });
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
    const payload = JSON.stringify({ eventType: 'customer.created' });
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
    const payload = JSON.stringify({ eventId: 'evt-dup', eventType: 'customer.created' });
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
