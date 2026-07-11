# Tool-selection eval (`scripts/evals/`)

Measures whether an LLM, given the mcp-servicetitan tool catalog (name + description) and a
natural-language QSC question, picks the **right** tool. Tool-description quality is the agent
UX for a 99-tool server; this eval is how we catch descriptions that mislead tool selection.
(Complements `src/__tests__/description-lint.test.ts`, which statically checks that each
description *states* its source/limits — this eval checks that the descriptions actually
*steer selection* correctly.)

## Files
- `scenarios.ts` — 22 typed QSC scenarios: `{ id, query, expected[], rationale }`. `expected`
  is the set of acceptable tools (an array, because some queries have >1 defensible answer).
- `tool-selection.ts` — `buildCatalog` (98 default-role tools; excludes admin `st_call`),
  `validateScenarios` (offline integrity check), `runEval` (live top-1/top-3 scoring), `main`.

## Run it

### Offline (no key, runs in CI)
```bash
npm run eval:tools        # with ANTHROPIC_API_KEY unset → offline scenario validation only
```
The same integrity check is asserted by `src/__tests__/eval-scenarios.test.ts` in the normal
`npm test` suite, so scenario drift (a renamed/removed expected tool, a dup id) fails CI with
no API key required.

### Live scoring (key-gated, costs money — run manually)
```bash
export ANTHROPIC_API_KEY=sk-ant-...      # your key
npm run eval:tools                        # scores all 22 scenarios with Haiku 4.5
# override the model:  MCP_EVAL_MODEL=claude-... npm run eval:tools
```
Prints a per-scenario table + aggregate **top-1 / top-3** accuracy and writes
`scripts/evals/last-run.json`.

## Recording a baseline
`last-run.json` is **git-ignored** (it's a run artifact). To record a baseline for tracking
description-quality over time, after a live run copy the aggregate numbers into a dated note —
e.g. append a row to a `BASELINE.md` here, or the mcp-servicetitan CHANGELOG:

```
## Eval baseline
- 2026-07-DD · Haiku 4.5 · 22 scenarios · top-1 XX% · top-3 YY%
```

Scenarios that miss are the signal: sharpen the losing tool's `description` (keeping it
truthful — never claim a dynamically-priced item is "free"/"$0") and re-run.
