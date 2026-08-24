// ============================================================
// Tests for the 2026-05-03 security audit hardening:
//   - redactPayload (PII + credential denylist for audit_log.payload)
//   - jsonTruncate (audit truncation marker)
//   - safeContext  (error_log.context allowlist)
//
// Background: the original obs path called JSON.stringify(...).slice(0, 4000)
// directly with raw tool args, which routinely contained customer phone /
// email / name / address. The audit log row is gated behind MCP_SYNC_KEY but
// is still a soft-target if any future read endpoint (or D1 export) lands.
// ============================================================

import { describe, it, expect } from 'vitest';
import {
  redactPayload,
  CREDENTIAL_FIELD_PATTERNS,
  PII_FIELD_PATTERNS,
} from '../../tool-registry';
import { jsonTruncate, safeContext } from '../../obs';
import { safeActorHeader } from '../../auth';

describe('redactPayload', () => {
  it('redacts known PII field names', () => {
    const out = redactPayload({
      customerId: 12345,
      phone: '8435551234',
      email: 'jane@example.com',
      name: 'Jane Smith',
      city: 'Florence',
      note: 'callback at 5pm',
    }) as Record<string, string | number>;
    expect(out.customerId).toBe(12345);
    expect(out.phone).toBe('[redacted:str:10]');
    expect(out.email).toBe('[redacted:str:16]');
    expect(out.name).toBe('[redacted:str:10]');
    expect(out.city).toBe('[redacted:str:8]');
    expect(out.note).toBe('[redacted:str:15]');
  });

  it('redacts nested PII fields by name', () => {
    const out = redactPayload({
      customer: { id: 7, firstName: 'Jane', lastName: 'Smith', phoneNumber: '5551212' },
    }) as { customer: Record<string, unknown> };
    expect(out.customer.id).toBe(7);
    expect(out.customer.firstName).toBe('[redacted:str:4]');
    expect(out.customer.lastName).toBe('[redacted:str:5]');
    expect(out.customer.phoneNumber).toBe('[redacted:str:7]');
  });

  it('preserves arrays and non-PII fields', () => {
    const out = redactPayload({
      ids: [1, 2, 3],
      status: 'Scheduled',
      from: '2026-05-03',
    }) as Record<string, unknown>;
    expect(out.ids).toEqual([1, 2, 3]);
    expect(out.status).toBe('Scheduled');
    expect(out.from).toBe('2026-05-03');
  });

  it('caps recursion to prevent pathological deep payloads', () => {
    const deep: Record<string, unknown> = {};
    let cur: Record<string, unknown> = deep;
    for (let i = 0; i < 20; i++) {
      const next: Record<string, unknown> = {};
      cur.next = next;
      cur = next;
    }
    cur.phone = '8435551234';
    const out = redactPayload(deep);
    expect(JSON.stringify(out)).toContain('depth-limit');
  });

  it('returns primitives untouched', () => {
    expect(redactPayload(null)).toBe(null);
    expect(redactPayload(undefined)).toBe(undefined);
    expect(redactPayload(42)).toBe(42);
    expect(redactPayload('hello')).toBe('hello');
  });
});

describe('jsonTruncate', () => {
  it('passes short payloads through unchanged', () => {
    const out = jsonTruncate({ tool: 'find_customer', ok: true });
    expect(out).toBe('{"tool":"find_customer","ok":true}');
  });

  it('marks truncated payloads with _truncated=true and original length', () => {
    const big = { x: 'a'.repeat(5000) };
    const out = jsonTruncate(big, 1000);
    expect(out).not.toBeNull();
    const parsed = JSON.parse(out as string);
    expect(parsed._truncated).toBe(true);
    expect(typeof parsed._orig_length).toBe('number');
    expect(parsed._orig_length).toBeGreaterThan(1000);
  });

  it('returns null for null/undefined input', () => {
    expect(jsonTruncate(null)).toBeNull();
    expect(jsonTruncate(undefined)).toBeNull();
  });

  it('survives circular structures via try/catch', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const out = jsonTruncate(circular);
    expect(out).toBe('{"_serialize_failed":true}');
  });
});

describe('safeContext', () => {
  it('keeps allowlisted keys', () => {
    const out = safeContext({
      actor: 'claude-code',
      correlation: 'abc-123',
      code: 'upstream_error',
      latency_ms: 137,
    });
    expect(out.actor).toBe('claude-code');
    expect(out.correlation).toBe('abc-123');
    expect(out.code).toBe('upstream_error');
    expect(out.latency_ms).toBe(137);
    expect(out._dropped_keys).toBeUndefined();
  });

  it('drops unknown keys and surfaces them in _dropped_keys', () => {
    const out = safeContext({
      actor: 'claude-code',
      args: { phone: '5551212' },
      env: { MCP_SYNC_KEY: 'should-never-leak' },
      request: { headers: {} },
    });
    expect(out.actor).toBe('claude-code');
    expect(out.args).toBeUndefined();
    expect(out.env).toBeUndefined();
    expect(out.request).toBeUndefined();
    expect((out._dropped_keys as string[]).sort()).toEqual(['args', 'env', 'request']);
  });

  it('handles non-object input gracefully', () => {
    expect(safeContext(null)).toEqual({});
    expect(safeContext(undefined)).toEqual({});
    expect(safeContext('string')).toEqual({});
    expect(safeContext(42)).toEqual({});
  });
});

describe('safeActorHeader', () => {
  it('passes valid actors through unchanged', () => {
    expect(safeActorHeader('claude-code')).toBe('claude-code');
    expect(safeActorHeader('test_actor')).toBe('test_actor');
    expect(safeActorHeader('retell:agent_042204c3bac')).toBe('retell:agent_042204c3bac');
    expect(safeActorHeader('Service.Account_v2')).toBe('Service.Account_v2');
  });

  it('falls back to claude-code on missing or empty header', () => {
    expect(safeActorHeader(null)).toBe('claude-code');
    expect(safeActorHeader('')).toBe('claude-code');
  });

  it('rejects log-injection / header-smuggle / overlong values', () => {
    expect(safeActorHeader('admin\r\nX-Sync-Key: leaked')).toBe('claude-code');
    expect(safeActorHeader('admin\nset-cookie: x=1')).toBe('claude-code');
    expect(safeActorHeader('actor with spaces')).toBe('claude-code');
    expect(safeActorHeader('a'.repeat(128))).toBe('claude-code');
    expect(safeActorHeader('admin/../etc/passwd')).toBe('claude-code');
    expect(safeActorHeader('unicode-‼️')).toBe('claude-code');
  });
});

// ============================================================
// Credential hardening (workstream D item 3).
//
// The original denylist was PII-only — phone / email / name / address /
// free text. It stripped ZERO credential-shaped keys, so anything a tool
// took named `token`, `client_secret`, `authorization` or an `X-Sync-Key`
// header echo landed VERBATIM in the D1 `audit_log.payload` column, which
// records every tool call. Access to that row is gated behind MCP_SYNC_KEY,
// but a log that stores the key material protecting it is a circular
// defense; this is the defense-in-depth layer that breaks the circle.
//
// The list is deliberately ENUMERATED, not a bare /key/i: `keyName`,
// `foreignKey`, `keys` and `keyword` are ordinary field names, and a
// denylist that eats them makes audit rows unreadable for no security gain.
// ============================================================

describe('redactPayload — credential-shaped keys', () => {
  it('redacts the credential key names an ST/MCP payload can plausibly carry', () => {
    const out = redactPayload({
      jobId: 4821,
      secret: 'sh-abc',
      token: 'tok_live_123',
      api_key: 'ak_1',
      apiKey: 'ak_2',
      authorization: 'Bearer xyz',
      password: 'hunter2',
      passwd: 'hunter2',
      credential: 'c',
      bearer: 'b',
      cookie: 'sid=1',
      session_id: 's',
      sessionId: 's',
      sync_key: 'k',
      client_secret: 'cs_live_9',
      clientSecret: 'cs_live_9',
      refresh_token: 'rt',
      refreshToken: 'rt',
      access_token: 'at',
      accessToken: 'at',
      jwt: 'ey.j.w',
      signature: 'sig',
      private_key: 'pk',
      privateKey: 'pk',
      salt: 'NaCl',
    }) as Record<string, unknown>;

    // The one non-credential field is untouched, so the audit row stays useful.
    expect(out.jobId).toBe(4821);

    for (const [k, v] of Object.entries(out)) {
      if (k === 'jobId') continue;
      expect(String(v), `key \`${k}\` was NOT redacted`).toMatch(/^\[redacted:str:\d+\]$/);
    }
  });

  it('redacts an `X-Sync-Key`-shaped header key (hyphen separator)', () => {
    const out = redactPayload({
      headers: { 'X-Sync-Key': 'real-worker-secret', 'X-Correlation-Id': 'abc-123' },
    }) as { headers: Record<string, unknown> };

    expect(out.headers['X-Sync-Key']).toBe('[redacted:str:18]');
    // Correlation IDs are the opposite of secret — they are the whole point
    // of the audit trail and must survive.
    expect(out.headers['X-Correlation-Id']).toBe('abc-123');
  });

  it('redacts credential keys nested in objects and arrays', () => {
    const out = redactPayload({
      items: [{ id: 1, access_token: 'at_1' }, { id: 2, access_token: 'at_22' }],
      auth: { nested: { clientSecret: 'deep' } },
    }) as {
      items: Array<Record<string, unknown>>;
      auth: { nested: Record<string, unknown> };
    };

    expect(out.items[0].id).toBe(1);
    expect(out.items[0].access_token).toBe('[redacted:str:4]');
    expect(out.items[1].access_token).toBe('[redacted:str:5]');
    expect(out.auth.nested.clientSecret).toBe('[redacted:str:4]');
  });

  it('preserves the type-shape tags for non-string credential values', () => {
    const out = redactPayload({ token: 12345, secret: null, cookie: { a: 1 } }) as Record<
      string,
      unknown
    >;
    expect(out.token).toBe('[redacted:num]');
    expect(out.secret).toBe(null);
    expect(out.cookie).toBe('[redacted]');
  });

  it('does NOT over-match ordinary key-ish field names', () => {
    // Asserted against the credential list directly rather than through
    // redactPayload: `keyName` IS redacted end-to-end, but by the
    // PRE-EXISTING PII rule /Name$/i, not by anything credential-shaped.
    // Testing the whole function could not tell those two apart, and the
    // thing that must not regress here is the credential list's precision.
    for (const field of ['keyName', 'foreignKey', 'keys', 'keyword', 'monkey', 'saltwater']) {
      const hit = CREDENTIAL_FIELD_PATTERNS.find((re) => re.test(field));
      expect(hit, `credential pattern ${hit} over-matched \`${field}\``).toBeUndefined();
    }
    // ...and `foreignKey` / `keys` survive the full function too.
    const out = redactPayload({ foreignKey: 'jobs.id', keys: ['a', 'b'] }) as Record<
      string,
      unknown
    >;
    expect(out.foreignKey).toBe('jobs.id');
    expect(out.keys).toEqual(['a', 'b']);
  });

  it('keeps both halves of the denylist non-empty and disjoint in intent', () => {
    // A structural guard: whoever edits one list must not accidentally
    // empty the other (both are spread into the single REDACT list).
    expect(PII_FIELD_PATTERNS.length).toBeGreaterThan(0);
    expect(CREDENTIAL_FIELD_PATTERNS.length).toBeGreaterThan(0);
  });
});
