# Deliberate reconciliation of item and story edits

Scope: [#11](https://github.com/iamthatbenj/item_indexer/issues/11), building on item version protection (#7/#9) and initial attributed stories (#10). Any current collection member may edit another member's story. Administration grants no editorial priority. Storyteller, original recording identity and editing identity remain distinct. Separate contradictory stories are not combined into a canonical account.

## Story editing and retained versions

Story cards offer **Edit this story in a new tab**, preserving any unsaved item details in the original tab. The private edit page shows storyteller credit, original recording member and last editing member. Only the text is editable in this slice: saving as another account cannot change the storyteller or original recorder, and client-supplied attribution fields have no authority. Identifying labels remain the Person's current name/note, while the recording-time Person version remains stable.

Story edits use the existing 10,000 UTF-16-code-unit plain-text bound, trimming surrounding Unicode whitespace, retaining internal line breaks and rejecting blank/over-limit/null-containing text. Completion remains independent of stories. Unknown client-selected attribution, time, history or editing fields are not used. The POST requires exactly one `version` and `text`, uses exact-Origin URL-encoded forms, and retains the 96 KiB body bound needed for maximum percent-encoded Unicode.

Each effective story edit runs in a libSQL write transaction:

1. Recheck the current member, collection/item/story relationship, collection-scoped storyteller and active-photo existence.
2. Reject stale/invalid versions. Even stale text identical to today's saved text is rejected.
3. Insert the superseded story as a stable `story_revisions` row, with text/version, storyteller ID/identifying version, original recorder/time and the account/time responsible for the superseded state.
4. Conditionally update current text/version and the actual editing account/time. Recording identity, storyteller reference, story ID/item and creation retry metadata remain unchanged.

Prior version insertion and current-state changes roll back together. The initial recorded version is captured on the first edit, including stories recorded before this release. Current-version no-ops do not create revisions or change editor/time. Concurrent same-version writers cannot both commit. A later retry of the original creation request does not rewind edited text or create another story. Membership removal retains stories, earlier revisions, Person and account references.

Additive migration `0008_story_revisions.sql` creates only the prior-version table and its unique `(story_id, version)` constraint. Existing story rows, item revisions, keeper assignments and files are not altered. No pre-emptive version-one duplicates are needed while that version is still current.

## Comparing and deliberately revising

A 409 blocks saving but leaves the contributor's attempted item fields (including keeper) or story text editable and copyable. Existing separate-tab latest-record links remain available.

**Compare with latest saved item/story** loads a fresh private snapshot without navigating, changing fields, or advancing the editing version. It displays two labelled panels: latest persisted content and the contributor's current draft. Item comparison includes name, description and current keeper; story comparison includes text. Saved and attempted text are rendered literally, not as HTML. There is no semantic merge, editing lock or automatic field selection.

The contributor can close/reload the comparison, continue editing their draft or inspect latest in another tab without losing input. Only **Revise against version N** changes the expected editing version. It leaves every draft field unchanged, returns keyboard focus to the first editable field, and asks the contributor to review/revise before using the ordinary Save button. Reviewing alone writes nothing and reserves no version. Another intervening edit produces the same conflict and requires another comparison. Neither a photo/RSC refresh nor refreshing keeper choices silently advances the version, including after an explicit review.

Comparison fetch failures, lost connections, revoked access and malformed responses keep the draft and previous version. They do not enable saving based on an unread/invalid snapshot. A lost successful-edit acknowledgement leaves the attempted text; retrying the old version conflicts, and explicit review can confirm the already-saved content without manufacturing another revision on a no-op.

All preservation is **in-page only**. Reloading/closing the page or ordinarily navigating away is not interruption recovery. Copy valuable text before doing that. Reconciliation stays on the original editor, and its latest-record inspection links open separately. There is no history browser, automatic semantic merge, offline editing or local draft storage in this slice. Person identifying-detail conflicts retain #9's separate-tab workflow; the new comparison applies to item details and stories.

## Public boundaries

- Existing `POST /collections/:collection/items/:item/details` keeps its 16 KiB bound and item/keeper transaction checks.
- New `GET` on that same path returns only today's version and labelled item comparison fields, not history or storage keys.
- `GET /collections/:collection/items/:item/stories/:story` is the member-only editing page.
- `GET .../stories/:story/details` returns today's story version/text comparison; no historical-version lookup is added.
- `POST .../stories/:story/details` performs the version-checked story edit with the 96 KiB bound.

JSON comparison responses are private/no-store. Anonymous comparison/edit requests receive 401; inaccessible/substituted collection/item/story references receive 404 without private content. Stale saves receive 409. Invalid forms/versions receive 400, oversized forms 413 and foreign/missing origins 403. Story pages redirect anonymous visitors to sign-in and use not-found for nonmembers. The actual final save always rechecks authorization transactionally, even if access was removed after comparison or after acknowledgement. Already-fetched content/copies cannot be recalled. Unexpected write failures use the existing generic 503 boundary without exposing SQL or private diagnostic arguments.

## Preservation and scope

No PDF/portable archive is implemented yet. Future preservation outputs/restores must carry current story identity/item/text/version, original recording and current editing metadata, stable revision IDs and ordering, all superseded text and attribution fields, and the Person versions needed to resolve storyteller credit. Item revisions retain name/description/state, keeper identity/assignment version and editing identity as before. Reapplying prior text in the future must create a new attributed version, not rewrite history. Removal/export work must exclude deletion-bin content and historical payloads exposing it; operational backups remain separate.

No photos/files, private R2 credentials/authorization, optimization or metadata-retention policy change. No genealogy, Person/account association, story reattribution UI, verification flag, cost cap, backup or transfer machinery is added. Persistent interruption recovery remains its own slice.

## Local evidence

```sh
npm test -- tests/reconciliation.spec.ts
npm test
npm run typecheck
npm run build
npm audit --omit=dev
node --test tests/pre-commit-review.test.mjs
git diff --check
```

The 12 dedicated tests use independent real browser sessions and isolated real local database/private-storage resources. They cover cross-member story editing and initial/prior-state attribution; item keeper/text comparisons; repeated conflicts and deliberate saves; frozen versions across photo refreshes; atomic concurrent writes and no-ops; collection/item/story/reference/active-photo isolation; access removal after review; failed/malformed/closed comparisons with intact input; revision/update failure rollback; lost acknowledgements and original-create retries; form/version/Unicode bounds; populated version-seven upgrade/failure/rerun with intact files/sessions/credit; and mobile/keyboard/escaped comparisons. SQL is used for durable artifact inspection, legacy state and fault injection, not mocked internal-call assertions. Lazy Next development routes are compiled before stale editors open to avoid test-only Fast Refresh replacing the page.

## Production rollout and rollback — approval still required

Local implementation only. Production migration #8, deployment and hosted acceptance have **not** been performed for #11. Explicitly apply `0008_story_revisions.sql` using the protected production procedure **before an auto-deploying push**. No new secrets/resources/bucket settings or photo-capture pause are needed. The #10 application remains compatible during the additive migration/deployment interval. Never edit applied migration checksums or drop retained history to roll back.

Prefer compatible fix-forward. Application rollback to #10 hides story editing and in-page comparisons but preserves current edited stories, recorded attribution and prior-version rows. Existing #10 story creation/retries do not overwrite edited stories. Keep the added table/data intact for forward deployment. Older keeper/photo rollback caveats still apply to older targets. Application rollback is not database recovery, and backup/recovery acceptance remains separate; the pilot must not be the sole family record.

Hosted/manual checks after approved deployment, using disposable content:

1. As a second member, edit a story recorded by the first. Confirm storyteller and original recorder stay unchanged while last editing credit changes.
2. Open the same item in two sessions. Save in one; attempt the other. Compare newer name/description/keeper against the retained draft, close/reopen comparison, then explicitly review/revise/save. Confirm the deliberate result is visible to the other member.
3. Repeat with a story. Save another intervening version between review and final save; the stale revision must conflict again with attempted text intact.
4. Confirm comparison/closing/keeper-choice refresh and photo changes do not erase unsaved text or silently advance its expected version. Check real mobile layout, keyboard focus and screen-reader feedback.
5. On a disposable member, remove access after comparison. Final saves must be denied without erasing attempted input; other members still see existing stories and credit.

No hosted/manual result should be inferred merely from local tests or a successful build.
