import type { Env } from './env';

// ST event types we accept. Source: Velocity n8n trigger node, verified
// 2026-05-06. Add to this set when subscribing to a new event in the ST
// portal. Adding a name here without a portal subscription is a no-op;
// removing one will start rejecting live events with 400.
const ACCEPTED_EVENT_TYPES: ReadonlySet<string> = new Set([
  'appointmentScheduled', // Miss Dawn booking confirmation
  'jobCompleted',         // debrief / reporting trigger
  'paymentReceived',      // payment confirmation
  'customerCreated',      // new lead alerting
]);

async function verifyHmacSha256(secret: string, message: string, signature: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const computed = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  const computedHex = Array.from(new Uint8Array(computed))
    .map((b) => b.toString(16).padStart(2, '0')).join('');

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
  if (!(await verifyHmacSha256(env.ST_WEBHOOK_SECRET, body, signature))) {
    return new Response(JSON.stringify({ error: 'invalid_signature' }), { status: 401 });
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return new Response(JSON.stringify({ error: 'invalid_json' }), { status: 400 });
  }

  const eventId = payload.eventId ?? payload.event_id ?? payload.id;
  // Header takes precedence over body — ST's canonical signal per their portal.
  const headerEvent = req.headers.get('x-servicetitan-event');
  const eventType = String(headerEvent ?? payload.eventType ?? payload.event_type ?? payload.type ?? 'unknown');

  if (!eventId) {
    return new Response(JSON.stringify({ error: 'missing_event_id' }), { status: 400 });
  }
  if (!ACCEPTED_EVENT_TYPES.has(eventType)) {
    return new Response(JSON.stringify({ error: 'unknown_event_type', received: eventType }), { status: 400 });
  }

  const receivedAt = Date.now();
  try {
    const stmt = env.DB.prepare(
      'INSERT OR IGNORE INTO webhook_events (event_id, event_type, payload, received_at) VALUES (?, ?, ?, ?)',
    ).bind(String(eventId), eventType, body, receivedAt);
    await stmt.run();

    // Per-event metric so distribution is queryable in CF Analytics Engine.
    // Index by eventType keeps cardinality low (4 values).
    if (env.MCP_METRICS) {
      env.MCP_METRICS.writeDataPoint({
        indexes: [eventType],
        blobs: ['webhook'],
        doubles: [1],
      });
    }

    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error';
    return new Response(JSON.stringify({ error: msg }), { status: 500 });
  }
}
