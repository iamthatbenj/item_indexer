# PRD: Private family belongings archive

## Problem Statement

Families have belongings whose importance is not apparent from their appearance or financial value. The people who know an item's origins, previous keepers, associated memories, and sentimental meaning may live elsewhere, recall events differently, or never use the application themselves. Without a shared record, those stories can disappear when belongings move or relatives are no longer available to tell them.

A conventional inventory captures objects but not necessarily their meaning. A shared document makes photos, attribution, consistent organization, and safe collaboration difficult. Links to marketplace listings can disappear, leaving little useful evidence. An online-only archive also leaves families dependent on a particular service continuing to exist.

The family needs an approachable mobile web application that makes quick capture easy, supports equal contributions without silently losing work, keeps collections private, and produces useful printed and independently recoverable archives. Financial documentation is helpful but must not displace the primary purpose of preserving family history.

## Solution

Build a private, mobile-friendly family belongings archive with these priorities, in order:

1. Preserve family history and sentimental meaning.
2. Provide a useful inventory for finding and understanding belongings.
3. Optionally preserve financial comparison evidence.

Each family collection has its own invited membership, independent of where belongings are physically kept. Members have equal editorial rights. Family administrators manage access and recovery, not editorial truth. One person may participate in multiple collections.

A member can save a draft item with one photo, then add a name, short description, current keeper, location, category, and attributed stories later. A story credits the person whose recollection it expresses, who need not be the person entering it or an app participant. Conflicting recollections can coexist. Shared edits retain history and explicitly reconcile conflicts rather than silently overwriting work.

Optional supporting evidence preserves images or PDFs of receipts, comparable listings/results, and other documents, with source and price context where available. It does not automatically establish an item's value.

Every member can produce an illustrated family catalogue, a compact inventory PDF, and a portable archive. The archive contains retained high-quality images and structured records, not a promise of camera originals. It can recreate content in a new collection without restoring old access permissions. Operational backups provide a separate, limited recovery mechanism.

The first release is a personal, non-commercial pilot targeting approximately 100–1,000 items per collection, without a hard product cap, and an operating budget below $10/month. That budget is a target requiring validation, not an established cost guarantee.

## User Stories

### Joining and private participation

1. As an approved founder, I want to create a family collection, so that my family can establish its own private record without opening public registration.
2. As a family administrator, I want to invite relatives by email, so that I can control who gains access to our collection.
3. As an invited relative, I want to sign in using an email code, so that I do not need to create and remember another password.
4. As a family administrator, I want invitations accepted only by the invited email identity, so that forwarding an invitation does not itself grant access to someone else.
5. As a family member, I want to remain signed in on a trusted device, so that frequent capture does not repeatedly interrupt me with authentication.
6. As a family member, I want to participate in multiple collections and clearly see which one I am using, so that separate branches of my family can maintain separate records.
7. As a family member, I want other collections unable to access our records and files, so that a shared service does not expose our private history.
8. As a family administrator, I want to appoint other administrators, so that access management does not depend on one person.
9. As a family administrator, I want to remove a member's access, so that invitations do not grant permanent ongoing access.
10. As a family member, I want the same editorial rights as other members, so that I can contribute without waiting for a curator's approval.
11. As a contributor, I want to know that members may export content and that contributions survive membership removal, so that I understand the consequences of contributing.
12. As a family member, I want stories and attribution to remain when a contributor leaves, so that the family record does not depend on continued app membership.

### Capturing and organizing belongings

13. As a mobile family member, I want to capture or select an item photo and save immediately, so that I can document belongings before I have time to write their histories.
14. As a family member, I want photo-only records clearly identified as drafts, so that unfinished work is easy to return to.
15. As a family member, I want to add a name and short description to complete an item record, so that it is understandable even without a story.
16. As a family member, I want to record either a single object or a set as one item, so that I can choose the level of detail that makes sense for my family.
17. As a family member, I want to attach additional item photos, so that details such as maker's marks or individual components can be understood.
18. As a family member, I want to record an optional current keeper, so that relatives know who is caring for an item without implying legal ownership.
19. As a family member, I want to record an optional location, so that I can find belongings without making a house or address the collection's access boundary.
20. As a family member, I want to categorize an item, so that similar belongings can be browsed and filtered together.
21. As a family member, I want suggestions from existing categories and locations while entering details, so that quick entry does not create unnecessary duplicates.
22. As a family member, I want to add, rename, and merge shared categories and locations, so that our organization can evolve without administrator intervention.
23. As a family member, I want to search item names, descriptions, and stories, so that I can find an object using the memory I have of it.
24. As a family member, I want search results with photo thumbnails, so that I can recognize an item whose name I do not remember.
25. As a family member, I want filters for category, current keeper, location, and draft status, so that I can narrow a growing collection.
26. As a mobile family member, I want interrupted entry and uploads retained locally for retry, so that a poor connection does not silently discard my work.
27. As a family member, I want a clear distinction between pending local work and a successfully saved record, so that I know whether others can see my contribution.

### People, stories, and shared editing

28. As a family member, I want reusable named people with optional identifying notes, so that I can distinguish relatives with similar names.
29. As a family member, I want a person to be a storyteller or keeper without having an app account, so that I can document relatives who do not use the service.
30. As a family member, I want to enter a story told by someone else and credit them, so that recording a recollection does not misattribute it to me.
31. As a storyteller, I want my attribution distinguished from who entered or edited the text, so that the source of a memory remains clear.
32. As a family member, I want optional prompts about origins, previous keepers, memories, and meaning, so that I can tell a useful story without completing a rigid historical questionnaire.
33. As a family member, I want multiple separately attributed stories on one item, so that conflicting recollections can coexist without declaring one the official truth.
34. As a family member, I want to edit another member's story while preserving attribution, so that equal collaboration includes corrections and elaboration.
35. As a family member, I want recoverable edit history, so that accidental changes do not permanently erase earlier contributions.
36. As a family member, I want to be warned when someone saved a competing edit, so that I do not unknowingly replace their work.
37. As a family member, I want my conflicting draft preserved while I compare the newer version, so that reconciliation does not require retyping my contribution.
38. As a family member, I want to remove an item or story from normal view, so that mistakes or inappropriate content can be addressed without an immediate irreversible action.
39. As a family administrator, I want to restore removed records, so that accidental deletion can be corrected.
40. As a family administrator, I want to permanently delete removed content, so that recoverable deletion is not an obligation to retain everything forever.
41. As a family member, I want an item's departure treated differently from deletion, so that moving an object does not erase its place in family history.

### Photos and supporting evidence

42. As a family member, I want retained photos detailed enough for ordinary printing and reading fine details, so that storage savings do not defeat preservation.
43. As a contributor, I want to know before uploading that high-resolution originals may be reduced, so that I can retain my own originals if needed.
44. As a family member, I want photo orientation and colour preserved during processing, so that the retained image accurately presents the item.
45. As a contributor, I want hidden GPS, device details, and embedded timestamps removed from retained photos, so that exports do not accidentally disclose camera metadata.
46. As a family member, I want to attach images or PDFs of supporting evidence, so that a disappearing listing is not the only surviving source.
47. As a family member, I want evidence classified as a purchase receipt, comparable listing/result, or other document, so that different kinds of evidence are not confused.
48. As a family member, I want optional source links, notes, dates, prices, and currencies on evidence, so that later readers can understand what an attachment demonstrates.
49. As a family member, I want asking prices distinguished from confirmed sold prices, so that an advertised amount is not represented as a completed transaction.
50. As a family member, I want receipts for our actual item distinguished from comparisons involving similar items, so that purchase history is not mistaken for a current valuation.
51. As a family member, I want financial evidence to be optional, so that meaningful family documentation does not require pricing an item.
52. As a family member, I want uploaded evidence PDFs downloadable as supplied, so that they are not silently subjected to photo-specific transformations.

### Reading, printing, and independent preservation

53. As a family member, I want an illustrated family catalogue PDF, so that relatives can read and print photos, descriptions, and attributed stories together.
54. As a family member, I want a compact inventory PDF, so that I can review many items without printing the full narrative catalogue.
55. As a catalogue reader, I want an index and clear item sections, so that a large printed archive is navigable.
56. As a family member, I want to select which items to export, so that I can create an archive for a particular purpose or audience.
57. As a family member, I want control over including drafts and de-accessioned items, so that incomplete work and historical departures need not appear in every PDF.
58. As a family member, I want to include or omit financial evidence and edit history in PDFs, so that a family gift and an archival record can have different levels of detail.
59. As a storyteller, I want attribution retained in exports, so that printed copies preserve who remembers what.
60. As a PDF reader, I want the document useful without the app or live external links, so that the archive outlasts the service and marketplace listings.
61. As a family member, I want a portable archive of structured records and retained attachments, so that the family's data is not trapped in the application.
62. As a family member, I want the archive to retain stories, attribution, relationships, and edit history, so that preservation is more than a folder of unidentified images.
63. As a family member, I want deleted content excluded from portable archives and their historical payloads, so that removed material does not unexpectedly reappear in a download.
64. As a family member, I want to restore an archive into a new collection, so that portability is a demonstrated capability rather than a promise about a file format.
65. As a family administrator, I want restored collections to require fresh invitations, so that an old archive cannot silently reinstate access permissions.
66. As a family member, I want clear progress and failure outcomes for export and restoration, so that I do not mistake an incomplete archive or partial restore for success.
67. As a family member, I want export rights equal to other members, so that preservation is not dependent on an administrator being available.
68. As a contributor, I want to understand that downloaded or previously transferred copies cannot be revoked, so that I make informed sharing decisions.

### Operating a sustainable pilot

69. As the pilot operator, I want to approve founders, so that service usage cannot grow through unrestricted public collection creation.
70. As the pilot operator, I want to measure combined hosting, database, storage, email, processing, export, and backup costs, so that the below-$10 monthly target is tested against actual use.
71. As a family member, I want warning before upload capacity is exhausted, so that I can plan around an impending pause.
72. As the pilot operator, I want new uploads paused at conservative allowances and increases explicitly approved, so that storage growth does not silently threaten the budget.
73. As a family member, I want existing records to remain readable and exportable where possible during an upload pause, so that a capacity limit does not deliberately hold my history hostage.
74. As the pilot operator, I want email, read, and processing abuse limited as well as uploads, so that storage quotas are not mistaken for comprehensive spending protection.
75. As the pilot operator, I want a weekly backup of both structured records and retained files, so that operational recovery does not depend on members remembering to export.
76. As the pilot operator, I want the previous valid backup retained until a replacement is verified, so that a failed backup does not destroy the only known recovery point.
77. As the pilot operator, I want backup credentials isolated from the running app, so that an application mistake cannot modify the recovery copy.
78. As the pilot operator, I want a documented and exercised recovery procedure, so that restoration within a few days is a realistic expectation.
79. As a family member, I want the possible loss of up to seven days of contributions disclosed, so that I understand the weekly backup trade-off.
80. As a future family administrator, I want collection identities, attribution, and provenance preserved without cross-collection access dependencies, so that reviewed transfers can be added later without redesigning privacy boundaries.

## Implementation Decisions

### 1. Product boundaries and delivery approach

- Deliver a mobile-friendly web application, not a native app. Start as a personal, non-commercial pilot with approved founders and private collections.
- Target hundreds of items per collection, approximately 100–1,000, without claiming an unbounded scale guarantee or a hard product cap.
- The initial end-to-end proof should exercise two collaborating members, an isolated second collection, photo capture, an attributed story, both PDF formats, archive export, and restoration. Measure image quality, processing constraints, and cost before polishing the interface.
- Preserve the agreed priority order: family history, practical inventory, optional financial evidence.

### 2. Application boundaries

- Use Next.js with TypeScript on Vercel, Turso for structured records, and Cloudflare R2 Standard for retained files and generated exports.
- Establish cohesive boundaries for identity/membership, collection records, collaboration/history, file processing/storage, search, preservation/export/import, and operator recovery/usage controls. These are responsibilities, not a mandate to create separate services.
- Use stable identifiers for collections, items, people, stories, and attachments, independent of display names and current locations.
- Treat external file writes and database changes as operations that can fail independently. Explicitly represent pending, successful, and failed outcomes rather than presenting incomplete records or archives as complete. Retries must avoid accidental duplicate contributions or imports.
- Do not select additional infrastructure or complex abstractions until a real requirement and hosting constraint justify them.

### 3. Identity, membership, and authorization

- Distinguish authenticated account identity from a collection's named people and storyteller attribution. App membership is not required to be a keeper or storyteller.
- Scope records, people, taxonomies, searches, exports, and file authorization to a family collection. Account membership in one collection grants no access to another.
- Members edit equally. Administrators additionally manage invitations, membership, administrator assignments, restoration from deletion, and permanent deletion.
- Sign in with short-lived email codes and support persistent sessions on trusted devices. Use the existing domain with a verified transactional email provider selected before deployment.
- Require authentication as the invited email identity when accepting an invitation. Define code/invitation expiry, rate limits, session revocation, and safeguards against removing the final administrator during implementation planning.
- Removal ends future application access but cannot recall downloaded data or already issued short-lived file links. Keep file authorization lifetimes bounded and recheck access for new authorizations.
- Preserve contributions and attribution after membership removal. Explain export rights, contribution retention, and irreversibility of downloaded copies when joining.

### 4. Item records and structured organization

- An item represents one object or a family-defined set. Do not introduce nested item relationships in this release.
- Saving a draft requires at least one item photo. Completeness requires a photo, name, and short description; stories and financial evidence are optional. Prevent ordinary edits from silently violating the required-photo invariant.
- Keep structured item fields limited to name, short description, optional current keeper, optional location, and optional category.
- Store current keeper as a reference to a collection-scoped person, not as legal ownership or necessarily an account.
- Categories and locations are shared collection-scoped lists. Members can choose existing values or add, rename, and merge them without losing the association of affected items.
- Search names, descriptions, and stories; filter by category, keeper, location, and draft status. Show photo thumbnails and maintain collection isolation throughout search results.

### 5. Stories and concurrent collaboration

- People have a name and optional identifying note. Do not build a family tree.
- Stories are prompted free text. Preserve storyteller attribution separately from recording/editing account identity. Multiple recollections may disagree without being merged into a supposedly verified account.
- Retain recoverable edit history for shared records. Detect stale writes at the application boundary, preserve the contributor's draft, expose the newer version, and require reconciliation rather than silent replacement.
- No live collaborative editor or editing locks are required.
- Members may remove items or stories from normal view. Administrators restore or permanently delete them. De-accession remains a different domain event from deletion.
- Normal exports exclude deleted content. Archive history must not reintroduce the historical payloads of deleted records; this is not a promise to discover and redact every incidental textual mention in unrelated contributions.

### 6. Photo capture and retained files

- Support the phone photo workflows used by the pilot and verify real mobile formats before deployment. Do not claim format coverage solely from desktop image tests.
- Retain high-quality optimized photos with a maximum long edge of 3,200 pixels. Never upscale smaller images. Do not impose aggressive tiny file-size compression at the expense of legible details.
- Preserve visual orientation and colour while stripping hidden GPS, device metadata, and embedded timestamps. Test the output files, not just processing configuration.
- Explain before upload that retained images may not be camera originals. Exports and backups preserve retained versions.
- Store files privately in R2; keep structured metadata and relationships in the database. Verify collection access before issuing bounded upload/download authorization. Never expose storage credentials to the browser.
- Online-first does not mean discard-on-disconnection: preserve interrupted work locally for retry and clearly distinguish local pending work from server-confirmed persistence. Handle account/collection context safely on shared devices. Full offline editing and synchronization are not required.

### 7. Supporting evidence

- Accept images and PDFs, not arbitrary attachment types. Validate uploads and serve attachments safely; a filename or declared MIME type alone is insufficient trust.
- Classify evidence as purchase receipt, comparable listing/result, or other document. Support notes and optional source URL, date context, price, and currency.
- Make the distinction between asking price and confirmed sold price explicit. Historical purchase price is not current value; a comparable is not an appraisal.
- Retain evidence PDFs as supplied for download. Do not claim that photo metadata stripping or photo optimization applies to PDFs.
- Links supplement durable attachments. Do not scrape external sites or compute valuations in this release.

### 8. PDF outputs

- Deliver both an illustrated family catalogue and compact inventory. Catalogue sections present item photos, descriptions, attributed stories, and applicable accession/de-accession notes, with an index. Inventory favors concise, tabular review.
- Permit item selection, draft/de-accessioned inclusion controls, and financial-evidence/edit-history toggles. Preserve attribution in all applicable outputs. Exclude deleted content.
- Use retained content so documents remain understandable without the app or working external sources. Financial material must be optional for family-reading copies.
- Finalize readable layouts, pagination, evidence treatment, and practical export sizes through representative print/mobile checks. Do not assume arbitrary uploaded evidence PDFs can be safely or cheaply embedded into a single generated catalogue.
- Choose generation/progress/retry mechanics after measuring hosting limits. Large exports must not depend on keeping a fragile browser request alive or silently produce truncated success artifacts.

### 9. Portable archives and restore

- Export structured records, retained attachments, people references, attribution, relationships, and permitted edit history in a documented, versioned portable format. Include active and de-accessioned records; omit deleted content and its historical payloads.
- Package enough information to interpret the archive without access to private source records. Include explicit format/version and integrity validation so incomplete or unsupported archives are not silently accepted.
- Restore into a new private collection, never merge into an existing one in v1. Validate input safely and authorize collection creation/restoration under the pilot's founder controls.
- Preserve historical attribution as data without granting permissions to historical account identities. Require fresh invitations and explicit current administrator assignment.
- Failed or interrupted restoration must not leave a partial collection presented as a completed restoration or leak files to another collection. Define cleanup/retry behavior during implementation.
- Portable archives are user preservation artifacts, not operational backups or a promise to reproduce past application credentials.

### 10. Recovery and permanent deletion

- Run weekly operational backups covering structured records and retained files. Retain only the latest successful snapshot, keeping the previous valid backup until its replacement passes verification.
- Use a separate protected R2 bucket and separate backup credentials unavailable to the running app. Same-provider/account recovery is not independent protection from every account compromise or provider failure.
- Accept potential loss of up to seven days of contributions. Aim for operator-led restoration within a few days, not an automatic or guaranteed availability commitment.
- Verify recovery through a real restore before relying on the pilot for family records. Document the procedure and required operator access.
- Permanent deletion from live data is distinct from expiration of recovery copies. Deleted material may remain in the last backup until replacement; it must not be unexpectedly republished by ordinary exports or an unreviewed recovery process.

### 11. Budget controls

- Treat below $10/month as an operating target to validate across hosting, database, storage, transactional email, file processing, generated exports, and backups.
- Prefer private R2 Standard storage over the previously provisional Vercel Blob choice. The later storage decision supersedes the earlier provisional statement; recheck current allowances and pricing before deployment.
- Warn before conservative file allowances are exhausted, then pause new uploads until the operator approves more capacity. Keep existing records readable/exportable where possible.
- Add appropriate limits for email requests, reads, processing, imports, and generated exports. Upload quotas alone are not a complete billing cap; do not promise an absolute spending guarantee.

### 12. Future transfer compatibility, not a v1 transfer workflow

- Preserve stable identifiers, collection scoping, attribution independent of app membership, explicit attachment relationships, and room for provenance metadata.
- Do not require records in one collection to read private records or files in another. A future recipient must receive an independently usable copy rather than a perpetual access bridge.
- The agreed future workflow is source-administrator offer, reviewed selection of disclosed content, receiving-administrator acceptance, retained source history with a de-accession note, and an independent receiving record with an accession note. Later contributions do not synchronize.
- Do not build unused transfer screens, tables, or a generic workflow engine merely to reserve this addition path.

## Testing Decisions

### Principles and existing prior art

- Test observable behavior and durable outcomes, not private helpers, implementation call sequences, or component internals.
- Prefer the highest practical seam: user journeys through the web application; exported artifacts; round-trip restoration; application-facing authorization and concurrency boundaries.
- The repository currently contains documentation only. There is no existing application test framework, code seam, or comparable test suite to reuse. Select a minimal test toolchain during implementation; the following seams were explicitly confirmed with the user.
- Use focused integration tests where browser-only coverage would obscure exhaustive authorization, concurrency, or partial-failure cases. Exercise real database/file behavior in isolated test resources; simulate external email delivery and failure injection where appropriate. Never use real family content or production credentials as fixtures.

### Confirmed test seams and acceptance coverage

1. **Browser-level collaboration:** an approved founder creates a collection; an administrator invites a relative; the relative accepts as the correct email identity; both can edit an item and attributed story. A non-member and an authenticated member of a different collection cannot retrieve the records or authorize their files.
2. **Authentication and membership:** expired/incorrect email codes, mismatched invitation identity, removed membership, and privileged actions fail safely. Administrator safeguards prevent accidental loss of all collection administration. Do not mistake hidden UI controls for authorization.
3. **Mobile capture:** a phone photo saves as a draft; name and description establish completeness; optional fields and extra photos remain optional. Test representative mobile browsers, camera/library input, touch interaction, and narrow layouts.
4. **Interrupted work:** an interrupted upload or save preserves retryable input, shows pending versus saved state accurately, and does not create duplicate records on retry. Locally retained content is not exposed to the wrong signed-in collection/account.
5. **People and memories:** a non-member storyteller remains attributed when someone else enters or edits the story; two conflicting recollections remain distinct. Removing membership does not erase history or grant access through the person record.
6. **Concurrent edits:** independent sessions edit the same version; the stale save cannot silently overwrite the newer version, and its draft remains available for reconciliation. Earlier versions remain recoverable through supported behavior.
7. **Organization and discovery:** search finds name, description, and story text; filters operate correctly; category/location merges retain item associations. Results, counts, and file references cannot cross collection boundaries.
8. **Deletion and access:** member deletion removes normal visibility; administrator restoration recovers it; unauthorized restoration/permanent deletion fails. Export/import history does not resurrect deleted record payloads. De-accession is not implemented as deletion.
9. **Real-file photo processing:** inspect actual retained files for dimensions, no upscaling, correct visual orientation, and removed hidden metadata. Manually assess receipt text, maker's marks, colours, ordinary photos, and print detail. No exact compression setting substitutes for fidelity checks.
10. **Evidence handling:** image and PDF evidence preserves type, price context, source notes, and asking-versus-sold distinctions. Supplied PDFs remain downloadable without unintended transformation. Unsupported, malformed, oversized, or unsafe uploads are rejected without being reported as valid saved evidence.
11. **PDF artifacts:** generate both formats from a representative collection and verify selected items, attribution, index where applicable, financial/history toggles, draft/de-accessioned controls, and exclusion of deleted content. Check pagination, text clipping, photo quality, long stories, and practical print readability. Core content remains useful with external links unavailable.
12. **Portable round trip:** export a collection with people, stories, photos, evidence, taxonomies, and permitted history; restore into a new collection; compare semantic content, relationships, attribution, and retained attachment integrity. Old membership permissions do not return, and the source collection is not required for reading the restored content.
13. **Import/export failure boundaries:** incomplete, malformed, incompatible, or interrupted archives do not result in apparent success, leaked files, or a completed-looking partial collection. Exercise retries and authorization changes while long-running work is in progress.
14. **Operational backup recovery:** create a real weekly snapshot, verify it, restore into isolated resources, and compare both records and files. A failed replacement must leave the prior successful snapshot usable; the app's normal credentials must not be able to modify the backup. Exercise the documented operator recovery procedure.
15. **Usage and feasibility:** warnings precede upload pauses; new uploads are blocked at configured allowances without deliberately disabling existing reads/exports. Test abuse controls and measure representative 100–1,000-item workflows, export workloads, storage/backup footprint, and provider constraints. Document whether the budget target holds rather than asserting it from free-tier marketing.

### Release evidence

Before relying on the app for real family records, demonstrate the end-to-end collaboration/isolation/export/restore journey, manually check representative mobile and printed outputs, complete a verified operational backup restore, and record a realistic cost/limits assessment. Features that cannot meet those constraints require an explicit scope or budget decision rather than a hidden weakening of the preservation promise.

## Out of Scope

- Cross-collection transfer offers, approval screens, receiving acceptance, automatic copying, and synchronization. Only addition-path constraints are in v1.
- Public item pages, public share links, unrestricted signup, paid subscriptions, and commercialization at launch.
- Native mobile applications, full offline capture/browsing/editing, and offline synchronization.
- Live Google Docs-style editing, edit locks, curator approval, or administrator authority over the truth of recollections.
- Legal ownership determination, a family tree, inheritance allocation, and estate-management workflows.
- Parent/child item hierarchies, nested sets, hierarchical folders, and building/room models.
- Automated comparable discovery, marketplace scraping, appraisals, automatic valuation, and treating asking prices as confirmed sale values.
- General-purpose attachment hosting beyond supported images and PDFs.
- Guaranteed storage of camera originals, hidden photo metadata preservation, and metadata removal from uploaded PDFs.
- Import merging into an existing collection, restoration of old credentials/membership, and migration from arbitrary third-party formats.
- Irrevocable control over downloaded copies, semantic redaction of every mention of a deleted person/story in unrelated text, and automatic removal of a departing member's contributions.
- Multiple retained backup generations, continuous recovery, independent-provider disaster recovery, zero data loss, guaranteed uptime, or a binding recovery SLA.
- An absolute billing cap or a verified claim that the entire service will operate for free.

## Further Notes

- This PRD synthesizes the agreed interview, domain glossary, initial-release plan, deferred-transfer plan, and architecture decisions. It is guidance for later vertically sliced implementation issues, not an instruction to implement the whole system in one task.
- Preserve the original intent when resolving technical details: an approachable family-history record that can outlast the service, not a valuation product with incidental stories.
- Settled choices include the product priorities, private independent collections, equal editing, administrator-controlled access, attributed recollections, minimal structured fields, both PDFs, restorable archives, retained high-quality photos, weekly latest-only backup, and the managed pilot stack.
- Remaining engineering choices include email provider/domain setup, concrete invitation/code/session lifetimes, final-administrator safeguards, supported mobile format processing, compression parameters, safe PDF evidence presentation, PDF/archive generation mechanics, archive schema/versioning, upload allowances, and backup scheduling. These should be resolved through implementation planning and evidence, not another general product interview.
- Provider pricing and capabilities change. Recheck them before deployment and include email, background work, backup storage, and export traffic in the cost assessment. No current free allowance is a durability guarantee.
- Future transfer implementation still needs explicit decisions about freezing reviewed offers, person matching, visible provenance, copied history, cancellation/retries, duplicate acceptance, and changed permissions. Those decisions do not block the initial release.
