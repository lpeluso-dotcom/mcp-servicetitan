// ============================================================
// Task 6.4 — Tool-selection eval harness.
//
// Two layers, deliberately split by cost/determinism:
//
//   1. validateScenarios() — pure, offline, free. Asserts the scenario set
//      in scripts/evals/scenarios.ts is internally consistent and grounded
//      against the live TOOLS registry. Covered in CI by
//      src/__tests__/eval-scenarios.test.ts — no API key required.
//
//   2. runEval() — calls the live Anthropic Messages API once per scenario
//      and scores top-1 / top-3 tool-selection accuracy. Costs money, is
//      not deterministic, and is therefore NOT run in CI. Gated on
//      ANTHROPIC_API_KEY being set; run manually via `npm run eval:tools`.
//
// This file has no npm SDK dependency for the API call (raw fetch, per the
// task spec) and no @types/node in this repo (it's a Cloudflare Worker
// project — see the local ambient declarations below). It runs via `tsx`
// (added as a devDependency) both as a library (imported by the vitest
// test above) and as a standalone CLI script (`npm run eval:tools`).
// ============================================================

import { TOOLS, type ToolDef } from '../../src/tools/index';
import { scenarios as defaultScenarios, type EvalScenario } from './scenarios';

// ── Minimal local ambient Node typings ─────────────────────────────────
// This file is a module (has import/export), so `declare const` below is
// scoped to THIS FILE ONLY — it does not leak into the Worker's global
// type surface (src/**/*.ts never sees a phantom `process` global because
// of this file). We deliberately avoid adding @types/node as a project-
// wide devDependency to keep the Worker's strict tsconfig ("types":
// ["@cloudflare/workers-types"]) exactly as tight as it is today.
declare const process: {
  env: Record<string, string | undefined>;
  argv: string[];
  exit(code?: number): never;
};

// A literal `declare module 'fs' { ... }` here would be interpreted as a
// module AUGMENTATION (not a new declaration) because this file itself has
// top-level import/export — and augmentation requires 'fs' to already be
// resolvable, which it isn't without @types/node. Going through `require`
// as a plain ambient VALUE (scoped to this file, like `process` above)
// sidesteps module-resolution/augmentation rules entirely.
declare const require: (id: string) => { writeFileSync(path: string, data: string): void };

// `ImportMeta.url` is only typed via @types/node or the DOM lib, neither of
// which this project has (see the file-header note above) — augment the
// (already-global, TS-builtin) ImportMeta interface with just the one field
// this file uses, rather than pulling in either.
declare global {
  interface ImportMeta {
    url: string;
  }
}

// ── Catalog ──────────────────────────────────────────────────────────

export interface ToolCatalogEntry {
  name: string;
  description: string;
}

/**
 * Build the {name, description} catalog handed to the model.
 *
 * Excludes `st_call` (the sole `adminOnly` tool — a raw ST API gateway) by
 * default: it is never registered for the default caller role (see
 * `toolsForRole` in src/tools/index.ts), so a realistic agent session
 * answering QSC-operator questions would not see it either. This yields a
 * 98-tool catalog. Pass a pre-filtered `tools` array (e.g. the full 99-tool
 * `TOOLS`) if you want admin-role realism instead.
 */
export function buildCatalog(tools: readonly ToolDef<any>[] = TOOLS): ToolCatalogEntry[] {
  return tools.filter((t) => !t.adminOnly).map((t) => ({ name: t.name, description: t.description }));
}

// ── Offline scenario validation (the TDD-able, CI-covered core) ───────

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

interface ToolLike {
  name: string;
}

/**
 * Pure, offline, no network. Asserts:
 *  - at least 20 scenarios
 *  - every scenario id is unique and non-empty
 *  - every scenario query is non-empty
 *  - every scenario has at least one `expected` tool, and every one of
 *    those names exists in `tools`
 *  - every scenario has a non-empty rationale
 */
export function validateScenarios(tools: readonly ToolLike[], scenarioList: readonly EvalScenario[]): ValidationResult {
  const errors: string[] = [];
  const toolNames = new Set(tools.map((t) => t.name));

  if (scenarioList.length < 20) {
    errors.push(`expected at least 20 scenarios, got ${scenarioList.length}`);
  }

  const seenIds = new Set<string>();
  for (const s of scenarioList) {
    if (!s.id || s.id.trim().length === 0) {
      errors.push(`scenario has an empty id (query: ${JSON.stringify(s.query ?? '')})`);
    } else if (seenIds.has(s.id)) {
      errors.push(`duplicate scenario id: "${s.id}"`);
    } else {
      seenIds.add(s.id);
    }

    if (!s.query || s.query.trim().length === 0) {
      errors.push(`scenario "${s.id}" has an empty query`);
    }

    if (!Array.isArray(s.expected) || s.expected.length === 0) {
      errors.push(`scenario "${s.id}" has no expected tools`);
    } else {
      for (const name of s.expected) {
        if (!toolNames.has(name)) {
          errors.push(`scenario "${s.id}" references unknown tool "${name}"`);
        }
      }
    }

    if (!s.rationale || s.rationale.trim().length === 0) {
      errors.push(`scenario "${s.id}" has an empty rationale`);
    }
  }

  return { ok: errors.length === 0, errors };
}

// ── Live LLM eval (key-gated, manual, not run in CI) ───────────────────

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

export interface ScenarioResult {
  id: string;
  query: string;
  expected: string[];
  top3: string[];
  top1Correct: boolean;
  top3Correct: boolean;
  rawResponse?: string;
  error?: string;
}

export interface EvalSummary {
  model: string;
  n: number;
  top1Accuracy: number;
  top3Accuracy: number;
  results: ScenarioResult[];
}

export interface RunEvalOptions {
  apiKey: string;
  model?: string;
  scenarioList?: readonly EvalScenario[];
  catalog?: readonly ToolCatalogEntry[];
}

function buildPrompt(catalog: readonly ToolCatalogEntry[], query: string): string {
  const catalogText = catalog.map((t) => `- ${t.name}: ${t.description}`).join('\n');
  return [
    "You are choosing which tool(s) from an MCP tool catalog would best answer a ServiceTitan field-service operator's question.",
    '',
    'Tool catalog (name: description):',
    catalogText,
    '',
    `Operator question: "${query}"`,
    '',
    'Pick the 3 tools from the catalog above that would best answer this question, best first.',
    'Respond with ONLY a JSON object of this exact shape, no markdown fences, no explanation, no other text:',
    '{"top3": ["toolNameA", "toolNameB", "toolNameC"]}',
    'Every name in "top3" MUST be copied exactly (verbatim) from the catalog above.',
  ].join('\n');
}

/**
 * Extract a `{"top3": [...]}` JSON object from a model's raw text reply.
 * Robust to: a fenced ```json ... ``` block, and leading/trailing prose
 * around the JSON object (finds the first balanced {...} span and parses
 * that instead of assuming the whole string is clean JSON).
 */
export function extractJson(text: string): unknown {
  let cleaned = text.trim();

  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) cleaned = fenceMatch[1].trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    // fall through to brace-matching below
  }

  const start = cleaned.indexOf('{');
  if (start === -1) {
    throw new Error(`no JSON object found in model response: ${text.slice(0, 200)}`);
  }
  let depth = 0;
  for (let i = start; i < cleaned.length; i++) {
    if (cleaned[i] === '{') depth++;
    else if (cleaned[i] === '}') {
      depth--;
      if (depth === 0) {
        return JSON.parse(cleaned.slice(start, i + 1));
      }
    }
  }
  throw new Error(`unterminated JSON object in model response: ${text.slice(0, 200)}`);
}

interface AnthropicMessageResponse {
  content: Array<{ type: string; text?: string }>;
  stop_reason?: string;
}

async function callModel(apiKey: string, model: string, prompt: string): Promise<string> {
  const res = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 512,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '<unreadable response body>');
    throw new Error(`Anthropic API error ${res.status} ${res.statusText}: ${body.slice(0, 500)}`);
  }

  const data = (await res.json()) as AnthropicMessageResponse;
  const textBlock = data.content.find((b) => b.type === 'text');
  if (!textBlock?.text) {
    throw new Error(`no text content block in Anthropic response (stop_reason=${data.stop_reason ?? 'unknown'})`);
  }
  return textBlock.text;
}

/**
 * Run the live top-1/top-3 tool-selection eval against the Anthropic
 * Messages API. One request per scenario (no batching — keeps failures
 * isolated to a single scenario). Never throws for a single-scenario
 * failure; records it on that scenario's result instead so one bad
 * response doesn't abort the whole run.
 */
export async function runEval(opts: RunEvalOptions): Promise<EvalSummary> {
  const model = opts.model ?? process.env.MCP_EVAL_MODEL ?? DEFAULT_MODEL;
  const scenarioList = opts.scenarioList ?? defaultScenarios;
  const catalog = opts.catalog ?? buildCatalog();

  const results: ScenarioResult[] = [];
  for (const s of scenarioList) {
    const prompt = buildPrompt(catalog, s.query);
    try {
      const text = await callModel(opts.apiKey, model, prompt);
      const parsed = extractJson(text) as { top3?: unknown };
      const top3 = Array.isArray(parsed.top3) ? parsed.top3.filter((x): x is string => typeof x === 'string') : [];
      const top1Correct = top3.length > 0 && s.expected.includes(top3[0]);
      const top3Correct = s.expected.some((e) => top3.includes(e));
      results.push({ id: s.id, query: s.query, expected: s.expected, top3, top1Correct, top3Correct, rawResponse: text });
    } catch (err) {
      results.push({
        id: s.id,
        query: s.query,
        expected: s.expected,
        top3: [],
        top1Correct: false,
        top3Correct: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const n = results.length;
  const top1Accuracy = n === 0 ? 0 : results.filter((r) => r.top1Correct).length / n;
  const top3Accuracy = n === 0 ? 0 : results.filter((r) => r.top3Correct).length / n;

  return { model, n, top1Accuracy, top3Accuracy, results };
}

// ── CLI entrypoint ──────────────────────────────────────────────────────

function formatPct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

async function main(): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    const result = validateScenarios(TOOLS, defaultScenarios);
    const catalog = buildCatalog();
    console.log(`Offline scenario validation: ${result.ok ? 'PASS' : 'FAIL'}`);
    console.log(`  scenarios: ${defaultScenarios.length}  |  catalog size: ${catalog.length} tools (of ${TOOLS.length} total; excludes adminOnly st_call)`);
    if (!result.ok) {
      console.log('Errors:');
      for (const e of result.errors) console.log(`  - ${e}`);
    }
    console.log('');
    console.log('ANTHROPIC_API_KEY not set — ran offline scenario validation only.');
    console.log('Set it and re-run `npm run eval:tools` for the live top-1/top-3 eval.');
    process.exit(result.ok ? 0 : 1);
  }

  console.log(`Running live tool-selection eval (model: ${process.env.MCP_EVAL_MODEL ?? DEFAULT_MODEL})...`);
  const summary = await runEval({ apiKey });

  console.log('');
  console.log(`Model: ${summary.model}`);
  console.log(`Scenarios: ${summary.n}`);
  console.log('');
  console.log(pad('id', 24), pad('top1', 6), pad('top3', 6), 'expected -> got');
  for (const r of summary.results) {
    const status = r.error ? `ERROR: ${r.error}` : `${r.expected.join('|')} -> ${r.top3.join(', ')}`;
    console.log(pad(r.id, 24), pad(r.top1Correct ? 'Y' : 'n', 6), pad(r.top3Correct ? 'Y' : 'n', 6), status);
  }
  console.log('');
  console.log(`top1Accuracy: ${formatPct(summary.top1Accuracy)}`);
  console.log(`top3Accuracy: ${formatPct(summary.top3Accuracy)}`);

  const outPath = 'scripts/evals/last-run.json';
  require('fs').writeFileSync(outPath, JSON.stringify(summary, null, 2));
  console.log(`\nWrote ${outPath}`);
  // This is a report, not a CI gate — always exit 0 on a completed run
  // regardless of accuracy. Only the offline-validation path above can
  // exit non-zero.
}

// Run main() only when this file is executed directly (`tsx
// scripts/evals/tool-selection.ts` / `npm run eval:tools`) — not when
// imported for its exports (validateScenarios, buildCatalog, runEval) by
// src/__tests__/eval-scenarios.test.ts.
const isMainModule = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  const entryUrl = entry.startsWith('file://') ? entry : `file://${entry}`;
  return import.meta.url === entryUrl;
})();

if (isMainModule) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
