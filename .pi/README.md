# Blocking pre-commit code review

The former after-commit Pi extension has been replaced by a **Git pre-commit gate**. Review finishes before Git creates the commit. This applies to normal `git commit` attempts in this checkout, including those made by Pi.

## Installation

From the repository root:

```sh
chmod +x .githooks/pre-commit
git config --local core.hooksPath .githooks
```

This checkout is already configured. Repeat the configuration for new clones. If you previously loaded the after-commit extension, run `/reload` to unload it. The global `/code-review` command is unchanged and is not part of this gate.

## Workflow

1. Stage a tranche and run `git commit` normally.
2. `.githooks/pre-commit` runs `scripts/pre-commit-review.mjs`.
3. A separate Pi process reviews the staged diff and a temporary snapshot of raw staged Git blobs. Checkout/smudge filters and working-tree encoding conversions are not applied. Unstaged changes cannot masquerade as fixes. This also supports initial commits, amendments with staged changes, `git commit -a`, and path-specific commits.
4. Any actionable finding rejects the commit and prints its location, impact and suggested fix. The hook does not edit files, stage changes or retry automatically.
5. Resolve the findings, stage the fixes, and retry `git commit`. A fresh review must pass before Git proceeds. Pi receives the rejected commit's output through its normal command result.

Review errors, unavailable authentication, malformed output and the five-minute timeout also block commits. The hook rejects approval if the index or HEAD changes during review. Empty staged diffs need no review. Symlinks are represented by their staged link-target text in regular files, never followed outside the snapshot; the review prompt explains this. Submodules and non-UTF-8 index paths currently block snapshot preparation rather than silently omit unreviewable content.

## Reviewer

Requires `node` (22.19+) and `pi` on PATH, with working Pi authentication. It uses Pi's user-level default model. Optionally select one with `PI_REVIEW_MODEL=provider/model-id` in your environment. Each attempt incurs model usage.

The reviewer has only `read`, `grep`, `find` and `ls` tools. Extensions, MCP, skills, project configuration and automatic context loading are disabled. The prompt explicitly requests relevant staged domain/framework documentation. Temporary snapshots and diffs are deleted afterward. Tests are not run, and AI approval is not a guarantee of correctness.

This is a local workflow guard, not an OS sandbox or centrally enforced branch policy. Git's explicit hook bypasses and edits to local configuration remain possible; agents must not use them to circumvent review. Other Git operations that create commits without running `pre-commit` (such as automatic merges/rebases) are not covered. Avoid concurrent commits/index changes in the same checkout.

## Regression checks

```sh
node --test tests/pre-commit-review.test.mjs
```

The tests attempt real commits in disposable repositories using a mock reviewer; they do not call a live model. They also verify that smudge filters cannot substitute review content and external symlink targets are not read.
