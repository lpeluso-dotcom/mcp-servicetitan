#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ORIGIN = process.env.ST_RELEASE_NOTES_ORIGIN || 'https://developer.servicetitan.io';
const RELEASE_NOTES_PATH = process.env.ST_RELEASE_NOTES_PATH || '/docs/release-notes';
const BASELINE_PATH = path.resolve(__dirname, '..', 'docs', 'st-api-release-baseline.json');
const TRACKED_PREFIX = process.env.ST_RELEASE_NOTES_PREFIX || '77';

function readArgs(argv) {
  return {
    update: argv.includes('--update'),
    json: argv.includes('--json'),
    issueBody: argv.includes('--issue-body'),
  };
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} failed: ${res.status}`);
  return res.text();
}

function parseScriptUrls(html, origin) {
  return Array.from(html.matchAll(/src="([^"]+\.js[^"]*)"/g)).map((m) => new URL(m[1], origin).href);
}

function parseMap(body) {
  const out = {};
  for (const match of body.matchAll(/"\.\/([^"]+\.json)":(\d+)/g)) {
    out[match[1].replace(/\.json$/, '')] = Number(match[2]);
  }
  return out;
}

function decodeWebpackJson(raw) {
  const jsonText = Function(`return '${raw}'`)();
  return JSON.parse(jsonText);
}

function extractReleaseNotes(bundle) {
  const mapMatches = Array.from(bundle.matchAll(/var map=\{([^}]*)\};function webpackContext/g));
  const releaseMapMatch = mapMatches.find((m) => m[1].includes(`"./${TRACKED_PREFIX}.json"`));
  if (!releaseMapMatch) throw new Error(`Could not find ServiceTitan release-note map for ST-${TRACKED_PREFIX}`);

  const releaseMap = parseMap(releaseMapMatch[1]);
  const firstModuleId = Math.min(...Object.values(releaseMap));
  const releaseCount = Object.keys(releaseMap).length;
  const afterMap = bundle.slice(releaseMapMatch.index + releaseMapMatch[0].length);
  const modules = Array.from(afterMap.matchAll(/module\.exports=JSON\.parse\('((?:\\'|[^'])*)'\)/g))
    .slice(0, releaseCount)
    .map((m) => decodeWebpackJson(m[1]));

  const releases = {};
  for (const [version, moduleId] of Object.entries(releaseMap)) {
    releases[version] = modules[moduleId - firstModuleId];
  }
  return releases;
}

function trackedReleases(releases) {
  return Object.fromEntries(
    Object.entries(releases)
      .filter(([version]) => version === TRACKED_PREFIX || version.startsWith(`${TRACKED_PREFIX}.`))
      .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
  );
}

async function loadCurrentSnapshot() {
  const source = new URL(RELEASE_NOTES_PATH, ORIGIN).href;
  const html = await fetchText(source);
  const scriptUrls = parseScriptUrls(html, ORIGIN);
  const mainUrl = scriptUrls.find((url) => /\/main\.[^/]+\.bundle\.js/.test(url));
  if (!mainUrl) throw new Error(`Could not find main bundle from ${source}`);
  const bundle = await fetchText(mainUrl);
  const versions = trackedReleases(extractReleaseNotes(bundle));
  return {
    source,
    bundle: mainUrl,
    trackedPrefix: TRACKED_PREFIX,
    capturedAt: new Date().toISOString(),
    versions,
  };
}

function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sortDeep(v)]));
}

function stable(value) {
  return JSON.stringify(sortDeep(value), null, 2);
}

function compareSnapshots(baseline, current) {
  const baseVersions = baseline.versions || {};
  const currentVersions = current.versions || {};
  const newVersions = Object.keys(currentVersions).filter((v) => !(v in baseVersions));
  const removedVersions = Object.keys(baseVersions).filter((v) => !(v in currentVersions));
  const changedVersions = Object.keys(currentVersions).filter(
    (v) => v in baseVersions && stable(currentVersions[v]) !== stable(baseVersions[v])
  );
  return {
    ok: newVersions.length === 0 && removedVersions.length === 0 && changedVersions.length === 0,
    newVersions,
    removedVersions,
    changedVersions,
  };
}

function summarizeRelease(version, release) {
  const lines = [`### ST-${version} (${release.date || 'unknown date'})`];
  for (const group of release.changeGroups || []) {
    lines.push(`- ${group.apiId}`);
    for (const addition of group.additions || []) {
      const endpoints = (addition.endpoints || []).map((e) => `${e.method} ${e.shortPath}`).join(', ');
      lines.push(`  - Added: ${addition.description}${endpoints ? ` (${endpoints})` : ''}`);
    }
    for (const update of group.updates || []) {
      const endpoints = (update.endpoints || []).map((e) => `${e.method} ${e.shortPath}`).join(', ');
      const bits = [update.description];
      if (update.fields) bits.push(`${update.fieldsHeader || 'Fields'}: ${update.fields}`);
      if (update.filters) bits.push(`${update.filtersHeader || 'Filters'}: ${update.filters}`);
      lines.push(`  - Updated: ${bits.join('; ')}${endpoints ? ` (${endpoints})` : ''}`);
    }
  }
  return lines.join('\n');
}

function issueBody(diff, baseline, current) {
  const lines = [
    '# ServiceTitan API release-note drift detected',
    '',
    `Source: ${current.source}`,
    `Bundle: ${current.bundle}`,
    `Tracked prefix: ST-${current.trackedPrefix}`,
    '',
  ];

  if (diff.newVersions.length) {
    lines.push('## New releases');
    for (const version of diff.newVersions) lines.push(summarizeRelease(version, current.versions[version]), '');
  }
  if (diff.changedVersions.length) {
    lines.push('## Changed baseline releases');
    for (const version of diff.changedVersions) lines.push(summarizeRelease(version, current.versions[version]), '');
  }
  if (diff.removedVersions.length) {
    lines.push('## Removed releases');
    for (const version of diff.removedVersions) lines.push(`- ST-${version}`);
    lines.push('');
  }

  lines.push('## Next MCP review');
  lines.push('- Add or update typed tools for any new endpoints worth exposing.');
  lines.push('- Add field/filter forwarding tests for any changed transactional endpoints.');
  lines.push('- Refresh `docs/st-api-release-baseline.json` with `npm run release:st-drift -- --update` after review.');
  lines.push('');
  lines.push(`Baseline versions: ${Object.keys(baseline.versions || {}).join(', ') || '(none)'}`);
  lines.push(`Observed versions: ${Object.keys(current.versions || {}).join(', ') || '(none)'}`);
  return lines.join('\n');
}

async function main() {
  const args = readArgs(process.argv.slice(2));
  const current = await loadCurrentSnapshot();

  if (args.update) {
    fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(current, null, 2)}\n`);
    console.log(`Updated ${path.relative(process.cwd(), BASELINE_PATH)}`);
    return;
  }

  const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
  const diff = compareSnapshots(baseline, current);
  const result = { ok: diff.ok, diff, baselinePath: BASELINE_PATH, current };

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (args.issueBody) {
    console.log(diff.ok ? 'No ServiceTitan API release-note drift detected.' : issueBody(diff, baseline, current));
  } else if (diff.ok) {
    console.log(`No ServiceTitan API release-note drift detected for ST-${TRACKED_PREFIX}.`);
  } else {
    console.log(issueBody(diff, baseline, current));
  }

  if (!diff.ok) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
