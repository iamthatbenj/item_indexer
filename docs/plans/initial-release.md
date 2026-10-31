# Initial release: family belongings archive

## Purpose and priorities

1. Preserve family history and sentimental meaning.
2. Provide a practical inventory.
3. Optionally preserve financial comparison evidence.

Mobile-friendly web application, initially a personal, non-commercial pilot. Target hundreds of items per collection, approximately 100–1,000, without a hard product cap. Operating budget target: below $10/month; actual combined costs remain to be validated.

`CONTEXT.md` defines domain terminology. This document records product and implementation decisions, not glossary definitions.

## Collections and access

- Separate private family collections, each with independent membership. A person can participate in multiple collections. Collections are not locations.
- Approved founders may create collections; no unrestricted public signup.
- Invited members have equal editing rights, including editing each other's stories. Multiple administrators manage invitations, access, restoration, and permanent deletion, without greater editorial authority.
- No public pages or public share links in v1.
- Email-code sign-in, persistent sessions on trusted devices, and invitations tied to the invited email address.
- Use an existing domain; select and verify an email delivery provider before launch.
- Removing membership does not erase attributed contributions. Explain this, and the ability of members to export content, when joining.

## Item capture and organization

- An item may be one object or a set; no formal parent/child relationships in v1. Splitting a set is initially manual.
- Photo-first drafts: one photo is enough to save. Name and short description are required for completeness; stories are optional.
- Structured core: name, short description, optional current keeper, optional location, optional category.
- Current keeper does not mean legal owner and does not require app membership.
- Categories and locations use collection-specific shared lists. Members can add, rename, and merge values. No location hierarchy or address-based access model.
- Search names, descriptions, and stories, with photo thumbnails. Filter by category, keeper, location, and draft status.
- Online-first saving, with interrupted work retained locally for retry. No full offline capture, browsing, or editing commitment.

## People, stories, and editing

- Simple reusable people records: name and optional disambiguating note, scoped to the collection. No genealogy model.
- Storyteller, recording member, and editing member are distinct identities. A storyteller or keeper need not have an account.
- Stories use prompted free text for memories, history, and sentimental meaning, rather than extensive structured historical fields.
- Conflicting recollections can coexist as separately attributed stories.
- Preserve attribution and recoverable edit history. If another edit was saved first, preserve the current draft and ask the contributor to reconcile; do not silently overwrite. No live co-editing or edit locks.
- Members can remove items or stories from normal view. Administrators can restore or permanently delete them. De-accession is not deletion.

## Photos and supporting evidence

- Retain high-quality optimized photos, with a maximum long edge of 3,200 pixels. Never upscale. Validate compression against real item photos, receipt text, and maker's marks; do not force a tiny file-size target.
- Retained photos are not necessarily camera originals. Explain the irreversible reduction before upload; archives contain retained versions.
- Strip hidden metadata, including GPS, device details, and embedded timestamps, while preserving visual orientation and colour.
- Supporting evidence types: purchase receipt, comparable listing/result, other document.
- Accept manually supplied images/screenshots and PDFs, not arbitrary file attachments, with notes and optional source link, price, currency, and date details. Distinguish asking prices from confirmed sale prices and receipts for the actual item from comparables.
- Evidence is optional. No scraping or automatic valuation in v1. External links are supplementary, not the only durable evidence.
- Retain uploaded evidence PDFs as supplied for download; do not assume photo optimization or photo metadata stripping applies to PDFs.

## Exports and restoration

- Two PDF formats in v1: illustrated family catalogue and compact inventory.
- Catalogue includes readable item sections, photos, descriptions, attributed stories, and applicable accession/de-accession notes, with an index.
- Select items and include/exclude drafts and de-accessioned items; toggle financial evidence and edit history. Preserve storyteller attribution.
- PDFs must remain useful without the application or working external links.
- All members may export PDFs and a portable archive containing structured records, retained photos, stories, attribution, and edit history. Explain that downloaded copies cannot be revoked.
- Portable archives exclude deleted content, including historical versions that would reveal it. Operational backups are separate.
- V1 must restore an archive into a new collection, preserving content and attribution but requiring fresh invitations. No merge into existing collections.

## Infrastructure and recovery

- Next.js with TypeScript, Vercel hosting, Turso for structured records, and private Cloudflare R2 Standard storage for attachments and generated exports.
- Check collection authorization before issuing short-lived storage access. Do not expose storage credentials.
- Weekly backups; accept loss of up to seven days of contributions. Retain only the latest successful snapshot.
- Back up both records and retained files to a separate protected R2 bucket, with backup credentials unavailable to the running application. Keep the previous valid backup until its replacement has been verified.
- Same-provider/account backups do not protect against every account-level or provider failure. Target restoration within a few days through an operator-run, documented and tested recovery procedure; this is a pilot expectation, not a guaranteed service-level agreement.
- Verify full restore behavior, not merely successful backup creation.
- Pricing checks found Vercel Blob Hobby's 1 GB included storage and access suspension on exceeded limits unsuitable for the intended budget/headroom. R2 currently includes 10 GB-month of Standard storage and free direct egress; operations and other services still need budgeting. Recheck before deployment.

## Deferred transfers

Cross-collection transfers are explicitly deferred, but preserve the hooks described in `cross-collection-transfers.md`. Future transfers require source and receiving administrator approval, reviewed selection of disclosed content, retained attribution, source de-accession and receiving accession notes, and independent records without future synchronization.

## Unresolved launch work

- Verify actual combined costs, including sign-in email, processing, backups, and exports. Warn before conservative upload allowances are exhausted, then pause new file uploads pending operator-approved increases. Keep existing records readable and exportable where possible. Also limit email, reads, and processing; upload quotas alone are not an absolute billing cap.
- Validate phone image formats and upload recovery, image fidelity, large PDF/archive generation, and archive round-trip restoration within hosting constraints.
- Choose email delivery provider and configure the existing domain.
- Test a backup restore against the agreed recovery expectation of a few days before relying on the service for real family records.
- Finalize export layouts and archive format/versioning. Define safe handling of uploaded PDFs and how evidence PDFs appear in generated catalogues.
- Specify invitation expiry, session revocation, final-administrator safeguards, and interrupted operation behavior during implementation planning.
