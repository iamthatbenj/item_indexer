# Domain Docs

## Layout: single-context

- Domain language: `CONTEXT.md` at the repo root.
- Architectural decisions: `docs/adr/`.

## Before exploring

Read root `CONTEXT.md` and ADRs relevant to the area being explored.
If root `CONTEXT-MAP.md` exists, follow it to the relevant contexts;
also check their context-scoped ADR directories.

If these files do not exist, proceed silently. Do not flag their
absence or suggest creating them upfront. `/grill-with-docs` creates
them lazily as terminology and decisions are resolved.

## Use the glossary's vocabulary

Use terms defined in `CONTEXT.md` in issue titles, refactor proposals,
hypotheses, and test names. Avoid synonyms the glossary rejects.

If a concept is missing, reconsider whether it belongs to the domain
or note the gap for `/grill-with-docs`.

## Flag ADR conflicts

Explicitly surface any proposal that contradicts an existing ADR,
rather than silently overriding the decision.
