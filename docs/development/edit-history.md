# Inspect edit history and recover earlier content

Scope: [#12](https://github.com/iamthatbenj/item_indexer/issues/12), following [edit reconciliation](edit-reconciliation.md). Every current family member can inspect retained item and story versions and prepare earlier content as a new deliberate edit. Administrators have no additional editorial authority.

## Interface and meaning

Item pages and story editors offer history links in **new tabs**, preserving the original open editor's unsaved input. Story cards also link directly to story history.

- `GET /collections/:collection/items/:item/history`: item versions, oldest to newest.
- `GET /collections/:collection/items/:item/stories/:story/history`: story versions, oldest to newest.
- Add `?recover=N` to prepare a retained **prior** version in a separate-tab recovery editor. Noncanonical, duplicate, absent-from-history, current and future version selectors receive not-found.

History includes today's current version, editing account email and precise timestamp, plus all retained prior versions. Item versions show name, description, draft/complete state and keeper assignment. This is not photo history, Person editing history, access history, or recovery of removed records. Initial item capture appears as version one when retained, even when its name/description were blank. No missing past versions are invented.

Story versions distinguish storyteller, original recording member/time and the editing member/time. Storyteller labels resolve the recording-time Person identifying version using current `people` or `person_revisions`, not today's renamed label. Keeper labels resolve the identifying version retained with the assignment. Ordinary item/story cards still show current Person labels. An unavailable historical label is marked unavailable, never silently substituted with today's details.

Attribution joins retained account identities, **not membership rows for old contributors**. A departed editor/recorder remains credited without regaining access. No Person/account linking is inferred.

## Recovery is an ordinary edit

Opening history or a recovery form writes nothing. The recovery page displays all saved versions, marks today's version and preloads the chosen earlier fields into the existing editor, paired with the **current** version read in the same database statement. Review/revise the draft and press the ordinary Save button deliberately:

- Item recovery reapplies name, description and keeper ID. State is computed from validated current content; no historical status, photo or account grant is written.
- A changed keeper assignment validates the Person in today's collection and records today's identifying version. The selector uses current names. An unchanged assignment follows the ordinary editor's existing assignment-version behavior.
- Story recovery reapplies text only. Storyteller/recording identity and times remain unchanged; the saving member receives editing credit.
- Effective saves preserve the superseded current version and increment the record version. Subsequent historical versions remain intact. Current-content no-ops create no revision.
- Concurrent/intervening edits cause the existing 409 comparison/reconciliation flow; earlier fields remain editable/copyable. Only explicit review advances the expected version. Another intervening change conflicts again.
- Failed saves retain attempted fields on the open page. Lost-success acknowledgements conflict on retry; comparison followed by a same-content save creates no duplicate revision.

This is not database rollback, destructive history rewriting, a semantic merge, photo restoration or interruption persistence. Reloading/closing a recovery form can lose unsaved input. Keep it open or copy valuable text.

## Authorization and future removal boundary

Each history query scopes both current and prior versions through the currently accessible collection/item/story, active-photo invariant and requesting member, in one database statement. Revision identifiers alone never authorize reads. Signed-out page requests redirect to sign-in; inaccessible/substituted parent references return 404. Dynamic authenticated pages are private/no-store. Text renders literally via React, including HTML-like text.

Recovery saves use existing exact-Origin bounded forms, server-side content/reference validation, transactional fresh membership checks, required active photos, conditional current-version writes and atomic revision capture. A form opened before access removal cannot save afterward, even for a no-op. Cross-collection keepers and substituted story/item references remain invalid.

**Record removal is not implemented yet.** The existing inaccessible-parent case is covered through the active-photo invariant. When #27/#28 introduce removal/recovery, they must extend these history reads and the ordinary final-save paths with the same removed-parent restrictions: normal members must not read deletion-bin content/history or resurrect it through earlier content. Administrator deletion-bin restoration must stay separate from equal-member content recovery. This slice does not claim to verify an unimplemented deletion API.

## Preservation and deployment

No new schema, persistent fields, files, credentials, provider resources or membership grants are introduced. Future portable archives must preserve stable item/story/revision/Person/account identities, chronological versions, text/state/keeper references, original recording and editing provenance, and the Person identifying versions needed to resolve historical labels. Preserve attribution data without requiring login to or restored access for old accounts. Existing #9–#11 preservation requirements remain; no portable output has shipped yet.

No migration is required beyond the already deployed schema #8. With operator approval, reviewed commit `f3d74cd` was pushed to main and Vercel reported successful deployment. The operator then reported successful hosted acceptance and requested closing #12. This is operator-reported authenticated acceptance, not independent agent verification of every manual check. An application rollback to #11 hides history/recovery forms but retains all edits and revisions; keep the schema/data intact and prefer compatible fix-forward.

## Verification

```sh
npm test -- tests/edit-history.spec.ts
npm test
npm run typecheck
npm run build
npm audit --omit=dev
node --test tests/pre-commit-review.test.mjs
git diff --check
```

Nine dedicated real-database/private-storage browser cases cover item edit/recover/edit including draft/keeper recovery; cross-member story recovery and departed-recorder/editor credit; renamed historical keeper/storyteller labels; repeated stale item/story recovery; collection/item/story isolation and invalid selectors; access removal after opening forms; active-photo/current-reference invariants; failed/lost acknowledgements and no-ops; and mobile/keyboard/literal long text with separate-tab draft preservation. Validation: all 129 Chromium/browser/integration tests passed (21.9 minutes), including these nine cases and existing populated migration upgrades. Typegen/TypeScript, production webpack build, production dependency audit (zero vulnerabilities), nine hook regressions and diff checks also passed. The initial focused run exposed test-harness issues: popup viewports do not inherit opener-only viewport changes, and waiting for any load can mistake a popup's initial load for save confirmation. The harness now sets popup viewports explicitly and waits for confirmed-save navigation; the focused mobile case and full suite passed. These are local automated checks, not hosted/manual acceptance.

After an approved deployment, use disposable records to inspect and recover both item and story versions as another member; confirm all later history and original storyteller/recorder credits remain, test a competing save and removed-member final save, and check actual mobile/assistive-technology behavior. Do not use sole-copy valuable recollections for initial checks.
