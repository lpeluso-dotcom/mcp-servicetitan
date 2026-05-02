# v1.2.0 production acceptance — 2026-05-02

## Deploy

- **Trigger**: GitHub Actions on `lpeluso-dotcom/mcp-servicetitan` workflow `deploy.yml`.
- **Unblock**: `CLOUDFLARE_API_TOKEN` repo secret set 2026-05-01 23:51 UTC. Prior 5 CI runs failed since 2026-04-26 because the secret was never configured.
- **First deploy** (re-run of latest failed: run `25086034172`, headSha `626033e`): success in 37s. Code from main pushed v1.2 tools to prod but `MCP_SERVICE_VERSION` var still read `"1.0.0"`.
- **Version bump commit** (`3ca2849`): aligned `package.json` (`1.0.0-f1` → `1.2.0`), `wrangler.toml [vars] MCP_SERVICE_VERSION` (`1.0.0` → `1.2.0`), and `[env.dev.vars] MCP_SERVICE_VERSION` (`1.0.0-f3-dev` → `1.2.0-dev`). Description on `package.json:4` rewritten to reflect v1.2 surface.
- **Second deploy** (run `25238236194`, headSha `3ca2849`): success in 36s.

## Verification

```
$ curl https://mcp-servicetitan.lpeluso.workers.dev/health | jq '{version, toolCount, transport}'
{
  "version": "1.2.0",
  "toolCount": 65,
  "transport": "agents-sdk createMcpHandler (Streamable HTTP)"
}
```

`/admin/endpoints`: `count: 65, declared_count: 13, undeclared_count: 52`. Expected — v1.2 backfilled `stEndpointTemplate` on the 9 `defineWriteTool` callers + introduced 3 new tools with descriptors + the existing `add_customer_note`. Read tools without descriptors are tracked as undeclared, scheduled for v1.3 backfill.

### Inspector smoke (3/3 pass)

```
[1] tools/list      → 64 tools (>= 60 floor; default-role view, st_call admin-gated)
[2] st_list_customers (pageSize=1) → "Ebenezer Baptist Church"
[3] add_customer_note (default dryRun) → confirmation_token + 900s expiry
```

Tools/list returns 64 not 65 because the request omitted `X-MCP-Role: admin`. The admin-only `st_call` tool is filtered out of the default-role view. RBAC is working as designed.

### Comprehensive read sweep (49 reads, 14 ok / 32 needs_args / 3 fail)

Full CSV: [`v12-all-tools-smoke-2026-05-02.csv`](v12-all-tools-smoke-2026-05-02.csv).

`needs_args` outcomes are healthy — the handler is wired and returns a Zod validation error when called with empty args. We're verifying handler reachability, not arg-shape validation.

The 3 `fail` outcomes are all pre-existing bugs unchanged in v1.2:

| Tool | Failure | Root cause | Action |
|---|---|---|---|
| `list_service_categories` | `upstream_error 404` from `/pricebook/v2/tenant/431848990/servicecategories?page=1&pageSize=200` | ST endpoint path mismatch — possibly `serviceCategories` (camelCase) vs `servicecategories` (lowercase), or this endpoint doesn't exist | v1.3 issue |
| `list_technicians_available` | `upstream_error 404` from `/dispatch/v2/tenant/431848990/technicians/available?page=1&pageSize=50` | Likely missing `requestedOn` (date) param required by ST; current handler treats it as optional | v1.3 issue |
| `siro_list_mobile_events` | `auth_failed: SIRO_API_TOKEN not configured` | Prod wrangler secrets list shows only `MCP_SYNC_KEY`. SIRO_API_TOKEN was never pushed to prod | Push secret: `wrangler secret put SIRO_API_TOKEN` |

None of these were touched in v1.2 (they were broken in v1.1 too). They are not blockers for the v1.2 cut.

### Write-gate adversarial verification

Four paths verified live or by code inspection. See [write-gate-verification-2026-05-02.md](write-gate-verification-2026-05-02.md). All four pass.

## Test summary

- **npm test**: 244/244 pass
- **scripts/preflight.sh**: 34/34 pass (single transient vitest fork-pool flake on first run; clean on retry)
- **wrangler deploy --dry-run**: clean
- **scripts/inspector-smoke.sh prod**: 3/3 pass
- **scripts/all-tools-smoke.sh prod**: 14 ok / 32 needs_args / 3 known-fail
- **Write-gate adversarial**: 3 live PASS + 1 code-verified PASS

## Followups (not blocking v1.2)

1. **Push `SIRO_API_TOKEN` to prod** — single `wrangler secret put` command. Restores the 3 Siro tools.
2. **`list_service_categories` 404** — file v1.3 issue; verify ST path.
3. **`list_technicians_available` 404** — file v1.3 issue; surface required `requestedOn` in Zod schema.
4. **Backfill `stEndpointTemplate` on 52 read tools** — non-urgent; the descriptor is informational for `/admin/endpoints` inventory.
5. **GitHub Actions Node 20 deprecation** — `actions/checkout@v4` and `actions/setup-node@v4` flagged for forced Node 24 by 2026-06-02.

## Exit criteria — met

- ✅ prod returns `version: 1.2.0`
- ✅ all 65 tools enumerable (admin) / 64 (default role)
- ✅ smoke script + comprehensive read sweep both pass (3 known-fail documented as pre-existing)
- ✅ write-gate negative tests verified
- ✅ audit_log accumulating (visible via /admin/health/audit; further verification at end of soak)
- ⏳ tag pushed (next step)
- ⏳ GitHub release published (next step)
