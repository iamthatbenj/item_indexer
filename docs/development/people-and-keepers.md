# Reusable people and current keepers

Scope: [#9](https://github.com/iamthatbenj/item_indexer/issues/9). Any current collection member can record and edit people and set, change or clear an item's optional current keeper. Administration conveys no editorial priority. A Person is independent of app accounts, membership and legal ownership. There is no family tree, life-date schema, account linking, person merge/delete interface or new public history API.

## Interface and privacy

Follow **Manage people and current keepers** from a collection. The private directory searches names and identifying notes within that collection. Same-name people are independent records; give them distinguishing notes. Names are required (up to 200 JavaScript UTF-16 code units), notes optional (up to 400). Leading/trailing Unicode whitespace is trimmed; null characters and over-limit input are rejected. HTML-like text is rendered as text. Search uses SQLite's literal substring matching and built-in `lower`, which is ASCII case-insensitive, not full Unicode case folding. The item picker uses browser locale case folding.

The item's existing shared-details form includes a **Current keeper (optional)** selector and a name/note filter. The selected person stays in the choices when a filter hides other results. Pressing Enter in the filter does not submit the item. Manage people in a separate tab and **Refresh keeper choices** to fetch the authorized directory without losing unsaved text, the selected person or the original editing version. Photo refreshes likewise preserve these fields. Keeper absence never prevents completion: retained photo, name and description remain the completion criteria.

Recording a person requires no email or invitation, creates no account/membership and grants no access. Renaming a person updates current identifying labels wherever that stable person is referenced; it does not change who recorded or edited earlier contributions. Removed members' people, revisions and editor account references survive collection-access removal. A keeper can be someone who has never used the app.

Routes:

- `GET /collections/:collection/people`: member-only directory/search page.
- `GET .../people/new` and `GET .../people/:person`: member-only create/edit pages.
- `GET .../people/records`: private, no-store directory JSON for refreshing choices.
- `POST .../people/records`: create with a client-generated request UUID, name and note.
- `POST .../people/:person/details`: save identifying details with an expected version.
- Existing `POST .../items/:item/details`: save item text and optional `currentKeeper` ID under the same item version.

Session and current collection membership are checked at every boundary, independently of role. Writes recheck membership and scope within a write transaction. Person lookups and directory rows are scoped to the requested collection; item assignment additionally verifies that its keeper belongs to that **same** collection, even if the caller legitimately belongs to both collections. Neither a person ID nor a client-declared editor, account, person version, status or collection field grants authority. Anonymous JSON requests get 401; inaccessible collections/people/items get 404. Public pages redirect anonymous visitors to sign-in and return not-found for nonmembers. No caching, public directory or share link is introduced.

The people POSTs use exact-Origin, URL-encoded forms and a 16 KiB body bound, including percent-encoded Unicode. Required identifying/version fields occur exactly once. Item details accept at most one `currentKeeper`: explicit empty means clear, omission preserves the current keeper for older clients. A forged/foreign keeper ID is rejected rather than creating a Person or moving one between collections. People creation/editing do not require photo storage; editing an item still requires an active retained photo.

## Durable identity, versions and retries

Migration `0006_people_and_keepers.sql` adds:

- Collection-scoped `people`: stable ID, name/note, version, original recording account/time, latest editing account/time, and an internal creation-request fingerprint.
- `person_revisions`: immutable previous name/note versions, stable revision IDs and the account/time responsible for each previous version.
- Nullable keeper Person ID and assignment-time Person version on current items and item revisions, plus an index. Existing rows default to no keeper; completion, text versions, files and relationships are unchanged.

Each effective person edit serializes authorization/version validation, prior-version insertion and a conditional current-version update in one write transaction. No-ops on the current version do not manufacture revisions; stale saves always fail, even if the attempted values happen to match. Prior-state editor/time come from the superseded state, not whoever replaces it. Original recording identity never changes. Required history insertion or current-state failures roll back together.

Creation retries use the same UUID, initiating account, collection and fingerprint of the original normalized name/note. A repeated successful request returns the existing person without duplicating or rewinding later edits. Reusing an operation for another account/collection is rejected; changing its original input after a successful creation gives a conflict requiring review. Duplicate names alone are never merged/deduplicated. The internal hash is retry metadata, not a Person/account association or a sign-in credential.

Keeper changes use the item's **existing shared version**, not a separate unsynchronized keeper save. A simultaneous text edit and keeper change cannot silently overwrite each other. Every effective change retains the previous keeper reference and its assignment-time Person version alongside the prior text/editor snapshot. Assigning a different person records that person's current version; merely renaming the same person or editing item text does not rewrite that historical assignment version. Clearing makes both keeper fields null. A no-op on the current version creates no history.

The item page displays the keeper's **current** name/note. Historical assignment references are `(Person ID, Person version)`; resolve a referenced version from the current person if versions match, otherwise from `person_revisions`. This preserves the identifying details known at assignment without overwriting historical editor identity when current labels change. Public history browsing remains deferred. Privileged operator retrieval must scope person/item histories to the correct collection and must not share unrelated records or credentials.

Conflicts preserve attempted fields on the original open page, disable saving and offer the latest saved record in a separate tab. Network/service/sign-in failures also preserve fields and permit ordinary retries. A lost person-create acknowledgement can be retried without duplication; a lost edit acknowledgement gets stale-version feedback on retry rather than a silent overwrite. This is in-page preservation only, not offline editing or recovery after closing/reloading the page.

## Preservation and limits

No PDF or portable archive has shipped, so there is no existing output to extend. Future exports/restores must include people and their stable identities, collection relationships, current and previous identifying versions, contributor account/time attribution, and current/historical keeper references with assignment-time Person versions. Remapping IDs for a new collection must preserve those relationships and provenance without conferring membership. Do not confuse editor accounts with Person/Storyteller credit. Future people merge/purge or collection deletion must account for all current and historical references, not merely today's item selections.

Photo processing, private R2 authorization, retained-versus-original disclosure and removed-photo retention are unchanged. This feature supplies no automatic valuation, invitation, financial evidence, backups, usage/billing cap or new provider resources. General expensive-operation limits remain a later slice. Collection members can already retain downloaded records; removing access cannot recall copies.

## Local verification

```sh
npm test -- tests/people.spec.ts
npm test
npm run typecheck
npm run build
npm audit --omit=dev
node --test tests/pre-commit-review.test.mjs
git diff --check
```

Tests use the isolated file database, captured mail and real private SeaweedFS files, not production resources or mocked internal calls. Coverage includes duplicate-name directory/search, non-account people, equal member editing, reuse/change/clear/optional completion, changed identifying labels and durable prior versions, preserved editor accounts, stale browsers and competing writes, refresh/unsaved-version safety, collection and account isolation, membership removal, forged fields and bounded/Unicode forms, injected database failures and rollback, lost-response retries, populated version-five upgrade/late failure/rerun, intact files/sessions/history, and escaped long text/keyboard/mobile width.

Anonymous requests precompile lazy Next development handlers before opening app pages so Fast Refresh cannot replace an intentionally stale editor during the test. This does not mock authorization or any persistence/storage boundary. Legacy upgrade fixtures explicitly remove only the empty people schema before reconstructing earlier versions. As with #8, explicit columns avoid relying on stale native libSQL `SELECT *` metadata across external schema changes; this is not evidence of a hosted Turso defect.

## Deployment and rollback — approval still required

**Local implementation only. No production migration or deployment has been performed for #9.** Apply migration #6 with the protected production procedure **before** an auto-deploying push. No new secrets, bucket settings, email configuration or provider resources are needed. Unlike migration #5's photo-table rebuild, this migration adds new tables and nullable columns: the existing #8 application remains compatible during the migration/deployment interval, with existing keeper fields null. Restart local processes after migrating. Do not edit previously applied checksums.

Prefer compatible fix-forward after this feature is used. An older #8 application does not display or capture keeper references in item revisions, so using it to edit items after keeper data exists loses that part of the historical snapshot even though current keeper columns remain. Do not describe rollback to #8 as full preservation compatibility. Keep schema/data intact and pause item edits if recovery requires operating an older release. Do not roll back to #7/#6 after the multiple-photo migration. Provider application rollback is not a database recovery capability.

Hosted/manual checks after an approved deployment:

- Record two disposable same-name people with different notes, including someone without an account. Search and inspect both from a second member.
- Set/reuse/change/clear an item's current keeper; completion must not require one. Change identifying details and check current item labels update without creating membership.
- Leave two person editors open: save one, confirm the other rejects stale input while keeping both attempted fields, and open latest separately. Repeat with competing keeper/text edits.
- Add a person in another tab, refresh keeper choices and add/remove a photo while an item has unsaved text/keeper; confirm inputs and editing version remain intact.
- Confirm another collection and a signed-out window cannot view people or assign foreign people. Supplement automation with actual mobile keyboard/screen-reader and long-label checks.

Do not use sole-copy valuable family details for initial conflict/failure checks.
