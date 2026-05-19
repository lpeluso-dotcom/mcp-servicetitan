#!/usr/bin/env python3
"""Substitute placeholder IDs in wrangler.toml with real values from env vars.

Run by `.github/workflows/deploy.yml` immediately before `wrangler deploy`.
Reads the seven required values from the environment, rewrites the on-disk
wrangler.toml in place, and exits non-zero if any placeholder is left
behind. The committed wrangler.toml is never modified by this script (CI
runs against a checked-out copy; nothing is written back to git).

Required env vars (matching the GH Actions secret names):
  ST_TENANT_ID
  D1_DATABASE_ID_PROD     D1_DATABASE_ID_DEV
  KV_NAMESPACE_ID_PROD    KV_NAMESPACE_ID_DEV
  ST_PROXY_SERVICE_PROD   ST_PROXY_SERVICE_DEV

Why a script instead of inline `sed` in deploy.yml: each placeholder appears
in two sections (prod + dev), and we only want to swap each occurrence with
the *right* value for the section it's in. A `sed` blast would map both
to the same value. Doing the substitution section-by-section in Python is
clearer and unit-testable.
"""

from __future__ import annotations
import os
import re
import sys
from pathlib import Path

REQUIRED_VARS = (
    'ST_TENANT_ID',
    'D1_DATABASE_ID_PROD', 'D1_DATABASE_ID_DEV',
    'KV_NAMESPACE_ID_PROD', 'KV_NAMESPACE_ID_DEV',
    'ST_PROXY_SERVICE_PROD', 'ST_PROXY_SERVICE_DEV',
)

D1_PLACEHOLDER = '"00000000-0000-0000-0000-000000000000"'
KV_PLACEHOLDER = '"00000000000000000000000000000000"'
SVC_PROD_PLACEHOLDER = '"your-servicetitan-proxy"'
SVC_DEV_PLACEHOLDER = '"your-servicetitan-proxy-dev"'

# Section header → (placeholder, env var) tuples.
SECTION_SUBS = {
    '[[d1_databases]]':           [(D1_PLACEHOLDER,       'D1_DATABASE_ID_PROD',   True)],
    '[[env.dev.d1_databases]]':   [(D1_PLACEHOLDER,       'D1_DATABASE_ID_DEV',    True)],
    '[[kv_namespaces]]':          [(KV_PLACEHOLDER,       'KV_NAMESPACE_ID_PROD',  True)],
    '[[env.dev.kv_namespaces]]':  [(KV_PLACEHOLDER,       'KV_NAMESPACE_ID_DEV',   True)],
    '[[services]]':               [(SVC_PROD_PLACEHOLDER, 'ST_PROXY_SERVICE_PROD', True)],
    # Dev service section may contain either the dev or generic placeholder
    # depending on which was committed; try dev first, fall back to prod.
    '[[env.dev.services]]': [
        (SVC_DEV_PLACEHOLDER,  'ST_PROXY_SERVICE_DEV', False),
        (SVC_PROD_PLACEHOLDER, 'ST_PROXY_SERVICE_DEV', False),
    ],
}

SECTION_RE = re.compile(r'(?m)^(\[\[?[^\]\n]+\]\]?)\s*$')


def quote(value: str) -> str:
    return f'"{value}"'


def main() -> int:
    missing = [v for v in REQUIRED_VARS if not os.environ.get(v)]
    if missing:
        print(f'error: missing required env vars: {", ".join(missing)}', file=sys.stderr)
        print('Set each via `gh secret set <NAME> --body <value>` — see deploy.yml header.', file=sys.stderr)
        return 1

    wt = Path('wrangler.toml')
    if not wt.exists():
        print('error: wrangler.toml not found in cwd', file=sys.stderr)
        return 1

    text = wt.read_text()

    # ST_TENANT_ID appears identically in [vars] and [env.dev.vars]; replace all.
    text = text.replace(
        'ST_TENANT_ID = "000000000"',
        f'ST_TENANT_ID = {quote(os.environ["ST_TENANT_ID"])}',
    )

    # Walk sections top-down. SECTION_RE captures headers as their own chunks
    # so we can swap context by reading the previous header.
    chunks = SECTION_RE.split(text)
    ctx = ''
    out: list[str] = []
    for chunk in chunks:
        if SECTION_RE.match(chunk) or chunk.startswith('['):
            ctx = chunk.strip()
            out.append(chunk)
            continue
        subs = SECTION_SUBS.get(ctx, [])
        for placeholder, env_name, required_match in subs:
            value = quote(os.environ[env_name])
            if placeholder in chunk:
                chunk = chunk.replace(placeholder, value, 1)
                # Stop after first successful substitution per section.
                break
            elif required_match:
                # Required match missing — let the post-pass catch it.
                continue
        out.append(chunk)
    wt.write_text(''.join(out))

    # Defensive: any remaining placeholder means a section we expected to
    # rewrite still has its original value. Fail loud rather than deploy
    # a half-substituted config.
    after = wt.read_text()
    leftover = []
    for needle in (D1_PLACEHOLDER, KV_PLACEHOLDER, SVC_PROD_PLACEHOLDER, SVC_DEV_PLACEHOLDER):
        if needle in after:
            leftover.append(needle)
    if leftover:
        print('error: placeholders still present after substitution:', file=sys.stderr)
        for n in leftover:
            print(f'  {n}', file=sys.stderr)
        return 1

    print(f'wrangler.toml substituted: {len(REQUIRED_VARS)} secrets applied')
    return 0


if __name__ == '__main__':
    sys.exit(main())
