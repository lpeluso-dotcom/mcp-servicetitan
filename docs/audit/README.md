# Audit Artifacts

Detailed internal audit captures were removed from the public tree because they contained local paths, deployment URLs, and operator notes. Keep raw scanner output, production smoke logs, and tenant-specific evidence outside the public repository.

For public review, use the durable summaries in:

- [SECURITY.md](../../SECURITY.md)
- [PUBLISHING_CHECKLIST.md](../PUBLISHING_CHECKLIST.md)

Before each release, run fresh local checks and attach only sanitized summaries to public issues or pull requests.
