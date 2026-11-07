# Prompted stories with separate storyteller and recording credit

Scope: [#10](https://github.com/iamthatbenj/item_indexer/issues/10). Any current member can record independent free-text recollections about a photo-backed item. Choose a reusable collection-scoped Person as **Storyteller**, separately from the authenticated family member recording it. The storyteller need not have an account; no person/account link or membership is created. Administration conveys no editorial priority. Conflicting recollections coexist; none is automatically a verified account.

## Interface and boundaries

The item page shows separate story cards, current storyteller name/identifying note, recording-member email and recording date. Emails are the existing account identifiers, not Person associations; recording account IDs are retained even after membership removal. Stories do not change item details, version, current keeper or draft/complete status. Missing stories do not prevent completion.

**Record a story in a new tab** preserves any unsaved item editor in the original tab. The separate form offers one required storyteller selection and one required text field. Optional expandable prompts cover origins, earlier keepers, memories and sentimental meaning. They are writing guidance, not four required fields or separately stored historical claims. Use any/all/none. Same-name people appear with identifying notes. Add a missing person in another tab, then refresh storyteller choices without losing story text or selection.

Story text is plain text, up to 10,000 JavaScript UTF-16 code units; surrounding Unicode whitespace is trimmed, internal line breaks preserved. Blank/over-limit/null-containing text is rejected; HTML-like text renders literally. A valid UUID identifies the recording request. Client-selected recording/editing identities, timestamps, version and storyteller version have no authority.

- `GET /collections/:collection/items/:item/stories/new`: private form; anonymous visitors redirect to sign-in, nonmembers/inaccessible items get not-found.
- `POST /collections/:collection/items/:item/stories`: exact-Origin URL-encoded form, exactly one each of `id`, `storyteller`, `text`, with a **96 KiB** bound. This accommodates maximum-length percent-encoded Unicode; existing other-route limits are unchanged.
- Story reads are server-rendered on the authorized item page. No public story/share link, standalone story-read JSON API, editing, deletion, history browser or reconciliation API is introduced.

The server freshly checks membership and item scope, active-photo existence, and storyteller membership in the **same collection** inside the write transaction. Belonging to both collections does not permit cross-collection attribution or recording on a substituted item. Failed writes leave no partial story. Inaccessible items/operations return 404, signed-out JSON writes 401, invalid fields/references 400, changed-content operation reuse 409. Successful/expected-error POST JSON is private/no-store. Unexpected driver errors use the existing generic 503 boundary without serializing SQL, story content or private diagnostics.

## Durable identity, attribution and retries

Additive migration `0007_attributed_stories.sql` introduces `stories` and an item/order index. A story retains:

- Stable story ID and item relationship (collection derives from the item).
- Stable storyteller Person ID and their identifying version at recording.
- Current text and story version, initially 1.
- Original recording account/time, distinct from last editing account/time (initially the same).
- Internal creation-request fingerprint for retry deduplication.

The initial saved story is its current version; no unused revision table is needed before story editing exists. When editing ships, it must snapshot that initial version, including storyteller/recorder/editor identities and times, before replacing it, just as item/person editing already captures previous versions. Recording identity must never be overwritten by editing identity. Multiple contradictory stories remain independent stable records, not competing versions of one canonical account.

Current cards use the Person's current name/note, consistently with current-keeper labels. Renaming identifying details does not rewrite a story or its historical credit. Resolve the recording-time `(Person ID, version)` from current `people` when versions match, otherwise from `person_revisions`. No assumption that a Person becomes an app member is needed. Accounts, people, stories and identifying history remain after collection membership removal. Future merge/purge implementations must handle current and historical references, not just visible labels.

Creation hashes cover normalized text and selected Person ID, not mutable identifying labels. A retry checks authorized item scope, initiating account, request UUID and original hash, returning the existing success without duplicating or rewriting a story, even if the Person has since been renamed. Concurrent same-operation saves serialize. A new UUID creates a separate story even when text/credit match; same-name people are never merged.

A failed/uncertain acknowledgement preserves text and selection in-page. Retrying the unchanged request resolves a committed success without duplication. If input changed after a lost success, a 409 preserves the attempt, disables further submissions and offers saved stories in another tab; it does not overwrite the original story or silently generate another request. This is in-page preservation only, not offline editing or tab/reload recovery. A successful record navigates to the item and anchors its story card. The original item's separate tab needs refresh to display new stories; copy unsaved edits before manually reloading it.

## Preservation and verification

No PDF/portable archive has shipped yet. Future outputs/restores must include story IDs, text/versions, item relationships, storyteller IDs and identifying-version references (including the Person versions needed to resolve them), original recording identity/time, editing identity/time and future prior story versions. Restoring records must preserve credit/provenance without restoring membership grants. Never substitute recording account identity for storyteller credit. Future removal/export work must exclude removed story content, including historical payloads exposing it, while operational backups remain separate.

Private photos, metadata stripping, optimized-photo retention and R2 authorization are unchanged. There are no new files, secrets, provider resources, email messages, automatic historical fields, family tree or account links. General usage/billing limits, backups and interruption recovery remain later slices.

```sh
npm test -- tests/stories.spec.ts
npm test
npm run typecheck
npm run build
npm audit --omit=dev
node --test tests/pre-commit-review.test.mjs
git diff --check
```

The 12 dedicated real-database/storage browser/integration cases cover ordinary members recording non-member storytellers, distinct recording identity, same-name contradictory recollections, optional prompts/natural text, refreshing choices, current labels versus historical Person versions, public read/write isolation and foreign-reference substitution, stale membership removal with retention, concurrent/idempotent/changed-content retries and attempted operation theft, injected late insert failure, lost acknowledgements, bounds/full-length Unicode/forged fields, populated version-six migration rollback/rerun with file/session/keeper-history preservation, and mobile/keyboard/escaped long text. Earlier migration fixtures remove the empty story schema before constructing legacy databases. Tests use disposable local resources, not production credentials. Manual assistive-technology/device checks supplement automation.

## Deployment and rollback — approval still required

The operator confirmed production migration #7 is complete. Application deployment and hosted acceptance for #10 remain pending. For future environments, apply migration #7 using the protected production procedure **before any auto-deploying push**. No new secrets/resources/bucket settings or capture pause are needed: #9 remains compatible with the additive table/index. Do not edit applied migration checksums or remove existing data.

Prefer fix-forward. Rolling the application back to #9 keeps story rows, credit and relationships intact but hides stories and removes recording routes; retain the schema for a compatible forward deployment. The earlier #9 keeper-history rollback caveats still apply when considering versions older than #9. Application rollback is not database recovery; backup/recovery acceptance remains separate, and this pilot must not be the sole family record.

Hosted/manual acceptance after approved rollout:

1. Record two disposable same-name people with identifying notes, including a non-member. As another member, record two differing recollections credited separately to them; verify storyteller and recording credit are visibly distinct.
2. Use optional prompts or ignore them entirely. Verify both stories remain and item completeness is independent of stories.
3. Open the form from an item with unsaved details; check the original tab stays intact. Add a person in another tab, refresh storyteller choices and verify story text/selection remain.
4. Verify another member sees the cards and a signed-out/foreign-collection session cannot access the item/form or record on it.
5. Check long text, real mobile keyboard and screen-reader labels/feedback. Do not use sole-copy valuable recollections for initial failure/conflict checks.
