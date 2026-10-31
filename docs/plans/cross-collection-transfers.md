# Cross-collection transfers

## Release scope

Defer the transfer workflow until after the first usable release. Preserve a clear addition path without building transfer screens or a general workflow engine now.

## Agreed future behavior

- A source collection administrator offers a transfer; a receiving collection administrator accepts it.
- The source administrator selects the photos, stories, and supporting evidence to disclose. The receiving administrator reviews exactly that selection.
- The source collection retains its record with a de-accession note; the receiving collection gets an independent record with an accession note.
- Copied stories retain storyteller attribution. Subsequent edits and contributions remain private to each collection; records do not synchronize.
- Physical movement, current keeper, collection membership, and permission to disclose history are separate concerns.

## Hooks to preserve in the first release

- Give collections, items, people, stories, and attachments stable identifiers independent of names and locations.
- Scope records and authorization to a collection. Do not assume one collection per account or equate a collection with an address.
- Keep storyteller identity distinct from account membership and edit authorship; preserve attribution in exports and future copies.
- Keep removal from a collection conceptually distinct from recoverable deletion. Do not use deletion to represent an item's departure.
- Keep item data and attachment references explicitly related, so a reviewed subset can later be copied without disclosing unrelated content.
- Avoid requiring a receiving record to read private source records or depend on the source record continuing to exist. A future accepted transfer must produce an independently usable record and attachments.
- Leave room for provenance metadata identifying a record's origin without treating that metadata as permission to access the source collection.

These are design constraints, not a requirement to introduce unused transfer tables or APIs in v1.

## Resolve before implementing transfers

- Whether an offer freezes its selected content or must be reviewed again when the source changes.
- How copied people are matched or distinguished within the receiving collection.
- Which provenance details recipients may see, and whether any edit history accompanies selected content.
- Cancellation, retries, duplicate acceptance, and behavior if collection access changes during an offer.
