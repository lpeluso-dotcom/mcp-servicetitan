#!/usr/bin/env node
// ============================================================
// probe-st-endpoints.mjs — paced ST API availability + field-drift probe.
//
// Purpose (audit 2026-06-12): ST ships releases (ST-77, ST-78, …) that add /
// rename / silently break fields. This script re-probes a manifest of
// endpoints quarterly and diffs the top-level field shape of each response
// against a committed snapshot, so drift is caught before it corrupts a sync
// mapper or MCP tool.
//
// PACING (do not change without re-reading the rate-limit budget):
//   - strictly sequential, ONE request at a time
//   - 8s sleep between requests (~7.5 req/min aggregate — under every
//     StRateLimiter family bucket; reporting@20/min is the tightest)
//   - pageSize=1 on every list endpoint
//   - on 429: honor Retry-After capped at 30s, ONE retry, then mark failed
//
// Run (operator, quarterly — NOT a worker cron):
//   set -a; source ~/.env; set +a
//   node scripts/probe-st-endpoints.mjs                 # probe + diff
//   node scripts/probe-st-endpoints.mjs --update-snapshots  # accept current shapes
//
// Exit codes: 0 = clean; 1 = drift detected or endpoint failure.
// Outputs: JSONL log at scripts/probe-logs/probe-YYYYMMDD.jsonl
//          snapshots at scripts/probe-snapshots/<name>.json
// ============================================================

import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SLEEP_MS = 8000;
const RETRY_AFTER_CAP_MS = 30000;
const TENANT = process.env.ST_TENANT_ID;
const UPDATE = process.argv.includes('--update-snapshots');

if (!TENANT || !process.env.ST_CLIENT_ID || !process.env.ST_CLIENT_SECRET || !process.env.ST_APP_KEY) {
  console.error('Missing ST_TENANT_ID / ST_CLIENT_ID / ST_CLIENT_SECRET / ST_APP_KEY — source ~/.env first.');
  process.exit(2);
}

const manifest = JSON.parse(readFileSync(join(__dirname, 'probe-manifest.json'), 'utf8'));
const snapDir = join(__dirname, 'probe-snapshots');
const logDir = join(__dirname, 'probe-logs');
mkdirSync(snapDir, { recursive: true });
mkdirSync(logDir, { recursive: true });
const logPath = join(logDir, `probe-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}.jsonl`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getToken() {
  const res = await fetch('https://auth.servicetitan.io/connect/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=client_credentials&client_id=${process.env.ST_CLIENT_ID}&client_secret=${process.env.ST_CLIENT_SECRET}`,
  });
  if (!res.ok) throw new Error(`ST auth failed: ${res.status}`);
  return (await res.json()).access_token;
}

// Sorted top-level keys of the first item (list endpoints) or the body itself.
function shapeOf(body) {
  const item = Array.isArray(body?.data) ? body.data[0] : body;
  if (item == null || typeof item !== 'object') return [];
  return Object.keys(item).sort();
}

async function probeOne(token, ep) {
  const sep = ep.path.includes('?') ? '&' : '?';
  const url = `https://api.servicetitan.io${ep.path.replaceAll('{tenant}', TENANT)}${ep.list === false ? '' : `${sep}pageSize=1`}`;
  const headers = { Authorization: `Bearer ${token}`, 'ST-App-Key': process.env.ST_APP_KEY };
  const t0 = Date.now();
  let res = await fetch(url, { headers });
  if (res.status === 429) {
    const ra = Math.min((parseInt(res.headers.get('Retry-After') ?? '30', 10) || 30) * 1000, RETRY_AFTER_CAP_MS);
    console.log(`  429 — waiting ${ra}ms then retrying once`);
    await sleep(ra);
    res = await fetch(url, { headers });
  }
  const elapsed = Date.now() - t0;
  if (!res.ok) return { name: ep.name, status: res.status, elapsed_ms: elapsed, ok: false };
  const body = await res.json().catch(() => null);
  return { name: ep.name, status: res.status, elapsed_ms: elapsed, ok: true, keys: shapeOf(body) };
}

const token = await getToken();
let drift = false;

for (const ep of manifest.endpoints) {
  process.stdout.write(`probe ${ep.name} … `);
  let result;
  try {
    result = await probeOne(token, ep);
  } catch (err) {
    result = { name: ep.name, status: 0, ok: false, error: String(err.message) };
  }

  const snapPath = join(snapDir, `${ep.name}.json`);
  let keysAdded = [], keysRemoved = [];
  if (result.ok && result.keys) {
    if (existsSync(snapPath) && !UPDATE) {
      const prev = JSON.parse(readFileSync(snapPath, 'utf8'));
      keysAdded = result.keys.filter((k) => !prev.keys.includes(k));
      keysRemoved = prev.keys.filter((k) => !result.keys.includes(k));
      if (keysAdded.length || keysRemoved.length) drift = true;
    } else {
      writeFileSync(snapPath, JSON.stringify({ name: ep.name, captured: new Date().toISOString(), keys: result.keys }, null, 2));
    }
  } else {
    drift = true;
  }

  const line = { ts: new Date().toISOString(), name: ep.name, status: result.status, ok: result.ok, elapsed_ms: result.elapsed_ms ?? null, keys_added: keysAdded, keys_removed: keysRemoved, error: result.error ?? null };
  appendFileSync(logPath, JSON.stringify(line) + '\n');
  console.log(result.ok ? `${result.status} (${result.elapsed_ms}ms)${keysAdded.length || keysRemoved.length ? ` DRIFT +${keysAdded.length}/-${keysRemoved.length}` : ''}` : `FAILED ${result.status} ${result.error ?? ''}`);

  await sleep(SLEEP_MS); // pacing — see header
}

console.log(`\nlog: ${logPath}`);
if (drift && !UPDATE) {
  console.error('DRIFT or failures detected — review the log, then re-run with --update-snapshots to accept intentional changes.');
  process.exit(1);
}
