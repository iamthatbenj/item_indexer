# Family Belongings portable archive — formats 1.0 and 1.1

This ZIP is a private, self-contained snapshot, not an invitation, login backup,
permission grant, valuation, or verified historical account. Keep copies private.
It contains UTF-8 JSON and unchanged retained JPEG bytes. No app, source account,
private storage URL, database driver or external schema is needed to read it.
Photos are the high-quality optimized files retained by the service, not a promise
of camera originals. Hidden camera metadata was stripped during initial retention.

## Contents and integrity

- `manifest.json`: `format` = `family-belongings`, `version` = `1.0` or `1.1`, `snapshot`
  equal to data.json's snapshot, and `files`, a complete list of every other ZIP
  member. Each entry has a relative `path`, exact uncompressed `bytes`, and
  lowercase hexadecimal SHA-256 `sha256` of those exact bytes.
- `data.json`: structured records described below.
- `FORMAT.md`: this specification.
- `verify.py`: a Python 3 standard-library-only verifier. It reads ZIP members
  without extracting paths, checks lengths/hashes, rejects duplicates/extra files,
  and checks relationships and supported history. Run a trusted copy with
  `python3 verify.py family-archive.zip`. Read embedded scripts before running them;
  for an archive of uncertain provenance, use a trusted verifier from the source
  repository instead of executing supplied code.
- `attachments/NNNNNN/retained.jpg` and `thumbnail.jpg`: active retained photos and
  their existing thumbnails, referenced explicitly by data.json. Ordinals are
  paths only, not stable record identifiers. Files are not re-encoded for export.

The manifest deliberately does not hash itself. Hashes detect missing/altered files
relative to a manifest; they are NOT a digital signature, proof of origin or proof
that recollections are true. Someone who rewrites both content and manifest can
create a new internally consistent archive. The app separately records the final
ZIP byte count and SHA-256 when publishing it. Required files cannot be omitted
while calling an archive complete. No URLs, bucket names or object keys are needed.

Readers must reject unsupported versions rather than silently dropping unknown
features. Future source-data additions must extend the documented contract and its
relationship/round-trip tests; incompatible changes require a new major version,
additive changes a documented minor version. Existing format-1.0 verifiers reject
other versions safely. JSON objects must have unique keys; all ZIP names must be
unique relative POSIX file paths (no absolute paths, backslashes or `..` segments).

## Structured data

Format 1.1 adds exactly one field to `data.json`: `origins`, an array of up to 10,202 entries with `record_type`, `record_id`, `source_collection_id`, and `source_record_id`. Each entry refers to a record in this archive, keyed uniquely by record type and local record ID. `record_type` is `collection` or the corresponding record array name. An origin entry for the collection is required. Local records without an origin were not imported into this collection; their origin namespace is this archive’s own collection. Origin labels are claimed provenance, never access grants or live links. A subsequent restore gives records new local IDs and retains the origin labels rather than replacing them. The manifest and data versions must match; use the verifier bundled with the archive.

`data.json` has `format`, `version`, `snapshot`, `collection`, `contributors`,
`items`, `people`, `stories`, `photos`, `item_revisions`, `person_revisions` and
`story_revisions`. Empty arrays are meaningful and allowed.

- `snapshot`: `id` (stable export request ID), `captured_at` (UTC Unix milliseconds),
  `source_collection_id`, `generated_by` (contributor ID). Retries preserve it.
- `collection`: `id`, `name`, `created_at`. Every contained domain record is scoped
  implicitly to this source collection; matching IDs in another collection do not
  imply shared access or a live dependency.
- `contributors`: `id`, `email`. These are historical contribution identity labels,
  including departed members; they are not accounts to reactivate. Only referenced
  contributors and the snapshot requester are included. Emails may themselves be
  sensitive. No role, membership, invitation, session, password, approval list,
  authentication token or idempotency digest is included.
- `items`: `id`, `name`, `description`, `status` (`draft` or `complete`), `version`,
  `created_by`, `created_at`, `last_edited_by`, `updated_at`, `current_keeper_id`,
  `current_keeper_version`. Status reflects identifying name/description, not the
  completeness or truth of history. A draft has at least one active retained photo.
  Legacy never-edited items can have null last-editor/time; their initial credit
  is created_by/created_at. Keeper references are both null, or identify a person
  and that person's saved version at assignment. Keeping is not legal ownership.
- `people`: `id`, `name`, `note`, `version`, `created_by`, `created_at`,
  `last_edited_by`, `updated_at`. People need not be contributors or app members.
  Duplicate names are not duplicate identity; retain IDs and identifying notes.
- `stories`: `id`, `item_id`, `storyteller_id`, `storyteller_version`, `text`,
  `version`, `recorded_by`, `recorded_at`, `last_edited_by`, `updated_at`. Preserve
  distinct stories even when they conflict. Storyteller is distinct from recorder
  and editor. Storyteller/recording credit is immutable across its revisions.
- `item_revisions`: `id`, `item_id`, `version`, `name`, `description`, `status`,
  `edited_by`, `edited_at`, `current_keeper_id`, `current_keeper_version`.
- `person_revisions`: `id`, `person_id`, `version`, `name`, `note`, `edited_by`,
  `edited_at`.
- `story_revisions`: `id`, `story_id`, `version`, `text`, `storyteller_id`,
  `storyteller_version`, `recorded_by`, `recorded_at`, `edited_by`, `edited_at`.
  Revision editor/time describe the saved historical version, not whoever later
  replaced it. Each current record at version N has exactly versions 1..N-1 in its
  revision array; the current row supplies version N. Recovery is another edit,
  never a destructive rewrite. Resolve historical person labels using the matching
  version from people/person_revisions, not always the current name.
- `photos`: `id`, `item_id`, `width`, `height`, `photo_bytes`, `sha256`,
  `created_at`, `created_by`, `removed_at`, `removed_by`, `retained_file`,
  `thumbnail_file`. Active rows have null removal fields and two file descriptors
  `{path, bytes, sha256}`. Retained descriptor bytes/hash equal photo_bytes/sha256.
  Thumbnail bytes/hash are computed during export because original retention did
  not persist their checksum. Producers must first fully decode each thumbnail as
  a JPEG within 480×480 pixels, rejecting truncated/invalid images without changing
  the stored bytes. The offline verifier checks file bytes/hashes and relationships,
  not image decoding; repackaged hashes are not authenticity or content guarantees.
  Removed rows preserve historical metadata/removal
  credit, but BOTH descriptors are null: removed binary files are not retained or
  resurrected. Historical photo_bytes/sha256 do not promise an available file.

Record/revision IDs are stable opaque strings. Every contributor reference resolves
within contributors; every item/person/story reference resolves within this file.
Person version references resolve to a current or historical version. Timestamps
are technical contribution/removal dates, never inferred dates of historical events.

## Provenance and future copying/restoration

The tuple `(snapshot.source_collection_id, record type, record.id)` is the origin
namespace. Record type is essential: an item and its first photo may share an ID.
Versioned identity additionally includes `version`; revision events also preserve
their own IDs. Parent IDs and person-version references preserve relationships. snapshot.id identifies the frozen export, not
new editorial authority. A future independent copy must allocate destination IDs,
retain this provenance as labels, and remap ALL internal references locally. It
must not read the old collection or restore old account/membership permissions.
This contract supplies evidence for that path; this export does not implement
restoration, merge, transfers or permission restoration.

Operational upload intents, local unsaved browser drafts, generated PDFs/other
export jobs, authentication/access-management tables and provider configuration
are intentionally excluded. Generated presentations are derivatives, not retained
source attachments; exact recreation of earlier PDF snapshots is not promised
(for example, a photo removed since then is not resurrected by this archive). Supporting evidence and later
domain fields are not implemented in this version and must not be silently added
or dropped without extending this contract.

Pilot generation limits: 200 items, 2000 people, 1000 stories, 500 active photos,
10000 total domain rows including revisions/removal metadata, 200 contributors (format 1.1 allows a separate snapshot requester in addition to 200 record-credited contributors),
8 MiB structured JSON, 240 MiB declared active main-photo bytes and 256 MiB final
ZIP. These are rejection boundaries, not guaranteed throughput. All or nothing:
limits, missing files, checksum mismatch and interrupted generation fail rather
than producing a misleading partial archive. App download availability lasts seven
days, but a successfully downloaded private copy is independent of that expiry.
