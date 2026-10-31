# Issue tracker: GitHub

Issues and PRDs live in GitHub Issues for `iamthatbenj/item_indexer`.
Use the `gh` CLI with an explicit `--repo iamthatbenj/item_indexer`
so commands work even before a Git remote is configured.

## Conventions

- Create: `gh issue create --repo iamthatbenj/item_indexer --title "..." --body "..."`
  For multi-line bodies, use `--body-file -` with a heredoc.
- Read: `gh issue view <number> --repo iamthatbenj/item_indexer --comments`
  Fetch labels with `--json number,title,body,labels,comments` when needed.
- List: `gh issue list --repo iamthatbenj/item_indexer --state open --json number,title,body,labels,comments`
  Add appropriate `--label` and `--state` filters.
- Comment: `gh issue comment <number> --repo iamthatbenj/item_indexer --body "..."`
- Apply/remove labels: `gh issue edit <number> --repo iamthatbenj/item_indexer --add-label "..."` or `--remove-label "..."`
- Close: `gh issue close <number> --repo iamthatbenj/item_indexer --comment "..."`

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --repo iamthatbenj/item_indexer --comments`.
