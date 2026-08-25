// ============================================================
// wrangler-platform-config.test.ts — Wave 2, workstream E.
//
// SCOPE AND HONESTY. These are CONTENT assertions on the committed
// wrangler.toml, read via Vite's `?raw` (the repo's established way to assert
// on a file that a Workers tsconfig cannot reach through node:fs — see
// src/__tests__/connector-route-removed.test.ts). They prove the config SAYS
// the right thing. They do NOT prove Cloudflare ENFORCES it: whether
// `wrangler deploy` actually aborts on a missing secret, whether traces are
// actually sampled at the configured rate, and whether the rate-limit
// namespace actually exists can only be observed against a live account.
// Those are labelled as unverified-offline in the PR.
//
// What these assertions DO buy: the eight-secret comment block cannot silently
// drift out of sync with the enforced list, nobody can land tracing without an
// explicit head_sampling_rate (it is free only through 2026-09-30 and billed
// from 2026-10-01 — an unset rate defaults to 1.0, i.e. 100% of requests), and
// the two prod/dev environments cannot diverge unnoticed.
// ============================================================
import { describe, it, expect } from 'vitest';
import toml from '../../wrangler.toml?raw';

/**
 * Returns the body of a TOML section (everything after the header line, up to
 * the next header line at column 0). `occurrence` selects among repeated
 * `[[array]]` sections.
 */
function section(header: string, occurrence = 0): string {
  const lines = toml.split('\n');
  const wanted = header.trim();
  let seen = -1;
  let body: string[] | null = null;
  for (const line of lines) {
    const isHeader = /^\[\[?[^\]]+\]\]?\s*$/.test(line.trim()) && line === line.trimStart();
    if (isHeader) {
      if (body) break;
      if (line.trim() === wanted) {
        seen += 1;
        if (seen === occurrence) body = [];
      }
      continue;
    }
    if (body) body.push(line);
  }
  return body ? body.join('\n') : '';
}

/** Every `[[kv_namespaces]]`-style section body, in file order. */
function allSections(header: string): string[] {
  const out: string[] = [];
  for (let i = 0; ; i++) {
    const s = section(header, i);
    if (!s) break;
    out.push(s);
  }
  return out;
}

/** Strips `#` comment lines so an assertion cannot be satisfied by a comment. */
function code(s: string): string {
  return s
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
}

// ── Item 1: secrets.required ────────────────────────────────────────────────

// Enumerated from the committed `# Secrets (set with wrangler secret put)`
// comment block and cross-checked against the `// Secrets` group in src/env.ts.
const PROD_SECRETS = [
  'MCP_SYNC_KEY',
  'SIRO_API_TOKEN',
  'ST_WEBHOOK_SECRET',
  'JWT_SECRET',
  'ACCESS_CLIENT_ID',
  'ACCESS_ISSUER',
  'ACCESS_CLIENT_SECRET',
  'SUPABASE_URL',
  'SUPABASE_PB_KEY',
];

describe('[secrets] required — turns the comment block into a deploy gate', () => {
  it('declares a [secrets] section for prod', () => {
    expect(code(section('[secrets]'))).toMatch(/required\s*=/);
  });

  it('lists every prod secret the worker reads', () => {
    const body = code(section('[secrets]'));
    for (const name of PROD_SECRETS) {
      expect(body, `missing ${name} from secrets.required`).toContain(`"${name}"`);
    }
  });

  it('declares [env.dev.secrets] explicitly rather than relying on inheritance', () => {
    // Whether a named environment inherits top-level `secrets` is not something
    // this repo should have to guess at: state it outright for both.
    expect(code(section('[env.dev.secrets]'))).toMatch(/required\s*=/);
  });

  it('omits SUPABASE_* from the dev required list', () => {
    // wrangler.toml already documents that the dev cron is "a harmless no-op if
    // dev secrets are unset". Requiring them would turn that documented no-op
    // into a hard dev-deploy failure.
    const dev = code(section('[env.dev.secrets]'));
    expect(dev).not.toContain('"SUPABASE_URL"');
    expect(dev).not.toContain('"SUPABASE_PB_KEY"');
    expect(dev).toContain('"MCP_SYNC_KEY"');
    expect(dev).toContain('"ACCESS_CLIENT_SECRET"');
  });

  it('names no secret that src/env.ts does not declare', async () => {
    const envSrc = (await import('../env.ts?raw')).default;
    const declared = [...code(section('[secrets]')).matchAll(/"([A-Z0-9_]+)"/g)].map((m) => m[1]);
    expect(declared.length).toBeGreaterThan(0);
    for (const name of declared) {
      expect(envSrc, `${name} is required at deploy but absent from src/env.ts`).toMatch(
        new RegExp(`\\b${name}\\??\\s*:`)
      );
    }
  });
});

// ── Item 2: observability.traces ────────────────────────────────────────────

describe('[observability.traces] — enabled with an EXPLICIT sampling rate', () => {
  for (const [label, header] of [
    ['prod', '[observability.traces]'],
    ['dev', '[env.dev.observability.traces]'],
  ] as const) {
    it(`${label}: enabled = true`, () => {
      expect(code(section(header))).toMatch(/^\s*enabled\s*=\s*true\s*$/m);
    });

    it(`${label}: head_sampling_rate is set explicitly and is a valid 0..1 fraction`, () => {
      const m = code(section(header)).match(/^\s*head_sampling_rate\s*=\s*([0-9.]+)\s*$/m);
      expect(m, `${label} traces must not rely on the 1.0 default — billing starts 2026-10-01`)
        .not.toBeNull();
      const rate = Number(m![1]);
      expect(rate).toBeGreaterThan(0);
      expect(rate).toBeLessThanOrEqual(1);
    });
  }

  it('leaves the plain [observability] enabled flag intact for both envs', () => {
    expect(code(section('[observability]'))).toMatch(/enabled\s*=\s*true/);
    expect(code(section('[env.dev.observability]'))).toMatch(/enabled\s*=\s*true/);
  });

  it('does NOT remove the audit_log or error_log D1 tables in this change', () => {
    // audit_log is a compliance record for a two-phase-confirm write system,
    // not telemetry. Tracing makes error_log arguably redundant; it makes
    // audit_log nothing of the sort. Neither is retired here.
    expect(toml).not.toMatch(/DROP\s+TABLE/i);
  });
});

// ── Item 3: MCP_CACHE KV namespace ──────────────────────────────────────────

describe('MCP_CACHE KV namespace — the D1 mcp_cache replacement', () => {
  it('binds MCP_CACHE in both prod and dev', () => {
    const prod = allSections('[[kv_namespaces]]');
    const dev = allSections('[[env.dev.kv_namespaces]]');
    expect(prod.some((s) => /binding\s*=\s*"MCP_CACHE"/.test(s))).toBe(true);
    expect(dev.some((s) => /binding\s*=\s*"MCP_CACHE"/.test(s))).toBe(true);
  });

  it('keeps PROXY_STATE and OAUTH_KV bound and distinct from MCP_CACHE', () => {
    const bindings = allSections('[[kv_namespaces]]')
      .map((s) => s.match(/binding\s*=\s*"([^"]+)"/)?.[1])
      .filter(Boolean);
    expect(bindings).toEqual(expect.arrayContaining(['PROXY_STATE', 'OAUTH_KV', 'MCP_CACHE']));
    expect(new Set(bindings).size).toBe(bindings.length); // no duplicate binding names
  });

  it('ships the cutover flag defaulted OFF in both envs', () => {
    // CACHE_BACKEND unset (or "d1") == today's behaviour, byte for byte.
    // Landing the KV path dark is the whole point of a staged cutover.
    const prodVars = code(section('[vars]'));
    const devVars = code(section('[env.dev.vars]'));
    expect(prodVars).toMatch(/^\s*CACHE_BACKEND\s*=\s*"d1"\s*$/m);
    expect(devVars).toMatch(/^\s*CACHE_BACKEND\s*=\s*"(d1|dual)"\s*$/m);
  });
});

// ── Item 6: native [[ratelimits]] binding ───────────────────────────────────

describe('[[ratelimits]] — per-caller edge abuse protection at /mcp', () => {
  for (const [label, header] of [
    ['prod', '[[ratelimits]]'],
    ['dev', '[[env.dev.ratelimits]]'],
  ] as const) {
    it(`${label}: binds MCP_EDGE_RL with a namespace_id`, () => {
      const body = code(section(header));
      expect(body).toMatch(/name\s*=\s*"MCP_EDGE_RL"/);
      // namespace_id is a STRING containing a positive integer, per the docs.
      expect(body).toMatch(/namespace_id\s*=\s*"[1-9][0-9]*"/);
    });
  }

  for (const [label, header] of [
    ['prod', '[ratelimits.simple]'],
    ['dev', '[env.dev.ratelimits.simple]'],
  ] as const) {
    it(`${label}: simple.period is 10 or 60 (the only values the binding accepts)`, () => {
      const period = code(section(header)).match(/period\s*=\s*(\d+)/)?.[1];
      expect([`10`, `60`]).toContain(period);
    });

    it(`${label}: simple.limit is a positive integer`, () => {
      const limit = Number(code(section(header)).match(/limit\s*=\s*(\d+)/)?.[1]);
      expect(limit).toBeGreaterThan(0);
    });
  }

  it('does NOT touch the StRateLimiter DO bindings (different problem, different layer)', () => {
    // The native binding is per-Cloudflare-location and eventually consistent —
    // Cloudflare's own docs say it is "intentionally designed to not be used as
    // an accurate accounting system". It cannot enforce a GLOBAL ServiceTitan
    // quota, so it replaces nothing.
    expect(toml).toMatch(/class_name = "StRateLimiter"/);
    expect(toml.match(/name = "ST_RATE_LIMITER"/g)).toHaveLength(2); // prod + dev
  });
});

// ── Pre-existing invariants that must survive this change ───────────────────

describe('nothing already true was "fixed"', () => {
  it('smart placement is still set for prod and dev', () => {
    expect(toml.match(/placement = \{ mode = "smart" \}/g)).toHaveLength(2);
  });

  it('no real employee address was reintroduced (audit S-8)', () => {
    expect(toml).not.toMatch(/@qualityservicecompany\.net/);
    expect(toml.match(/^ALLOWED_EMAILS = "allowed@example\.com"$/gm)).toHaveLength(2);
  });
});
