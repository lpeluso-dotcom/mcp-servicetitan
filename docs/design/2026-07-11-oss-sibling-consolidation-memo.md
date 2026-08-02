# Design memo — OSS-sibling consolidation strategy

> **Status:** Decision requested (Luke). **Owner:** Luke Peluso. **Date:** 2026-07-11.
> **Context:** Phase 6 of the mcp-servicetitan upgrade program ([QUA-740](https://linear.app/quality-service-company/issue/QUA-740)). Build is gated to **Phase 7** ([QUA-741](https://linear.app/quality-service-company/issue/QUA-741)) — *only if approved here.*
> **Method:** Three independent adversarial analyses (maintenance/drift, security-boundary, effort/ROI lenses), each grounded by reading both repos. This memo reconciles them.

## The problem

Two related ServiceTitan MCP servers exist, both owned by `lpeluso-dotcom`:

| | `mcp-servicetitan` (internal) | `servicetitan-mcp` (OSS sibling) |
|---|---|---|
| Purpose | QSC production server | Public flag-plant (1st ST server in the MCP registry) |
| Tools | 99 | 76 (a subset) |
| Reads | D1-first via the `taylor-ai` proxy, live-ST fallback | Direct ST OAuth (BYO creds), no proxy/D1 |
| Writes | Two-phase HMAC dryRun→confirm + role gating | Same write-gate, direct backend |
| Extras | Composites, protected modules, QSC couplings | Generic subset only |

The two share most tool logic but have **diverged**, and the drift is **invisible until a user hits it**. Concrete, measured drift today: the sibling is **missing the 5 estimate-template tools, `get_job_history`, and `st_post_marketing_attribution`**, and its `D1_TABLES` allow-list lists a dropped table while omitting two re-added ones. Left alone, every new internal tool widens the gap.

## The insight that reframes everything

All three lenses independently converged on one fact: **the hard architectural work is already done.** The backend sits behind a single `env.ST_PROXY: Fetcher` wire contract (`/api/st/read`, `/api/st/write`, `/internal/query-d1`), and the sibling's `src/backend/direct.ts` **already implements that exact contract** against direct-OAuth ST. **17 of 19 core files are byte-identical modulo two string renames.** So the entire tool/read/write/gate layer is already backend-agnostic — porting a tool between repos is a *file-copy + two renames*, not a rewrite.

That fact makes both the "prevent drift with machinery" options **cheaper than they look**, and the "just keep syncing" option **cheaper than it looks too**. The decision is therefore not about feasibility — it's about how much standing machinery this rarely-changing public repo is worth.

## The three options

### A — Generate the sibling *from* `mcp-servicetitan` (codegen)
A transform script strips the QSC layers (proxy/D1 read-router, composites, protected modules), swaps in the direct backend, and emits the sibling each release.
- **Effort:** M–L. **Residual drift:** medium.
- **Verdict: rejected by all three lenses (dominated).** It *relocates* drift from tool code into a hand-maintained generator + a strip-classification manifest that has **no compile-time guard** — a new protected module or a half-QSC composite can be silently mis-emitted (worst case: a credential/coupling leak into a public repo). And it turns the public repo into **generated output external registry contributors can't meaningfully PR against** — which defeats the point of having an OSS sibling.

### B — Shared-core package
Extract the generic `tools/` + core helpers (`st.ts`, `read-router`, `write-gate`, `write-tool-factory`, `tool-registry`, the `ToolDef`/`BackendAdapter` contract) into one package both repos import. Each repo supplies only its **backend adapter** (real proxy vs `createDirectBackend`) and its **composite/tool allow-list**.
- **Effort:** L–XL. **Residual drift:** low.
- **Ranked #1 by the maintenance/drift and security lenses.** A new generic tool lands in both servers *by construction* — the current class of drift becomes **impossible**. The security boundary becomes a **fail-closed allow-list** (QSC-only modules — `oauth.ts`/Access, `siro`, `dawn`, Pulitzer/jackpot composites — are never in the shared surface, so they *cannot* leak), enforceable by a one-line CI invariant ("shared-core contains zero QSC tokens"). Security-critical crypto (HMAC write-gate, SELECT-only read-router guard, tenant rewrite) lives **once**.
- **Costs:** highest upfront effort; the refactor touches the **change-controlled protected modules**; and it needs the right cross-visibility packaging (a **monorepo workspace or submodule built at HEAD**, *not* a floating semver npm pin — a version-pinned dependency would quietly reintroduce the exact lag B is meant to kill).

### C — Status quo, *formalized*
Keep two hand-maintained repos, but stop flying blind: add a small **drift-report script** that diffs the two `src/tools` trees and lists new/changed tools, plus a **written publishable-allowlist / QSC-only denylist** so the curation decision is *recorded*, not remembered.
- **Effort:** S (a few hours). **Residual drift:** medium, but now **visible**.
- **Ranked #1 by the effort/ROI lens.** Its decisive point: the sibling is a **flag-plant, not a parity product**, and **~half of the 28-tool gap is *intentional* QSC exclusion** (siro, dawn/Retell debrief, Pulitzer/jackpot codenames, QSC-only composites). The **real portable backlog is only ~12 tools.** Building a codegen pipeline or a shared-package monorepo is *more standing machinery than a rarely-changing public repo can ever pay back.* Plain do-nothing C is off the table — it already produced the drift above — but *formalized* C converts the problem from "silent drift" to "a diffable checklist."

## Recommendation

**Adopt C-formalized now (Phase 7, S effort); document B as the graduation path; do not build A.**

Reasoning: the effort/ROI lens has the strongest read on *what this repo is for*. The sibling earns its keep as a registry flag-plant and a clean reference implementation — not as a tool-for-tool mirror of an internal product that carries QSC-specific composites and infra the public will never run. Against a **~12-tool real backlog** in a repo that changes rarely, B's L–XL refactor of the **protected modules** is a large, change-controlled bet whose payback is thin. C-formalized captures ~80% of the benefit (drift becomes *visible and cheap to reconcile*) for a few hours of work and **zero risk to the protected surface**.

But the maintenance and security lenses are right that **B is the correct end-state *if the sibling ever becomes a maintained parity product*** — because the adapter seam already exists, B would single-source the tool definitions and turn the security boundary into a fail-closed invariant. So we document B as the explicit graduation path rather than discarding it.

### Concrete Phase-7 scope if C-formalized is approved (S)
1. A ~40-line **drift-report script** (internal repo) that diffs `mcp-servicetitan/src/tools` vs `servicetitan-mcp/src/tools` by tool name and flags: new-in-internal, changed-signature, and present-in-sibling-but-removed-internally. Run it in the internal repo's CI (report-only, non-gating) or as a periodic check.
2. A committed **`PUBLISHABLE.md` (or `sync-manifest.json`)** in the internal repo: the explicit allowlist of tools that *should* be ported to the sibling and the denylist of intentional QSC-only exclusions (siro, dawn/*, Pulitzer/jackpot, proxy/D1-coupled composites), each with a one-line reason.
3. One-time reconcile of the **~12-tool real backlog** into the sibling (estimate-template CRUD, `get_job_history`, `st_post_marketing_attribution`, and the rest the drift-report surfaces), plus fix the stale `D1_TABLES`.

### Graduation trigger to B (revisit this memo when)
- the sibling gains real external adoption / contributors who expect parity, **or**
- QSC decides the sibling must track prod tool-for-tool, **or**
- the manual reconcile in (3) starts happening more than ~quarterly.
At that point, start B by extracting the **security core first** (`write-gate.ts`, `read-router.ts`, auth crypto, tenant rewrite) behind the existing adapter seam, with the ~875-test suite green before/after.

## The one judgment call that stays manual under every option
Classifying each *new* composite as **generic (portable)** vs **QSC-only (denylist)**. A, B, and C all depend on getting this right; it is the single latent drift/leak vector no tooling removes. C-formalized at least makes it an explicit, reviewed list instead of an implicit habit.

---
*Panel confidence: high on the analysis; the A-rejection and "don't do plain-C" were unanimous. The C-formalized-vs-B call is a genuine judgment about the sibling's purpose — hence this memo asks Luke to ratify it rather than deciding it in code.*
