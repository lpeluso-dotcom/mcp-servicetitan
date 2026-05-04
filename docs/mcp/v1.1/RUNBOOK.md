# mcp-servicetitan v1.1 — Operator Runbook

Quick-reference for the most common diagnostic and recovery procedures. Source code in `<repo>`. Prod URL: `https://mcp-servicetitan.example.workers.dev`. Dev URL: `https://mcp-servicetitan-dev.example.workers.dev`.

## 1. "Is mcp-servicetitan healthy?"

```bash
# Liveness + tool count
curl https://mcp-servicetitan.example.workers.dev/health | jq '{ok, version, toolCount}'
```

Expected: `{ok: true, version: "1.0.0", toolCount: 62}`. If `toolCount` differs, registry has drifted.

## 2. "Why is the audit_log empty?"

The most common false alarm. **Before diagnosing the wiring**, check the active client URL.

```bash
# Active client URL
jq '.mcpServers["mcp-servicetitan"].url' ~/.claude.json
```

If it's `mcp-servicetitan-dev.example.workers.dev`, prod will look silent because nothing is calling it. Same key, different worker — flip the URL or accept that prod is intentionally idle.

After the URL check, hit the probe:

```bash
curl -H "X-Sync-Key: $MCP_SYNC_KEY" \
  https://mcp-servicetitan.example.workers.dev/admin/health/audit | jq .
```

The `_hint` field will repeat this advice when `is_silent: true`.

If the URL is correct **and** Claude Code has been making calls **and** the probe still says silent, then it's a real wiring regression — see §6.

## 3. "Show me the last hour of activity"

```bash
curl -H "X-Sync-Key: $MCP_SYNC_KEY" \
  https://mcp-servicetitan.example.workers.dev/admin/metrics | jq .
```

Returns `{period_1h: {calls, errors, avg_latency_ms}, top_tools_24h, errors_1h}`. p50/p95/p99 lives in the Cloudflare Analytics Engine dashboard (`mcp_servicetitan_metrics` dataset).

## 4. "Inspect a specific failure"

D1 query against your configured `DB` binding:

```sql
-- Latest 20 errors
SELECT datetime(ts/1000,'unixepoch') AS at, source, severity, message, correlation
FROM error_log ORDER BY ts DESC LIMIT 20;

-- All audit rows for a given correlation
SELECT datetime(ts/1000,'unixepoch') AS at, status, operation, latency_ms
FROM audit_log WHERE correlation = ? ORDER BY ts;
```

When a composite returns a partial result, the audit row has `status='partial'` and a parallel `error_log` row at `severity='warn'` carries the per-call `failures` array in `context`. The audit row's payload field truncates at 4000 chars; the error_log row is the durable forensic record.

## 5. "Run a smoke test"

```bash
bash scripts/inspector-smoke.sh dev    # or prod
```

Three checks: `tools/list >= 60`, `st_list_customers` round-trip, `add_customer_note` dryRun envelope. Any failure dumps the stderr log path so you can read what Inspector actually saw. Built into preflight via `REMOTE=1`.

## 6. "I think the wiring is broken"

The wiring is in [src/tool-registry.ts:55-104](../../../src/tool-registry.ts#L55-L104). It writes one `audit_log` row per tool call (status `ok`/`error`/`partial`), one `error_log` row on error, one heartbeat per call. Every fire-and-forget via `execCtx.waitUntil`.

Diagnostic order:
1. **Bindings:** `npx wrangler deploy --env dev --dry-run` lists effective bindings — confirm `DB → mcp-servicetitan-dev` and `DB → mcp-servicetitan` for prod.
2. **Force a synthetic call:** `bash scripts/inspector-smoke.sh dev`. Each smoke run produces 3 audit rows.
3. **Query D1 for those rows** — see §4. If the smoke ran but no rows, either the binding is wrong or `obs.audit` is throwing silently (it swallows + console.errors). Check Cloudflare Workers Logs.

The 2026-04-26 cutover-trap incident: prod looked silent for 3 days because `~/.claude.json` was pointing at dev. Wiring was fine; client config was wrong. **Always check the URL before re-threading observability.**

## 7. "I need to roll back v1.1"

```bash
# Roll back to v1.0 last-green
git checkout main
npx wrangler deploy --env dev    # then prod once verified
```

Migrations don't need rolling back — v1.1 is purely additive (one new endpoint `/admin/health/audit`, one deleted file `marketing_roas.ts`, one new helper module, one new factory module). No schema changes since v1.0 cutover.

If you need a fast bail-out at the worker layer, redeploy a prior version directly:

```bash
npx wrangler rollback              # interactive; pick the prior version ID
```

Per-cut version IDs were:
- Cut 1 (F1): `9e749edf-…` (rolled into Cut 2)
- Cut 2 (F-tranche): `9e749edf-604c-4b79-b253-6105251b7660` (prod)
- Cut 3 (H1+H3): `2fb20b29-a778-466f-827a-34dd20f107c5` (prod)

## 8. "I need to handle a Make-scenario regression"

Make scenario `4670072` (`[DEPRECATED] ST API Writer`) was the legacy ST writer before mcp-servicetitan + servicetitan-proxy `/api/st/write`. Per plan, it's marked for manual pause-and-rename in the Make UI but has not been deleted. If a regression in the new write path forces a fallback:

1. Pause + verify the dryRun-token path is fully broken (run inspector-smoke.sh — test #3 confirms the dryRun envelope).
2. Check `error_log` for the failing tool's recent entries (§4).
3. Fix forward — Make 4670072 should not be reactivated. The legacy proxy held hardcoded credentials and the body-drop bug (`service-titan:makeAnApiCall`).

## 9. "How do I add a new write tool?"

After H1, write tools are one-liners over the factory:

```ts
// src/tools/<area>/<name>.ts
import { z } from 'zod';
import { defineWriteTool } from '../../write-tool-factory';

export const <name> = defineWriteTool<{
  // your args + dryRun? + confirmation_token?
}>({
  name: '<name>',
  description: '...',
  zodSchema: { /* business fields only — factory adds dryRun + token */ },
  endpoint: (args) => `/<st-path>`,
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  payload: (args) => ({ /* body */ }),
  businessArgs: (args) => ({ /* HMAC keying material */ }),
});
```

Then register in `src/tools/index.ts`. The factory wires dryRun → 15-min HMAC token → confirm + execute, plus token reuse / tampering / forgery rejection. As of v1.1, `add_customer_note` is the only tool migrated — the rest stay hand-rolled until the soak window concludes (one week from 2026-04-26).

## 10. "How do I add an /admin route?"

Use the shared guard:

```ts
import { requireAdminKey } from './routes/admin-guard';

app.get('/admin/<path>', async (c) => {
  const denied = requireAdminKey(c);
  if (denied) return denied;
  // ...
});
```

Don't inline the `c.req.header('x-sync-key') !== c.env.MCP_SYNC_KEY` check — the guard is the single source of truth.

## Reference

Keep deployment-specific runbooks, drift logs, and private ServiceTitan operating notes outside the public repository.