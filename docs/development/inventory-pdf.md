# Private compact inventory PDF (#15)

Local implementation of [#15](https://github.com/iamthatbenj/item_indexer/issues/15), after completed #7/#8. Production migration and deployment have not been performed. Migration **0009_inventory_exports.sql** and explicit rollout approval are required before any auto-deploying push. Local implementation is ready for review with the validation caveat below; this is not hosted acceptance.

## Saved snapshot and printable artifact

Every current family member can use **Download a compact inventory PDF** on the collection page (`/collections/:id/inventory`). Generation captures the collection name and all current saved items in one write transaction, with their names, short descriptions and first retained active thumbnail (ordered by photo creation time/ID). It does not dump every photo into each row. Missing identifying fields receive draft placeholders. An item without its required retained photo fails generation rather than being silently omitted.

The inventory is an A4 saved snapshot, not a live view or final print approval. Item text wraps, long rows continue across pages, and page/table headings and continuation labels repeat. Bounded pages are buffered so headings/footers are drawn only after body text layout; they cannot replace the active font or continuation wrapper during an automatic page break. Unusual whitespace in collection names is normalized for printing; bounded repeated headers can abbreviate the name, while its full normalized name is printed in the first page body. Images are derived from retained thumbnails, resized to at most 160 pixels without enlarging the source file. Source retained photos and metadata-removal/orientation/colour decisions remain unchanged. The PDF embeds JPEG bytes and subset fonts, with no live image/font/app links required to read it after signing out.

Bundled DejaVu Sans, Noto Sans CJK and monochrome Noto Emoji provide grapheme-based font fallback; sources, hashes and licenses are in `assets/inventory-fonts/README.md`. Server deployment assets total about 18.3 MiB, not 18.3 MiB per PDF. The generation routes explicitly trace the assets in production builds. A glyph absent from all bundled fonts fails generation rather than silently replacing family text with boxes. This is not a universal-language, bidirectional-typography, PDF/A or final-printer-approval guarantee. Inspect representative family names and descriptions before relying on a printout.

Stories, current-keeper sections, financial details, history, final selection controls and illustrated narratives are outside this slice. Unconfirmed local text/photo copies are not included. A generated inventory is a private derivative, not a new item/story source record, archival bundle or proof of legal ownership/value. Local copies already downloaded cannot be recalled when access changes; keep them private on the device.

## Bounded background generation and retry

- POST `/collections/:id/inventory/requests` accepts one action (`create`, `retry`, `discard`) and a request UUID. The browser pins its initiating account ID; actual sessions/membership, not that ID, authorize work.
- Creation returns **202 with a processing job**, not a PDF success. Next.js `after` runs the generation after the response; the original browser connection/page need not remain open. No separate queue service, cron, public bucket or new secret is introduced.
- `inventory_exports` retains the immutable saved snapshot and operational status. `inventory_export_attempts` records each server-derived candidate key and actual initiating family member for that attempt. No client-supplied object key, filename, item selection, recording/editing credit or thumbnail URL is trusted.
- Each attempt has a cooperative **25-second deadline**, a **60-second Node route/platform duration limit**, and a **90-second durable lease**. Thumbnail reads are streamed/bounded to 512 KiB each, fetched four at a time, then decoded with a 480×480 pixel ceiling and reduced before PDF embedding. Failed sibling reads are cancelled/drained. PDF generation caps at **200 items, 250 pages and 16 MiB**. Oversized collections fail explicitly; no misleading partial inventory is created.
- Phase/progress is operational: thumbnails prepared does not mean a complete PDF exists. UI checking stops after a **30-second wall-clock budget** (at most 20 polls), including response wait time, and offers manual checking. GET status never generates or retries work. A stalled invocation becomes visibly interrupted after its lease; deliberate retry is allowed, at most **three attempts** per request.
- Repeating a creation UUID reconciles the existing request instead of adding a duplicate. A retry keeps the original saved snapshot, even if members edited items afterward. Request a fresh inventory for a fresh snapshot. Attempt keys are unique/fenced, so a stale attempt cannot overwrite another attempt's artifact or publish after its lease is replaced.
- Publication occurs only after a full private object PUT and a membership/lease/expiry-checked database transaction. Failed or uncertain publication is not presented as success. Candidate objects are tracked and left private on ambiguous PUT/commit outcomes rather than risking deletion of a possibly committed canonical PDF. A conditional failure update cannot erase a successfully committed ready state.

A collection retains at most **five requests**, including failed/expired ones. Any current member can discard a generated inventory to free capacity; this removes only that derivative and its tracked attempts, never family records, source photos, stories, memberships or copies already downloaded. Active/recently expired processing leases cannot be discarded while an invocation may still run. Storage deletion must succeed before metadata is removed; a failed discard remains retryable. Normally there are at most 15 tracked candidate objects per collection. Unknown late-write orphans still need the prefix lifecycle described below; these are not a service-wide storage/billing quota or rate-limit guarantee.

## Private download authorization

GET `/collections/:id/inventory/requests` returns scoped status only, not raw snapshots, source keys or candidate keys. GET `/collections/:id/inventory/requests/:jobId/download` authenticates the current account and collection membership, requires a ready/unexpired job, HEAD-verifies PDF type/size/SHA-256 metadata, then rechecks current membership and the canonical artifact relationship after storage I/O before issuing a private/no-store redirect. It grants a short-lived R2 attachment download, at most 60 seconds. A failed/missing/incomplete artifact does not receive a fresh successful download grant.

An unrelated account, a substituted collection/job pair, or membership removed before a new authorization is denied. Already-issued signed URLs can remain usable until their short expiry, including after sign-out/removal; downloaded PDFs remain self-contained. There is no claim of recalling previously delivered bytes. Download authorization expires seven days after the snapshot request; physical lifecycle deletion is separate.

## Local verification

```sh
npm test -- tests/inventory.spec.ts
npm test
npm run typecheck
npm run build
npm audit --omit=dev
node --test tests/pre-commit-review.test.mjs
```

Artifact tests require Poppler tools (`pdftotext`, `pdfimages`, `pdffonts`, `pdfinfo`, `pdftoppm`; commonly `poppler-utils` on Linux). Production generation needs only the Node dependencies and bundled font files, not Poppler or a headless browser.

All 13 inventory scenarios passed twice consecutively (**26 passed in 7.3 minutes**): real ordinary-member browser download, offline text/font/image inspection after sign-out, multiple pages/long names/descriptions, collection isolation and access removal, failed source reads with immutable-snapshot retry, concurrent/lost acknowledgement deduplication, empty collections, expiry/capacity/discard, publication failures, membership loss during publication, separately keyed retries, simulated abandoned durable leases/three-attempt bounds, unsupported glyphs, missing ready artifacts, mobile/keyboard interaction, additive migration rollback/reruns and a real network-delay regression enforcing the 30-second polling budget. Internal authorization/transaction mock-call assertions do not substitute for these artifacts or durable effects.

Validation chronology and caveat:

- An earlier complete browser/integration run passed **185 tests in 38.9 minutes**.
- Follow-up inventory runs exposed native SQLite contention around synthetic bulk writes and fault-injection DDL. Fixtures now quiesce live pages before direct mutations and observe background progress through the authenticated status API rather than a second native database reader. Bulk setup passed five focused repeats; publication-fault cases passed six focused repetitions; the complete inventory suite then passed the two runs above. No production database configuration or authorization rules were changed for this fixture adjustment.
- The subsequent full run finished **184 passed / 1 failed in 38.7 minutes**. The sole failure was `read ECONNRESET` in the existing story test `concurrent retries deduplicate one operation, not identical recollections, and cannot rewrite or steal attribution`, at a native API POST. Without changing that test's assertions or adding automatic retries, it subsequently passed **three isolated repetitions in 53.4 seconds**. The transport reset's underlying cause is not established; no clean full-suite run has been captured after the final fixture adjustments.
- Typecheck, production build, production dependency audit (zero vulnerabilities), all nine pre-commit-hook regressions and diff checks passed. Production request/download traces each contain all seven font assets/notices, with no missing files. These hook regression tests are not a staged Pi review of this implementation; that review is required when a commit is authorized.

The first required staged Pi review blocked the commit after identifying a CJK continuation defect: drawing headers inside `pageAdded` replaced PDFKit's active body font/text-flow state. A new real-PDF regression reproduced missing CJK characters across an automatic page boundary, including subsequent Latin/emoji/CJK runs. The renderer now decorates buffered pages after body layout using public PDFKit APIs, without private-state manipulation. After that fix, **all 14 inventory tests passed in 3.9 minutes**, and fresh typecheck, production build and diff checks passed. The expanded 186-test full suite has not been rerun; the earlier full-suite results above predate this renderer fix. The commit must pass a fresh staged Pi review. Post-fix logs: `/tmp/item-indexer-inventory-cjk-red.log`, `/tmp/item-indexer-inventory-cjk-green.log`, `/tmp/item-indexer-inventory-reviewed-tests.log` and `/tmp/item-indexer-inventory-reviewed-build.log`.

Local evidence logs: `/tmp/item-indexer-inventory-full.log`, `/tmp/item-indexer-inventory-isolated-repeat.log`, `/tmp/item-indexer-inventory-full-final.log`, `/tmp/item-indexer-inventory-legacy-transport-check.log` and `/tmp/item-indexer-inventory-build-final-check.log`. These temporary paths are workspace evidence, not durable shipped artifacts.

Representative local measurements (disposable fixture thumbnails, not a Vercel/R2 latency promise):

| Saved items | Pages | PDF size | Measured time |
| --- | --- | --- | --- |
| 31, including a draft and an item with two retained photos | 6 | ~94.8 KB | ~3.08 s member download/inspection journey |
| 100 | 17 | ~154 KB | ~1.19 s request through authorized download |

All 31 thumbnail placements were checked in the first PDF, not 32 (the extra photo is not dumped into a second row). Extracted text includes accented Latin, CJK and emoji. The generated first page was visually inspected. These are local artifacts/automated results, not authenticated hosted/mobile acceptance or final print approval.

Existing populated-upgrade fixtures now remove the empty version-nine derivative tables when constructing earlier schemas and expect nine migrations after a complete rerun. Inventory fixtures drain background status before resetting data, and clean their generated/source test objects; they do not use production records or credentials.

## Approved rollout and rollback (not performed)

1. Review/approve the code and resource/retention choices. Back up/check the hosted structured database. Apply additive **0009_inventory_exports.sql before any push that auto-deploys this code**. Old #14 application code remains compatible with the added tables. No capture pause or source-photo rewrite is required.
2. Keep the existing R2 Standard bucket **private** and the current server-only credentials/CORS/staging rules intact. Add an operator-approved lifecycle rule for **prefix `inventories/` only**, expiring generated objects after seven days. Do **not** apply expiry to the bucket as a whole or retained-photo prefixes. This cleans expired candidates and late-write orphans even if no member returns to discard them. Job metadata and app authorization expire separately; lifecycle deletion timing is not an exact byte-revocation clock.
3. Check the Vercel Node deployment includes `after`/`waitUntil`, honors `maxDuration = 60`, and carries all three font assets/licenses in generation route traces. Recheck current provider pricing before rollout; do not infer a free-service/below-$10 budget from a local test.
4. After explicit deployment approval, use disposable saved items: generate/download as an ordinary member, inspect long/multi-page and multi-photo output, sign out and open the downloaded file, test an unrelated account and removal before a **new** grant, force an actionable failure/retry without treating a partial file as ready, and check phone download/printing. Record versions, timing/size and any font/print limitations. Keep #13's outstanding real-device checks separate unless explicitly completed by the operator.

Rollback to #14 hides the inventory UI while preserving family records and version-nine job/attempt data. Keep the private candidates and schema for reconciliation/expiry; do not blindly drop tables or delete possibly canonical objects during an uncertain commit. Existing bounded invocations may finish; issued URLs can survive until expiry and downloaded copies cannot be recalled. Prefer a compatible fix-forward.

## Sources and budget boundary

Read the installed Next.js `after`, route-handler, external-package and output-tracing guides before implementation. Primary PDFKit references: https://pdfkit.org/docs/getting_started.html , https://pdfkit.org/docs/text.html , https://pdfkit.org/docs/images.html . Font provenance/licenses are bundled alongside source font bytes.

Cloudflare R2 Standard pricing checked against https://developers.cloudflare.com/r2/pricing/ (page updated 2026-10-30): $0.015/GB-month, $4.50/million Class A operations and $0.36/million Class B operations; included monthly tier 10 GB-month, 1 million A and 10 million B, with direct R2 egress free. Generation adds thumbnail GETs and a PDF PUT per successful attempt; grants add HEAD/signing and downloads add GETs. Vercel work and Turso job/snapshot records also count. The existing personal/non-commercial pilot budget target remains below $10/month, not a guarantee or permission to provision/alter production resources without approval.
