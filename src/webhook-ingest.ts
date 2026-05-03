import type { Env } from './env';

async function verifyHmacSha256(secret: string, message: string, signature: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const computed = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  const computedHex = Array.from(new Uint8Array(computed)).map(b => b.toString(16).padStart(2, '0')).join('');

  // Constant-time comparison via XOR
  let xorSum = 0;
  const minLen = Math.min(computedHex.length, signature.length);
  for (let i = 0; i < minLen; i++) {
    xorSum |= computedHex.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  xorSum |= computedHex.length ^ signature.length;
  return xorSum === 0;
}

export async function handleWebhook(env: Env, req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'method_not_allowed' }), { status: 405 });
  }

  const signature = req.headers.get('X-ST-Signature');
  if (!signature) {
    return new Response(JSON.stringify({ error: 'missing_signature' }), { status: 401 });
  }

  const body = await req.text();
  const verified = await verifyHmacSha256(env.ST_WEBHOOK_SECRET, body, signature);
  if (!verified) {
    return new Response(JSON.stringify({ error: 'invalid_signature' }), { status: 401 });
  }

  let payload: any;
  try {
    payload = JSON.parse(body);
  } catch {
    return new Response(JSON.stringify({ error: 'invalid_json' }), { status: 400 });
  }

  const eventId = payload.eventId ?? payload.event_id ?? payload.id;
  const eventType = payload.eventType ?? payload.event_type ?? payload.type ?? 'unknown';

  if (!eventId) {
    return new Response(JSON.stringify({ error: 'missing_event_id' }), { status: 400 });
  }

  const receivedAt = Date.now();
  try {
    const stmt = env.DB.prepare(
      'INSERT OR IGNORE INTO webhook_events (event_id, event_type, payload, received_at) VALUES (?, ?, ?, ?)'
    ).bind(String(eventId), String(eventType), body, receivedAt);
    await stmt.run();
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error';
    return new Response(JSON.stringify({ error: msg }), { status: 500 });
  }
}
