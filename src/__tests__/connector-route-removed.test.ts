// ============================================================
// connector-route-removed.test.ts — the `/c/<token>/mcp` route must stay gone
// (QUA-1117 item 3, deleted 2026-08-01).
//
// WHAT WAS WRONG. The route put the credential in the URL path, because Claude
// Desktop's connector UI accepts only a URL and cannot send a header. Two
// consequences, the second worse than the first:
//
//   1. A URL-borne secret leaks through browser history, proxy logs and
//      referrer headers — none of which this worker controls.
//   2. The token carried its OWN role (src/index.ts:312 at the time). A row
//      minted role:'default' resolved to `default` and reached all 24 write
//      tools, so the read-only guarantee the connector existed to provide could
//      be bypassed by whoever minted the token.
//
// WHY THIS IS A SOURCE-LEVEL TEST. The 2026-08-01 audit found the route
// answering 401, not 404, on both workers — still compiled and reachable,
// disabled only by an unset secret. "Disabled by configuration" is exactly the
// state this guard exists to prevent recurring, and a behavioural unit test
// cannot distinguish "route deleted" from "route present but denying". So the
// assertion is on the source, and the *behavioural* gate is
// scripts/probe-connector-guards.sh section 1, which hits the deployed workers
// and requires a literal 404.
//
// If a header-authenticated connector path is ever needed again, add it under
// /mcp with a credential the caller cannot choose a role with — do not
// resurrect a path-token route to satisfy a client UI limitation.
// ============================================================
import { describe, it, expect } from 'vitest';
import indexSrc from '../index.ts?raw';
import authSrc from '../auth.ts?raw';
import * as auth from '../auth';

describe('/c/<token>/mcp stays deleted', () => {
  it('index.ts registers no /c/<token>/mcp path matcher', () => {
    // The exact matcher that used to be there, plus the general shape, so a
    // rename of the capture group does not slip past.
    expect(indexSrc).not.toMatch(/pathname\.match\(\s*\/\^\\\/c\\\//);
    expect(indexSrc).not.toMatch(/\/\^\\\/c\\\/\(\[A-Za-z0-9_-\]\+\)\\\/mcp\$\//);
  });

  it('exposes no connector-token verifier', () => {
    // Runtime check first — this is the one that cannot be fooled by a comment.
    expect(Object.keys(auth)).not.toContain('verifyConnectorToken');
    expect(authSrc).not.toMatch(/export\s+(async\s+)?function\s+verifyConnectorToken/);
    expect(indexSrc).not.toMatch(/\bverifyConnectorToken\b\s*\(/);
  });

  it('has no connector-specific 401 responder left behind', () => {
    // A 401 responder for this route is the signature of "secret-gated but
    // still compiled" — the precise state the audit caught.
    expect(indexSrc).not.toMatch(/function\s+unauthorizedConnectorResponse/);
  });
});
