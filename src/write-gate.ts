// ============================================================
// write-gate.ts — dryRun + HMAC confirmation token flow.
//
// Two-phase API:
//   WriteGate.dryRun(tool, args, actor, correlation, payload, …, tokenTtlMs?)
//     → issues token + calls taylor-ai /api/st/write?dryRun=1 for echo.
//   WriteGate.verifyToken(tool, args, actor, confirmation_token)
//     → throws on invalid/expired/consumed. Caller then executes the real write.
//
// Default TTL is 15 min (extended from original 5-min) to cover LLM thinking
// time between dryRun and confirm — composite L5 reads run in that window. Tools
// that don't need that buffer (automated pricebook scripts) can pass a shorter
// `tokenTtlMs`. MAX_TOKEN_TTL_MS is an absolute hard ceiling — no per-tool override
// can exceed it; it also acts as the in-memory early-reject so a clearly stale
// token can fail without a D1 round-trip.
// ============================================================

import type { Env } from './env';

export const DEFAULT_TOKEN_TTL_MS = 15 * 60 * 1000;
export const MAX_TOKEN_TTL_MS = 15 * 60 * 1000;

// Backward-compat re-export. Older callers (tests, docs) still reference TOKEN_TTL_MS.
export const TOKEN_TTL_MS = DEFAULT_TOKEN_TTL_MS;

async function hmacSign(key: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey(
    'raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', k, enc.encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function hmacVerify(key: string, message: string, expected: string): Promise<boolean> {
  const actual = await hmacSign(key, message);
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export async function hashArgs(args: Record<string, unknown>): Promise<string> {
  const json = JSON.stringify(args, Object.keys(args).sort());
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(json));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export interface DryRunResult {
  dryRun: true;
  tool: string;
  payload: unknown;
  st_endpoint: string;
  st_method: string;
  confirmation_token: string;
  expires_in_seconds: number;
}

export class WriteGate {
  constructor(private env: Env) {}

  // Phase 1: issue a dryRun response with confirmation token.
  // taylor-ai /api/st/write does not support ?dryRun=1 (would call ST for real),
  // so we echo the payload locally. Zod already validated inputs; no further
  // pre-flight needed.
  //
  // Per-tool TTL: pass `tokenTtlMs` to shorten the window for tools that don't
  // need 15 min of LLM-rumination buffer (e.g., automated pricebook writes).
  // The value is capped at MAX_TOKEN_TTL_MS — no override can exceed the hard ceiling.
  async dryRun(
    tool: string,
    args: Record<string, unknown>,
    actor: string,
    correlation: string,
    payload: unknown,
    stEndpoint: string,
    stMethod: string,
    tokenTtlMs?: number
  ): Promise<DryRunResult> {
    const ttlMs = Math.min(tokenTtlMs ?? DEFAULT_TOKEN_TTL_MS, MAX_TOKEN_TTL_MS);
    const argsHash = await hashArgs(args);
    const issuedAt = Date.now();
    // Percent-encode '|' in actor to prevent pipe-injection when splitting the token envelope.
    const safeActor = actor.replace(/\|/g, '%7C');
    const tokenMessage = `${tool}|${argsHash}|${safeActor}|${issuedAt}`;
    const tokenHmac = await hmacSign(this.env.MCP_SYNC_KEY, tokenMessage);
    const token = `${tokenMessage}|${tokenHmac}`;
    const tokenHash = await hashArgs({ token });

    await this.env.DB.prepare(
      `INSERT OR IGNORE INTO confirmation_tokens (token_hash, tool, args_hash, actor, issued_at, expires_at, correlation)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(tokenHash, tool, argsHash, actor, issuedAt, issuedAt + ttlMs, correlation).run();

    return { dryRun: true, tool, payload, st_endpoint: stEndpoint, st_method: stMethod, confirmation_token: token, expires_in_seconds: ttlMs / 1000 };
  }

  // Phase 2: verify + consume token. Throws if invalid/expired/consumed/args-changed.
  // Caller proceeds to actual write after this returns without throwing.
  async verifyToken(
    tool: string,
    args: Record<string, unknown>,
    actor: string,
    confirmation_token: string
  ): Promise<void> {
    const parts = confirmation_token.split('|');
    if (parts.length !== 5) throw new Error('malformed confirmation_token');
    const [tokenTool, argsHash, tokenActor, issuedAtStr, tokenHmac] = parts;
    const issuedAt = parseInt(issuedAtStr, 10);
    const safeActor = actor.replace(/\|/g, '%7C');

    if (tokenTool !== tool) throw new Error('confirmation_token is for a different tool');
    if (tokenActor !== safeActor) throw new Error('confirmation_token actor mismatch');
    // Early in-memory reject for clearly stale tokens. The per-tool TTL is
    // enforced via D1 expires_at below — this guard just avoids the DB round-trip
    // for tokens that can't survive the absolute ceiling regardless of override.
    if (Date.now() - issuedAt > MAX_TOKEN_TTL_MS) throw new Error('confirmation_token expired');

    const valid = await hmacVerify(this.env.MCP_SYNC_KEY, `${tokenTool}|${argsHash}|${tokenActor}|${issuedAtStr}`, tokenHmac);
    if (!valid) throw new Error('confirmation_token signature invalid');

    const currentArgsHash = await hashArgs(args);
    if (currentArgsHash !== argsHash) throw new Error('args changed since dryRun — re-run dryRun with current args');

    const tokenHash = await hashArgs({ token: confirmation_token });
    const row = await this.env.DB.prepare(
      'SELECT consumed_at, expires_at FROM confirmation_tokens WHERE token_hash = ? AND tool = ?'
    ).bind(tokenHash, tool).first<{ consumed_at: number | null; expires_at: number }>();

    if (!row) throw new Error('confirmation_token not found — it may have expired from D1');
    if (row.consumed_at) throw new Error('confirmation_token already used');
    // D1 expires_at is the authoritative per-tool TTL window. A tool that issued
    // with tokenTtlMs=5min sets expires_at = issuedAt + 5min; this catches tokens
    // past their per-tool window even though they're still under MAX_TOKEN_TTL_MS.
    if (Date.now() > row.expires_at) throw new Error('confirmation_token expired (per-tool TTL)');

    await this.env.DB.prepare(
      'UPDATE confirmation_tokens SET consumed_at = ? WHERE token_hash = ?'
    ).bind(Date.now(), tokenHash).run();
  }
}
