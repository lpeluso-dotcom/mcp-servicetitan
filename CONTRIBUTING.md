# Contributing

Thanks for reviewing `mcp-servicetitan`. This repository is being shared for technical and security feedback on the MCP server design, not for access to a live ServiceTitan tenant.

## Safety Rules

- Do not post real ServiceTitan customer data, screenshots, tokens, sync keys, JWTs, webhook secrets, Cloudflare account IDs, or live payloads in issues or pull requests.
- Report exploitable vulnerabilities privately using the contact path in [SECURITY.md](SECURITY.md).
- Use synthetic IDs and payloads in examples and tests.
- Treat the hosted worker URL, if you know one, as private infrastructure. Community review should happen against the source code or a reviewer-owned dev deployment.

## Local Checks

```bash
npm ci
npm run typecheck
npm test
npm run security:audit
```

If you have `gitleaks` installed, run:

```bash
gitleaks detect --no-git --source . --redact --verbose
```

## Pull Requests

- Keep changes focused and describe the risk they address.
- Add or update tests for auth, write-gate, logging/redaction, webhook, or tool behavior changes.
- Update `README.md`, `SECURITY.md`, or `docs/INTEGRATION.md` when behavior changes.
- Do not include generated audit reports unless they add durable context that reviewers need.

## License Note

No open-source license is currently included. Until a license is added, assume all rights are reserved and use this repository only for review unless the owner states otherwise.
