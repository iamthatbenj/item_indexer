# Multiple private item photos

Scope: [#8](https://github.com/iamthatbenj/item_indexer/issues/8). Current collection members can add views to an existing item, inspect each retained image at full size, and remove unwanted views without removing the last active item photo. There is no bulk ingestion, ordering editor, nested set model or image-editing interface.

## Interface and shared processing

The item page shows its active photos, with labelled full-size links and removal buttons. A single active photo has its removal control disabled, with explanatory text. The server independently enforces that rule for direct, stale and competing requests. Collection browsing shows each item once, with the oldest active view as its thumbnail. Removing that view automatically falls back to the next active view; no explicit cover-photo or ordering field is introduced.

The existing camera/library component also adds one additional view at a time. Every image follows exactly the original [private staging, actual-content validation and bounded processing](photo-drafts.md) path: at most 20 MiB input, supported static JPEG/PNG/WebP, max 60 MP/16,000-pixel sides, correct orientation, sRGB, hidden metadata stripping, max 3,200-pixel retained JPEG without upscaling, and a max-480-pixel thumbnail. Preupload retention/format disclosure remains visible. Existing per-account/global upload and processing limits apply to both capture and additions, without a separate extra allowance.

Photo actions refresh server-rendered views without navigating away from the item or discarding its editor's unsaved text. The editor retains the version paired with that text even if a photo refresh delivers newer item props. If another member edited meanwhile, saving the original text still receives a conflict instead of silently adopting the newer version. Image selection/retry preservation is still in-page only, not offline or across reloads.

## Routes and authorization

- `POST /collections/:collection/items/:item/photo-uploads`: begin/renew an item-bound upload using the caller's UUID and declared byte length.
- `POST .../photo-uploads/:upload/finish`: process and atomically attach the retained photo to that exact item.
- `GET .../photos/:photo`: authorize a specific active full image or `?size=thumbnail` for at most 60 seconds.
- `POST .../photos/:photo` with `confirm=yes`: recoverably remove that exact view.
- The existing item `/photo` endpoint remains the deterministic first-active-photo/thumbnail interface.

Every route checks the current session; every relationship operation checks current collection membership and item scope. No administrator role is required and administration adds no editorial priority. IDs, client-selected object keys/status/editor fields, or an unrelated collection's membership cannot authorize a view. New uploads are fixed to both their initiating account and item; the collection-level draft endpoints cannot finalize an existing-item upload, and another member cannot redeem its upload operation. Publication rechecks membership and the processing lease after storage I/O.

POSTs retain exact-Origin, URL-encoded content-type and 4 KiB body limits. Begin requires one ID and one size; removal requires one confirmation. The private bucket still has no public URLs. Removed views immediately stop receiving new download authorizations. Already issued short-lived URLs and downloaded copies cannot be recalled. Production R2/CORS/lifecycle/credential settings do not change.

## Relationships, retry and the last photo

Migration `0005_multiple_item_photos.sql` transactionally rebuilds `item_photos` without its old unique-per-item restriction. It preserves existing photo IDs, object keys, dimensions, hashes, bytes and capture times; backfills each original view's `created_by` from its item's capture identity; and adds paired removal account/time fields. Indexing covers item, removal state and deterministic display order. Existing item IDs, names/descriptions/versions, text revisions, memberships and sessions are untouched.

`photo_uploads.target_item_id` is null for initial draft capture and immutable for additional views. Newly published photo IDs use the upload operation's UUID; preexisting independent photo IDs remain unchanged. Unique photo IDs, write transactions, processing leases and attempt-specific object keys prevent ordinary retries from duplicating a relationship or sharing one worker's cleanup keys with another worker. A saved operation replay only returns its item URL; it never reattaches a subsequently removed view or recreates its files.

Removal is a **database-only recoverable change**, not an R2 delete. Within a single write transaction, the service checks the scoped photo and current membership, treats an already removed photo as an idempotent success, counts active views, and rejects removal when only one remains. Competing removals serialize, leaving at least one active view. Failed updates roll back without falsely acknowledging success. Losing an acknowledgement can be retried against the original photo ID without deleting a different remaining view. Object-storage outages do not prevent this metadata-only operation.

Photo additions/removals do not increment the **text editing version** or fabricate text revisions. Their own immutable photo identity, capture account/time and removal account/time preserve their lifecycle separately. These accounts identify contributing members, not Person/Storyteller credit. Membership removal retains these identities and files; whole-account erasure is not introduced.

## Cleanup, history and preservation

Both retained image and thumbnail remain stored for a removed view, with its relationship and attribution. They are excluded from the normal gallery, item-presence checks, thumbnail choice and download authorization. They are not a public history API: history browsing/recovery is still deferred. An operator can inspect retained relationships through privileged database access; this slice adds no member restore or purge endpoint.

**Never delete a retained object merely because its view is absent from the current gallery.** All `item_photos` rows, including removed ones, are legitimate retained references. Failure cleanup is limited to the current attempt's unpublished keys, after checking whether a commit actually succeeded. An uncertain reconciliation read leaves files intact for operator recovery rather than risking deletion of published history. The staging-only one-day lifecycle remains the only bucket expiration rule: do not expire the `photos/` prefix.

Later permanent deletion must coordinate relationship/history purging and exact object-key reference checks against all retained references, not just active views, and account for in-flight publication/leases. Only after proving a key is unreferenced may an operator/job delete it. Future references from story history, evidence or preservation jobs must participate in that check. Do not run a concurrent unreferenced-file sweep during publication or infer deletability from a prefix/listing alone. Current removal never physically deletes an object, so it cannot damage another retained view/history reference.

No PDF/archive is shipped yet. Future current-content exports must include every active retained view and its stable relationship/file/attribution metadata, not just the first image. The preservation rule excluding removed content (including historical payloads exposing it) also applies to removed photos; complete operational backups are separate and must retain these files/relationships for recovery. Do not export signed URLs, staging originals or credentials as preservation content.

Retaining removed views consumes storage. This release does not establish permanent-deletion UX, automatic orphan cleanup, backups, an absolute billing cap, or the full under-$10/month target.

## Local verification

```sh
npm test -- tests/item-photos.spec.ts
npm test
npm run typecheck
npm run build
npm audit --omit=dev
node --test tests/pre-commit-review.test.mjs
git diff --check
```

The dedicated suite uses the real isolated file database and private SeaweedFS service, not production credentials. It exercises two-member camera/library additions, full-size access, mobile layout, collection deduplication/thumbnail fallback, actual retained files/hash/metadata/orientation/resolution, invalid/animated content, authorization and item/uploader-bound operations, concurrent last-photo removal, removed-operation replay, database rollback, denied thumbnail writes, storage outage, revocation during storage I/O, browser lost-response retries, unsaved-editor/version preservation, bounded/expired/leased requests and populated version-four upgrade/rerun/failure rollback.

Native local libSQL can cache stale `SELECT *` column names across an external process's table rebuild (a column can appear as `undefined` despite correct persisted data). Upgrade assertions use explicit columns; migrated upload reads do likewise. Restart local app/client processes after schema changes. This observed native-client behavior does not establish a hosted Turso failure.

## Production rollout and rollback — approval still required

**Local implementation only. No production migration, deployment or additional hosted acceptance has been performed for #8.** No new secrets/provider resources or object-storage settings are needed.

Unlike earlier additive changes, this is a coordinated schema/application upgrade:

1. Obtain rollout approval and coordinate a short **photo-capture pause** with family members. Do not start the migration during ordinary capture traffic.
2. Run the explicit protected production migration procedure for migration #5. The runner commits the photo-table copy/replacement, index and upload-target change together; a late failure restores the original table and migration checkpoint. Do not edit previously applied checksums.
3. Push/deploy the compatible #8 application promptly, confirm the correct Vercel deployment is ready, then test capture/addition before resuming normal photo capture. Keep failed editors/selections open for retry.

**The previous #7 release's positional nine-column photo INSERT is incompatible once migration #5 adds columns.** It fails safely rather than publishing a half-created item, but capture is unavailable in the interval between migration and compatible deployment. Existing single-photo reads/text edits remain compatible during that interval. Do not describe migration-first as a zero-interruption rollout. If uninterrupted capture is required, prepare a separately reviewed compatibility rollout instead of following this procedure.

After migration #5, **do not blindly roll back the application to #7/#6**: their capture writes are incompatible and their queries do not filter removed views or deduplicate multiple views. Prefer a compatible fix-forward. If deployment fails, keep the capture pause in place while restoring a compatible application. Do not drop photo relationships, discard removal history or try to recreate the unique-per-item constraint after multiple views exist. Production database recovery remains a separate tested operational capability, not supplied by a Vercel application rollback.

Hosted/manual acceptance after approved rollout:

- Capture a disposable new draft, then add two additional views using camera/library where supported. Inspect portrait orientation, fine detail and full-size viewing on the actual device.
- Confirm a second family member sees the same views and can remove one, while another collection/signed-out browser cannot access their item/photo endpoints.
- Remove the leading view and check the collection still has one item with a valid fallback thumbnail. Remove down to one and confirm the final removal is prevented.
- Keep unsaved name/description text while adding/removing a view; verify it remains available and competing text still produces the intended stale-version conflict.
- Check keyboard/screen-reader labels, busy/error feedback and mobile width. Existing photo metadata/fidelity decisions remain in force.
