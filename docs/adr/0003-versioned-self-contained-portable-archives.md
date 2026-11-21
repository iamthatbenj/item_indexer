# Export versioned self-contained archives without access grants

Family Belongings preservation must not depend on continued app hosting, access to
an old account, or access to a previous family collection. Export a standard ZIP
containing UTF-8 JSON, unchanged retained optimized photos and thumbnails, a human
format specification, and an offline standard-library verifier. This follows the
retained-photo and private-R2 decisions; it does not promise camera originals.

The authoritative format 1.0–1.3 specification is `assets/portable-archive/FORMAT.md`,
also included in every archive. Required files have byte counts and SHA-256 entries
in a closed manifest. Hashes establish internal consistency, not signatures,
verified recollections or authority. Missing/corrupt required files and unresolved
relationships/history must fail generation, never produce a partial archive
advertised as complete. Removed photos retain removal metadata but no deleted
binary promise or resurrection.

Serialize explicit source-field allowlists, not database dumps. Preserve current
items, people, stories, current-keeper/person-version references, original
storyteller/recorder attribution, separate editor credit, supported revisions and
file relationships. Historical contributor labels include departed contributors
without exporting credentials, sessions, invitations, membership roles/grants,
approval lists, provider configuration or browser drafts. Operational generated
presentations/jobs are not retained source attachments.

Provenance is namespaced by source collection AND record type AND record ID; an
item and its first photo can share an ID. Preserve parent references, version
numbers, revision IDs and snapshot identity in each export. Restoration assigns
fresh identities, remaps relationships locally, and keeps origin labels in
format 1.1 and 1.2 re-exports. Format 1.2 preserves shared categories and locations, including historical item associations. Format 1.3 preserves retired labels and their active destinations. Old identities are evidence, not permissions or a
cross-collection read dependency. Restoration does not merge or transfer records
into existing collections.

Require current membership for generation and each new download grant, including
checks after storage I/O. Reuse short-lived private delivery and fenced, bounded,
retryable generation rather than a long browser request. No permanent public
archive URL. Once downloaded, private copies cannot be recalled.

Later source-data features must extend the documented contract and durable
artifact/relationship tests. Readers reject unsupported versions instead of
silently losing unfamiliar fields. Pilot size/time limits are explicit rejection
boundaries, not promises that maximum-size exports always fit a serverless
invocation or a below-$10/month service budget.
