# Illustrated family catalogue (#16)

Local implementation of [#16](https://github.com/iamthatbenj/item_indexer/issues/16). The operator authorized a local commit after validation; push, production migration and deployment remain unapproved. Additive **0010_catalogue_exports.sql** is required before any approved auto-deploying push. Local automated verification is complete on patched Next.js 16.4.6, including the separately authorized security patch below. Hosted and final-print acceptance remain outstanding.

## What members receive

`/collections/:id/catalogue`, linked from the collection, generates a standalone A4 PDF of current saved records. Its index has printed page references and internal links to item destinations; PDF outline bookmarks also open item sections. Full item names appear in their sections; the fixed-height index may abbreviate unusually long labels. Collection/person label whitespace is normalized for presentation. The complete normalized collection name appears in the index body even when repeated headings abbreviate it.

Each item section starts on a new page and contains:

- Identifying name or draft placeholder, current description or its placeholder.
- Current keeper and identifying note where available, explicitly not a claim of legal ownership.
- **Every active retained photo**, ordered by creation time/ID, not just the inventory thumbnail. The frozen snapshot includes the retained JPEG's byte count and SHA-256; the worker verifies both against the downloaded original, bounds it to 20 MiB and 3200×3200 decoded pixels, then derives a JPEG of at most 1400 pixels/long edge without enlarging the source file. Original retained objects are not changed. Photos are fitted proportionally into a printable region; captions identify their sequence.
- Current saved stories in recording-time/ID order, kept separate even when they conflict or share a storyteller name. Storyteller names/identifying notes distinguish same-name people and do not require accounts. Recording account/time remain separate from storyteller credit. Edited stories show the current editor/time and saved version without replacing original recording credit. Contributors who left membership retain their credit; no access is restored.

Stories are independent recollections, not verified or canonical history. Person/keeper labels are current labels at snapshot time, not a reconstruction of recording-time names. Storyteller identity and original person-version references remain in the private frozen snapshot. App recording/editing timestamps are technical contribution dates, not inferred historical dates or camera metadata.

Long text flows across pages. Repeated page context identifies the item and, on story continuations, the story ordinal/storyteller name. Full identifying notes and credit are printed with each story; the header does not repeat arbitrarily large notes. Generous reserved heading space accommodates long names, at the cost of whitespace on shorter-label pages. Fonts and JPEG bytes are embedded, so a downloaded catalogue does not need the app, its accounts, signed photo links or external fonts. The first index/item rasterizations were inspected locally; actual phone readers/printers remain a human check.

Local unsaved drafts, previous text revisions, supporting evidence, financial details, item selection controls, transfers and final design/print approval are outside this slice. Draft items and items without stories are represented honestly rather than omitted. A missing required photo or unreadable retained original fails generation rather than silently creating a partial catalogue.

## Shared private pipeline, separate durable derivatives

`src/server/pdf-exports.ts` contains the shared authorization, snapshot request, fenced attempts, progress, private publication, download verification and discard behavior. `inventory-exports.ts` and `catalogue-exports.ts` bind it to hard-coded format-specific tables/renderers, not client-supplied SQL names. Separate catalogue tables allow rollback to #15 without treating catalogue snapshots as compact inventories. Cross-format download/retry/discard identifiers do not address another format's rows.

The renderer and snapshot/asset preparation are separate modules. Both PDF formats share grapheme-based embedded-font fallback in `pdf-text.ts`. Both lay out body text first and decorate buffered pages afterward; header drawing cannot replace an active body font or continuation wrapper during automatic pagination (the #15 CJK regression remains applicable).

The catalogue snapshot uses a short atomic transaction and **bulk item/photo/story reads**, avoiding two hosted database round-trips per item. Current collection membership authorizes creation and status reads. Stored snapshots and source keys are not exposed by the status API. Original recording/editing accounts are joined independently of current membership so departure does not erase attribution.

Reuse of #15's safeguards includes:

- POST request acknowledgement is not PDF success. Generation runs through Next.js `after`, with a cooperative 25-second deadline, 60-second route/platform limit and 90-second durable lease. Closing the page does not cancel an accepted request.
- At most 20 automatic checks and a 30-second elapsed checking budget, followed by explicit manual status checking. An abandoned lease becomes interrupted/retryable rather than remaining indefinitely unexplained.
- Stable creation UUIDs reconcile lost responses; at most three attempts use separate candidate keys. Retry preserves the original saved snapshot, even after story/keeper/item edits. Request a new catalogue for new saved content.
- Fresh membership checks after storage I/O and conditional publication prevent a revoked member or stale attempt from publishing. A failed/uncertain PUT or transaction never justifies deleting a possibly committed canonical PDF; candidate keys stay tracked and private.
- A new download requires current membership, ready/unexpired metadata and matching private object length/hash metadata/PDF type. Membership and canonical artifact relationship are checked again after HEAD/signing before returning a private/no-store redirect. Previously issued URLs can remain usable for up to 60 seconds; downloaded copies cannot be recalled. Keep device copies private.
- Any current member can discard a derivative after its active/recent lease is safely over. Tracked object deletion must succeed before metadata removal; saved family records, photos and stories are not deleted.

## Limits and cost boundary

Both formats share **five retained requests per collection**, including failed/expired ones, and each PDF is limited to **200 items, 250 pages, 16 MiB and a 2 MiB structured snapshot**. Catalogues additionally cap at **200 retained photos and 1000 stories**. These are rejection limits, not promises that every maximum-size narrative finishes in 25 seconds. No partial file is offered when a limit, timeout, unsupported glyph or missing object prevents complete output. Selection toggles are not implemented; contact the operator for larger-catalogue support rather than splitting a family collection merely to fit a PDF.

At most four items prepare concurrently, with photos processed sequentially inside each item, so at most four source reads/decodes are active. A photo-heavy single item can progress more slowly than several small items. The UI reports prepared **items**, not falsely completed individual photos. Large or distant R2/Turso workloads may reach the deadline and require a deliberate retry or operator support. Image derivatives and buffered pages consume server memory in addition to their final compressed PDF size; platform memory/time limits still matter.

Catalogue candidates use `inventories/:collectionId/catalogues/:requestId/:lease.pdf`, deliberately under the already-approved **`inventories/` seven-day lifecycle prefix**. No new bucket, public access, secret, queue service, cron or separate lifecycle rule is required. Retained `photos/` and other source prefixes must never receive derivative expiry. Download availability expires seven days from request; physical lifecycle cleanup is separate and can occur later.

Generation adds GETs for retained main JPEGs, usually more bytes than inventory thumbnails, plus a PDF PUT per successful attempt; verification/download adds HEAD/GET operations. Recheck current Cloudflare/Vercel/Turso pricing before deployment. The existing below-$10/month pilot goal is not a free-service or service-wide billing-limit guarantee. General usage/capacity controls remain #33/#34.

## Verification and representative artifacts

```sh
npm run typecheck
npm test -- tests/catalogue.spec.ts tests/inventory.spec.ts
npm test
npm run build
npm audit --omit=dev
node --test tests/pre-commit-review.test.mjs
```

In addition to #15's Poppler dependencies, the catalogue tests use `pdftohtml` to inspect resolved internal navigation. They inspect real downloaded PDF text, images, embedded fonts, destinations, page references, hashes and durable rows, not mocked internal calls. Cases cover:

- An ordinary member, non-member/same-name storytellers, a departed recorder, a different editor, conflicting recollections, draft placeholders and all retained photos.
- Exact long multilingual story content across page breaks, a retained main image embedded above thumbnail resolution, a multi-page index and destination pages with matching item names.
- Cross-collection/current membership, anonymous requests, account pinning, cross-format IDs and access removed before a new download grant.
- Missing or checksum-mismatched originals (including a valid, same-size replacement JPEG), immutable narrative snapshot retry, lost acknowledgement/concurrent retry deduplication, publication failure/membership loss, private candidates and separate fresh-attempt keys.
- Interrupted leases/three-attempt caps, combined capacity, expiry/discard, unsupported glyphs, over-limit photo/story sets, escaped long labels/mobile keyboard download and transactional additive migration rollback/reruns preserving version-nine jobs.

The first nine-case run passed six; three fixture failures used the story page instead of its `/details` write endpoint. Those calls were corrected. The subsequent combined run passed 25/26, with one extraction assertion expecting an unbroken sentence despite normal line wrapping. The assertion now normalizes whitespace, and exact narrative verification crops out repeated heading/footer regions before comparing all story content. The member journey then passed independently.

Representative local fixtures (not hosted latency or real-device print approval):

| Saved items | Retained photos | Pages | PDF size | Local measurement |
| --- | --- | --- | --- | --- |
| 2, including one draft and a long edited multilingual story | 4, including a retained main image rendered above 480 px | 9 | ~136 KB | ~2.9 s member generation/download/artifact-inspection journey |
| 23, with a two-page index | 23 | 26 | ~138 KB | artifact/destination checks passed |

The combined 26-case run passed in 7.6 minutes, including the revised long-name index layout. The subsequent 198-case full run was deliberately stopped (56 passing tests at the last inspected checkpoint, no displayed failures) to add retained-source integrity verification. A valid replacement JPEG had incorrectly produced a ready catalogue; the new regression reproduced that failure before the hash/size check and passed after it. The final regression uses a decodable **same-size** JPEG with a changed quantization coefficient, demonstrating why byte-count-only checks are insufficient. Post-integrity-change results on Next.js 16.4.3, before the separately authorized framework patch:

- **27/27 catalogue/inventory cases passed in 7.5 minutes.**
- **199/199 full browser/integration cases passed in 41.6 minutes**, including all 13 new catalogue scenarios and the existing inventory, attribution, recovery, isolation and migration regressions.
- Fresh typecheck, production webpack build and diff checks passed. All four inventory/catalogue request/download production traces include all seven font assets/notices, with no missing files.
- All nine pre-commit-hook regressions passed. These are not a staged Pi review of this implementation; that review remains required if a commit is authorized.
- The pre-patch production dependency audit reported **one moderate Next.js advisory**, zero high/critical findings. That result is superseded by the separately authorized patch below.

These results establish local automated behavior, not authenticated hosted acceptance, actual phone printing, provider pricing or final design approval. Temporary evidence paths: `/tmp/item-indexer-catalogue-member-check.log`, `/tmp/item-indexer-catalogue-final-targeted.log`, `/tmp/item-indexer-catalogue-full.log`, `/tmp/item-indexer-catalogue-final-build.log`, `/tmp/item-indexer-catalogue-integrity-red.log`, `/tmp/item-indexer-catalogue-integrity-green.log`, `/tmp/item-indexer-catalogue-integrity-targeted.log` and `/tmp/item-indexer-catalogue-integrity-full.log`, `/tmp/item-indexer-catalogue-integrity-build.log`, `/tmp/item-indexer-catalogue-final-audit.json` and `/tmp/item-indexer-catalogue-hook-tests.log`. All nine hook regression tests passed; they do not constitute a staged Pi review, which remains mandatory if a commit is authorized.

### Separately authorized framework security patch

The original Next.js 16.4.3 lockfile reported moderate advisory [GHSA-mfr8-8qww-v76h](https://github.com/advisories/GHSA-mfr8-8qww-v76h). GitHub identifies 16.4.5 as patched. It concerns a `'use cache'` function also called through `unstable_cache()` with root params during a cold-start race. No application use of either caching pattern was found in `src/` or `next.config.ts`; that was not treated as a substitute for patching. Route data remain private/no-store.

After the operator separately authorized the patch, `next` was raised from `^16.4.3` to `^16.4.6`, the latest published stable 16.4 patch at the time, updating the lockfile's matching Next environment/SWC packages. React, application code and runtime configuration were not changed for this patch. The existing Node/React versions satisfy its published requirements. The patch is separable as `package.json`/`package-lock.json` changes and needs no migration itself; deploying #16 alongside it still requires migration #10.

Final post-patch validation: **199/199 browser/integration tests passed in 40.7 minutes**, fresh typecheck and production webpack build passed, `npm audit --omit=dev` reports **zero vulnerabilities**, all nine hook regressions passed and diff checks are clean. All four inventory/catalogue request/download traces still include all seven font assets/notices with none missing. Logs: `/tmp/item-indexer-next-16-4-6-full.log`, `/tmp/item-indexer-next-16-4-6-build.log` and `/tmp/item-indexer-next-16-4-6-hook-tests.log`. The hook regressions are not a staged Pi review. The operator subsequently authorized a local commit, subject to the required staged Pi review. No push, production migration or deployment is authorized or performed. Production is not patched merely by changing this local lockfile.

For chronology, the earlier 16.4.3 CLI initially stopped with its advisory; those old local test/build commands were retried only after the startup notice, not to hide behavioral failures. No upgrade agent was launched.

## Approved rollout and rollback (not performed)

1. Review the code, framework-advisory response, representative outputs and processing limits. Take/check the agreed database backup before schema changes. Apply additive **0010_catalogue_exports.sql before any approved push that auto-deploys #16**. Existing #15 code remains compatible; no source rewrite or capture pause is required.
2. Confirm the existing private R2 bucket and `prune-inventories` seven-day prefix rule remain intact. No expiry may target retained photos. New format keys are nested under that same derivative prefix.
3. Verify production request/download traces include the three fonts/notices and Node `after` support with a 60-second platform duration. Check actual invocation time/memory and provider costs; do not infer hosted acceptance or pricing from local samples.
4. With disposable family records, generate/download as an ordinary member, follow index links and printed page references, examine multiple retained photos and long names/stories, verify independent storyteller/recorder/editor credit and differing recollections, open the downloaded file after sign-out, and test unrelated/revoked access before a new grant. Inspect an actual phone PDF reader and representative printing; record limitations rather than claiming final polish. Keep #13's separate real-device acceptance outstanding unless explicitly completed.

Rollback to #15 leaves catalogue metadata/private candidates intact but hides its UI. Unlike a shared-format row retrofit, old inventory code does not list or retry catalogue rows as inventories. Preserve version-ten schema and tracked files for fix-forward/expiry; do not drop tables or delete uncertain canonical objects. The old #15 quota counts inventories only, so the new combined five-request policy is not enforced for hidden catalogue rows during rollback. Existing bounded invocations/issued URLs may finish; downloaded files cannot be recalled.

## Sources

Installed Next.js guides for `after`, route handlers, server/client boundaries and `maxDuration`; PDFKit's public [destinations](https://pdfkit.org/docs/destinations.html), text/images and buffered-page APIs. Font provenance/licenses are in `assets/inventory-fonts/README.md`. [#15 runbook](inventory-pdf.md) records the private delivery baseline and earlier operator-reported hosted acceptance separately from this local work.
