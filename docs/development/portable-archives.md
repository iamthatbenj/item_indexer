# Portable collection archives (#17)

[#17](https://github.com/iamthatbenj/item_indexer/issues/17) shipped as `d7a49f5` after the operator reported production migration **0011_portable_archives.sql** complete. Vercel confirmed deployment, and the operator confirmed that a hosted download passed the offline verifier. This does not establish every mobile or provider check. Existing #16 code remains compatible with the added tables. No source records are rewritten and no capture pause is required. See the separate [archive preflight runbook](archive-preflight.md) for #18.

## Format and preservation boundary

The authoritative standalone specification is
[`assets/portable-archive/FORMAT.md`](../../assets/portable-archive/FORMAT.md), copied
into every ZIP with `data.json`, `manifest.json`, `verify.py` and referenced retained
JPEG/thumbnail bytes. See [ADR 0003](../adr/0003-versioned-self-contained-portable-archives.md).
This is a **format-1.0** contract, not a database dump or an implementation of
restoration/merge/transfer. Python 3's standard library can independently validate
and interpret it; a normal ZIP/JSON reader can inspect it without Python or the app.

All current saved items, people (including unused people), stories and supported
item/person/story revisions are captured together. Initial never-edited item
credit/time can be null in legacy columns; created_by/created_at supply original
credit. References to historical people resolve against the corresponding person
version. Independent/conflicting stories remain separate; storyteller, original
recorder and editor are not conflated. Contributor labels survive membership
removal without conferring permission. Current keepers are not legal owners.

Every active photo includes **unchanged retained main bytes AND its existing
thumbnail**, with portable paths, byte counts and SHA-256. Main bytes must match
the database's retained checksum and count before publication. Thumbnail checksums
are computed during export because retention did not originally persist them.
Each thumbnail must first fully decode as a JPEG within 480×480 pixels under
strict decoder warnings and pixel limits; header parsing or JPEG magic bytes alone
cannot establish decodability. The original compressed bytes are preserved, not
re-encoded. Offline verification checks byte/hash/graph integrity, not image decode
or authenticity of a repackaged manifest.
Removed photos retain removal metadata/credit and historical checksum, but no
binary descriptor: deleted files are not resurrected. These are optimized retained
photos (at most 3200 px/long edge), not camera originals or inferred camera dates.

Explicit field allowlists exclude memberships/roles, invitations, sessions,
challenges, approvals, rate limits, provider credentials/configuration, upload
intents, creation idempotency hashes and local unsaved browser drafts. Only
referenced contribution identity labels plus the snapshot requester are included,
not a dump of all accounts. Generated PDFs/other derivative jobs are excluded;
exact reconstruction of earlier PDF snapshots is not promised. Later supporting
evidence and other data features must extend this contract/tests rather than
silently omitting new source fields. A schema-column regression detects additions
that need such an explicit preservation decision.

Archive source identity is `(source collection ID, record type, record ID)`, with
version/revision identity where applicable. Type matters: initial item/photo IDs
can be identical. Future independent copies must assign new destination IDs,
retain origin labels and remap ALL relationships locally, without old credentials,
permissions or cross-collection reads. This slice exports the evidence for that
path only; it does not implement it.

## Public workflow and private implementation

`/collections/:id/archive` is linked from the collection. Any current member can
request, inspect, retry, discard and obtain new download authorization. Requests
are account-pinned and protected by the existing same-origin form boundary.

- A stable create UUID reconciles lost acknowledgements. Request acceptance is not
  an archive-completion claim. Current membership scopes all metadata and new grants.
- `archive-snapshot.ts` reads explicit scoped source columns in one transaction,
  validates the reference/version graph and freezes it in a private durable job.
  Bulk reads avoid per-item network round trips. Original private object keys stay
  inside that operational snapshot; archive paths do not depend on old storage.
- `archive-zip.ts` verifies bounded source files and writes a standard ZIP using
  `yazl` to a private temporary directory (0700, file 0600). It consumes one bounded
  file at a time, not all photos in RAM. Output bytes/hash are measured while
  streaming to disk, then uploaded with a known Content-Length. No multipart
  upload or new incomplete-upload lifecycle is needed. Cleanup runs on success and
  failure; a hard platform/process kill can prevent finally cleanup, so treat `/tmp`
  as sensitive ephemeral storage and monitor available space. No web route serves it.
- `archive-exports.ts` fences attempts with a 90-second lease. Work uses Next.js
  `after`, a cooperative 45-second deadline and a 60-second route/platform limit.
  Progress writes occur every ten files and on publication, not per photo/network
  round trip. Browser polling is bounded to 20 checks / 30 elapsed seconds; manual
  status checking works afterward. Abandoned leases become visibly interrupted.
- At most three attempts; retry uses the **original frozen snapshot**, not current
  edits. Request a new archive for subsequent saved content. A missing/deleted
  required file may require operator repair or a fresh snapshot, not futile retries.
- Publication rechecks membership and conditionally publishes only the matching
  live lease. A failed/ambiguous PUT or commit leaves candidates tracked/private;
  catch paths never delete a possibly committed canonical ZIP. No partial archive
  is advertised as complete.
- Download verifies ready/unexpired metadata and R2 HEAD byte/hash/MIME metadata,
  signs a private attachment URL (at most 60 seconds), then rechecks membership and
  canonical relationship after I/O. Already-issued URLs and downloaded copies
  cannot be recalled immediately; keep device copies private.
- Discard waits beyond active/recent processing, deletes tracked derivative keys,
  then removes metadata after another membership check. Source records/history and
  photos are untouched. A deleting/failed/expired job still consumes capacity until
  deliberately discarded. Another current member can finish derivative cleanup.

Archive jobs use separate tables from PDFs to avoid treating a ZIP as a PDF during
rollback, and a separate **two-request quota per collection**. Inventory/catalogue
retain their existing combined five-PDF quota. Archive candidates are nested under
`inventories/:collectionId/archives/:requestId/:lease.zip`, covered by the existing
approved `prune-inventories` seven-day prefix rule. No new bucket, secret, service,
queue, cron, public ACL or separate lifecycle rule is needed. Never expire retained
`photos/` or other source prefixes. Physical lifecycle cleanup is distinct from
seven-day download availability measured from the original request.

## Limits, costs and independent verification

Pilot rejection boundaries: **200 items, 2000 people, 1000 stories, 500 active photos,
10000 total domain rows including revisions/removal metadata, 200 contributors (plus a separate snapshot requester in format 1.1),
8 MiB structured JSON, 240 MiB declared main-photo bytes, 256 MiB final ZIP**.
These are not guaranteed throughput. Remote reads, upload time, concurrent
invocations, memory and ephemeral-disk limits may stop an otherwise under-limit
archive. No selection controls or silent truncation. Contact the operator rather
than splitting a family collection merely to fit a derivative.

A job adds two private GETs per active photo, a ZIP PUT per successful attempt and
HEAD/GET delivery operations. Disk usage can reach the final ZIP size per concurrent
attempt; retained-file buffering is bounded separately (20 MiB main, 512 KiB
thumbnail). Platform/provider usage and the below-$10/month pilot target must be
checked against actual hosted workloads/pricing, not inferred from local fixtures.
General capacity controls/observability remain #33/#34.

To inspect a download independently:

```sh
unzip -l family-archive.zip
# Read the format guide first; do not execute untrusted supplied scripts.
python3 assets/portable-archive/verify.py family-archive.zip
```

The trusted repository verifier reads without extraction, rejects duplicate/unsafe
ZIP paths, symlinks, encrypted/extra members, unsupported format versions and invalid
JSON keys, checks streamed bytes/SHA-256, then validates closed file relationships,
history continuity, historical person references and immutable storyteller/recorder
credit. Internal hashes are **not signatures or proof of historical truth**.

## Local validation and required-review chronology (not hosted acceptance)

```sh
npm run typecheck
npm test -- tests/archives.spec.ts
npm test
npm run build
npm audit --omit=dev
node --test tests/pre-commit-review.test.mjs
```

Initial typecheck/build passed, but the first browser launch failed during local
migration setup: the existing intentionally simple migration runner splits on
semicolons even inside SQL comments. The new migration's comment was corrected
without changing the runner or old migrations; an isolated disposable-file database
then applied/reran all eleven migrations successfully. No production data was used.

The first ten-scenario browser run completed six passes/four failures. All three
missing/changed-main/missing-thumbnail recovery cases passed; four failures occurred
in invitation setup before archive access assertions. The new fixtures omitted
sign-in before acceptance and used an email in place of the collection heading;
those fixtures were corrected without weakening app authorization. The expanded
**14/14 archive suite passed in 3.9 minutes**, including malicious/damaged ZIPs,
source-column coverage, representative binary size and escaped/mobile keyboard
delivery. Fresh typecheck, production build, zero-vulnerability production audit,
nine hook regressions and diff checks passed. The full **213/213 browser/integration
suite passed in 46.9 minutes**, including existing PDF, history, attribution,
account-isolation and migration regressions. Final typecheck/audit/diff checks
passed again. Both archive request/download production traces contain FORMAT.md
and verify.py, with no missing assets. Hook regressions are not a staged Pi review
of this work. This full-suite pass predates the following review fix.

The first required staged Pi review **blocked the commit**: a thumbnail beginning
with FF D8 could be truncated yet receive a newly computed valid hash and ready
status. A public-route regression reproduced that exact ready result with a
2-byte thumbnail. The fix fully decodes bounded JPEG thumbnails before appending
their unchanged bytes. Additional cases cover a metadata-readable but truncated
pixel scan and a valid JPEG exceeding the 480-pixel dimension bound; all exercise
failed/no-download publication and successful original-snapshot retry after repair.
Post-fix validation passed **17/17 archive scenarios in 4.1 minutes**, fresh
typecheck/build/audit/diff checks and nine hook regressions. Both archive route
traces include the format/verifier and native Sharp module with nothing missing.
The expanded 216-case full suite has not been rerun. No commit was created by the rejected attempt. Temporary logs:
`/tmp/item-indexer-archives-first.log`,
`/tmp/item-indexer-archives-fixtures-fixed.log`,
`/tmp/item-indexer-archives-build-final.log`,
`/tmp/item-indexer-archives-full.log`,
`/tmp/item-indexer-archives-hook-tests.log`,
`/tmp/item-indexer-archives-commit.log`,
`/tmp/item-indexer-archives-thumbnail-red.log`,
`/tmp/item-indexer-archives-thumbnail-green.log`,
`/tmp/item-indexer-archives-thumbnail-build.log`.

Measured local artifacts (disposable fixtures, not hosted performance/cost claims):

| Items | Active retained photos | ZIP size | Local operation |
| --- | --- | --- | --- |
| 1 with attributed stories/history and removed-photo metadata | 2 | 317,266 bytes | ~1.24 s richer export/download/inspection journey, including a second export after contributor departure |
| 20 | 21 (20 at 3200 px) | 6,103,109–6,103,122 bytes (~5.82 MiB) | ~0.72–1.31 s generation/download/standard-library verification across full/targeted runs |

The larger fixture uses distinct private object relationships, not embedded
thumbnails substituted for main files. One retained main image is 295,202 bytes;
exact main/thumbnail byte equality is independently asserted in the member test.

Cases inspect real public-route exports/ZIP bytes and standard-library decoding,
not mocked internal calls: exact high-quality main/thumbnail bytes; stable IDs and
keeper/person/story relationships; edit/recover history and original versus editor
credit; non-member/same-name people; departed contributors; absence of secrets;
source corruption/missing-file retry; account/collection/format isolation; revoked
new grants; private candidates; publication/membership faults; ambiguous concurrent
requests; leases/attempt caps; capacity/expiry/discard; schema rollback/reruns; offline
integrity rejection; and mobile keyboard download. These are completed local checks, not authenticated hosted acceptance or a claim of representative cloud throughput/cost.

## Rollout checklist and rollback

1. Review format, attribution/privacy semantics, actual ZIPs and resource limits.
   Check the agreed database backup before schema changes. Apply additive migration
   **0011_portable_archives.sql before any approved auto-deploying push**.
2. Confirm the existing private bucket and inventories/-only lifecycle are intact;
   no source-prefix expiry. Confirm Node `after` and a 60-second platform duration,
   adequate temporary space, and production traces containing FORMAT.md/verify.py.
3. Generate/download as an ordinary member with representative family records:
   verify exact retained photo bytes, current/history labels, separate credits,
   conflicting stories, historical person names and removed-photo metadata. Run
   the verifier with source access removed/offline; new grants must be denied to
   anonymous/unrelated/revoked accounts. Test phone download/unzip/readability.
4. Exercise retry with disposable records and controlled non-destructive service
   faults; do not corrupt real retained production photos to test a failure path.
   Record actual sizes/times/provider usage and user acceptance explicitly.

Rollback to #16 hides archives but preserves metadata/snapshots/candidate keys for
fix-forward or expiry. Preserve schema and source data; never drop tables or delete
an uncertain canonical object as a blind rollback. Existing #16 PDF behavior and
its separate five-request quota are unchanged. Already-issued URLs/invocations may
finish; downloaded copies cannot be recalled. Restoration/scheduled backup work is
not delivered merely because an archive can be downloaded.
