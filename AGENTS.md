## Required pre-commit review

Git commits must pass `.githooks/pre-commit`, which reviews staged changes with Pi before creating the commit. If review rejects a commit, resolve the findings, stage the fixes, and retry. Do not bypass the gate with `--no-verify`, altered hooks/configuration, or a fabricated review result. Review failures are blocking too. See `.pi/README.md` for setup and behavior.

## Agent skills

### Issue tracker

Issues and PRDs live in GitHub Issues for `iamthatbenj/item_indexer`. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the five canonical triage label names unchanged. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout: root `CONTEXT.md` and `docs/adr/`. See `docs/agents/domain.md`.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
