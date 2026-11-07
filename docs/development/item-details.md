# Shared item names, descriptions and version protection

Scope: [#7](https://github.com/iamthatbenj/item_indexer/issues/7), following photo-backed drafts in #6. Any current collection member can edit the same item's name and short description. Administration conveys no editorial priority. One record can describe an object or a family-defined set without component/nested records.

## Completion and editing

The item detail page has labelled Name and Short description fields, saved-state feedback, and a draft/complete label. Collection thumbnails display the saved name and state. Neither text field is required to save unfinished work: a photo plus both nonblank fields makes an item complete; clearing either field makes it a draft again without erasing the previous contribution.

Names are limited to 200 JavaScript UTF-16 code units and short descriptions to 1,200. Leading/trailing Unicode whitespace is trimmed on save; internal line breaks in descriptions are retained. Null characters and over-limit text are rejected. HTML-like text is rendered as text, never HTML. Current keeper, location, category, story and financial data are not prerequisites. [#9 adds reusable people and an optional current keeper](people-and-keepers.md) to this same shared-version form, without changing completion requirements.

The client waits for hydration before enabling edits, disables controls while saving, and navigates to a fresh server-rendered item only after confirmed success. The POST sends a frozen editing version and text, not a client-selected status/editor/photo. Membership, item scope, retained-photo existence and the version are rechecked in one write transaction. Removing access while an old page stays open prevents further edits but does not erase existing contributions or account identity.

The endpoint uses the existing exact-Origin, URL-encoded form boundary. Its **16 KiB** body limit accommodates maximum-length percent-encoded Unicode input; photo endpoints retain their **4 KiB** default. Person forms have their own documented bound. Version/name/description must each occur exactly once. Signed-out requests receive 401, inaccessible items 404, invalid fields 400, and stale versions or missing required photos 409. The request cannot create an item or attach a photo. Unknown status/editor/photo fields have no authority. With #9, a single optional `currentKeeper` field selects a Person in the same collection (empty clears; omission preserves); keeper changes share this version check and prior-state capture. Driver failures return a generic 503 without SQL, text, identifiers or credentials in logs/responses.

## Revisions and stale saves

Migration `0004_item_details.sql` extends items with name, description, integer version (initially 1), last editing account ID and update time. The legacy draft-only status column is replaced by a virtual generated draft/complete value from canonical saved text, avoiding a second independently mutable completion flag. Published/editable items must have a retained photo; edit validation checks that relationship independently. Any future photo-removal implementation must preserve this invariant, especially for the last retained photo.

Each effective edit atomically:

1. Reads the currently authorized item under a libSQL write transaction.
2. Rejects a missing photo or a version different from the one presented for editing.
3. Stores the previous name, description, state, editing account and time as an `item_revisions` row with stable UUID and unique `(item_id, version)`.
4. Updates the current text, editing account/time and increments the version using a conditional version check.

The original photo-only version belongs to the capturing account at the capture time, including migrated records. Later snapshots retain the account/time responsible for that version, not the identity of whoever subsequently replaces it. The current version remains in `items` until superseded; prior versions are in `item_revisions`. Version numbers, not timestamps, establish ordering. A true no-op on the current version succeeds without creating a revision; a stale request is still rejected even if its text happens to match the current version.

Competing writers serialize; only one edit based on the same version can commit. Revision insertion and current-state changes roll back together. Photo IDs, storage keys, hashes, capture identity and item/collection IDs are unchanged by text editing. Membership removal leaves current details, revisions and account references intact. These account identities are editors/recorders, not Person or Storyteller credit.

On stale saves, the attempted fields remain editable/copyable on the original open page, the save button is disabled, and a clearly labelled link opens the latest saved item in a **separate tab**. There is no automatic rebasing, force-save or silent merge. Rich comparison/reconciliation and history browsing belong to later tickets. Generic connection/service/sign-in errors also keep text on the open page and allow retry. If an acknowledgement is lost after commit, retrying the original version gets a conflict rather than overwriting newer work or creating another revision.

This is **in-page preservation**, not storage across reloads/closing the tab or offline editing. Do not refresh the failed editor to resolve a conflict before copying its attempted text. Unsaved-work interruption recovery remains its own slice.

## Recoverability and preservation boundaries

There is intentionally no new public history/recovery endpoint or history-browsing UI. An operator with privileged database access can retrieve earlier text from `item_revisions`, joining through `items` and explicitly scoping the collection/item. An authorized member can reapply that text through the ordinary current-version form, creating a new attributed edit rather than rewriting old revisions. Do not share a database dump or revision contents across collection boundaries.

No PDF or portable archive has shipped yet, so there is no existing export to extend. Future preservation outputs must carry current text/version/editing identity, prior revision IDs/versions/text/state/editor/time, and the existing item/photo relationships. No unused export, restore or transfer API/schema is introduced by this ticket.

## Local verification

Use the existing isolated Playwright file database, private SeaweedFS test storage and captured local mail. Production credentials/resources are not used. Run:

```sh
npm test -- tests/item-details.spec.ts
npm test
npm run typecheck
npm run build
npm audit --omit=dev
node --test tests/pre-commit-review.test.mjs
git diff --check
```

The dedicated suite covers:

- Two member sessions completing/editing the same photo-backed object/set, including draft/complete transitions and clearing fields.
- Durable prior text and editor identity from the first edit; stable photo relationships and retained revisions after editor membership removal.
- Real stale-browser attempts, retained input and separate-tab latest-version review, concurrent same-version writes, and current-version no-ops.
- Cross-collection and anonymous denial, revoked membership on an already-open editor, required-photo enforcement and forged status/editor fields.
- CSRF/encoding/body bounds, duplicate/missing fields, invalid versions/nulls/lengths and full-length Unicode.
- Revision/current-state rollback under injected database failures; in-page retry after failure and a lost acknowledgement.
- A populated version-three upgrade, failure at the last migration statement proving complete rollback, rerun preservation, intact foreign keys/memberships/sessions/photo links, and further capture after upgrading.
- Escaped multiline/long text, labels, keyboard focus and 375px mobile overflow.

The revocation test warms the lazy development membership handler before opening the stale editor: Next development on-demand compilation can otherwise refresh the open page. This does not mock authorization or suppress a production application action. Manual mobile/assistive-technology usability still supplements automated checks.

## Deployment and rollback

**#7 was deployed as d90db2d after operator-confirmed production migration #4.** The operator confirmed completion/saved details, stale-save rejection with retained attempted text, separate-tab latest-version review, and visibility to another member. Additional manual device/assistive-technology checks below are not independently confirmed. Before an auto-deploying push, explicitly apply migration #4 with the protected production credentials using the hosted operator runbook. No new secrets, mail configuration, bucket settings or provider resources are required.

The migration uses transactional ALTERs, preserving existing items and photo foreign keys. It replaces the old status column but does not rebuild/drop item or photo tables. Existing records begin with blank text/version 1; history is recorded when the first shared edit supersedes that initial capture. The migration runner rolls back every ALTER if a later statement fails. Never edit an already-applied migration checksum.

Rollback means rolling the **application** back to #6 while keeping the new schema and data. #6 captures items using an explicit column list, which remains compatible with the added defaults and generated status; it simply does not display names/descriptions/history. Do not drop text or revision data, or attempt to undo the migration by restoring the old draft-only status constraint. Prefer a compatible fix-forward. **Once [#8 migration #5](item-photos.md) is applied, this older rollback advice no longer applies:** #7/#6 photo writes and photo queries are incompatible with the multiple-photo lifecycle. Follow the #8 coordinated upgrade/fix-forward procedure instead. [#9 keeper data adds another rollback caveat](people-and-keepers.md#deployment-and-rollback--approval-still-required): #8 does not capture keeper references in item history, so prefer compatible fix-forward once keepers have been assigned. Documented backup/recovery acceptance is still separate.

Hosted acceptance after approved deployment:

- Name and describe a real test draft, verify complete status/name in its collection and from a second member.
- Leave a second editor open; save from the first, then confirm the second receives conflict feedback with its attempted text intact. Open latest in a new tab and keep the original draft available.
- Confirm unsigned/foreign-collection access is denied, portrait photo viewing is unaffected, and clearing a field returns the item to draft.
- Check mobile keyboard/long-text behavior and screen-reader announcement of save/conflict feedback. Do not use valuable sole-copy family text as the first failure-test input.
