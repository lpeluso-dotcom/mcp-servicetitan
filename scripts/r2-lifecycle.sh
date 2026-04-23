#!/usr/bin/env bash
# Idempotent applier for qsc-mcp-webhook-archive lifecycle rules.
# Run manually — lifecycle config cannot live in wrangler.toml.
# Requires wrangler CLI with R2 permissions.
set -euo pipefail

BUCKET="qsc-mcp-webhook-archive"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Applying R2 lifecycle rules to ${BUCKET}..."
npx wrangler r2 bucket lifecycle set "${BUCKET}" --file "${DIR}/r2-lifecycle.json"
echo "✅ Lifecycle rules applied"
echo "  - 30d: transition to InfrequentAccess"
echo "  - 180d: delete"
