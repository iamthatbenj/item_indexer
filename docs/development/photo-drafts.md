# One-photo draft capture

Scope: [#6](https://github.com/iamthatbenj/item_indexer/issues/6). Members can capture/select one photo, save a draft item without descriptive fields, browse thumbnails, and open its retained photo. Additional photos, names/descriptions, stories, exports, interrupted-work recovery across reloads, and full budget controls are later tickets. No transfer workflow is introduced.

## Image contract and resource limits

The capture page explains retention **before upload**. Supported actual content is a single JPEG, PNG, or WebP image; extensions and browser MIME declarations are not validation. HEIC/HEIF, GIF, SVG, TIFF, PDF, animated/multipage images (including APNG and animated WebP), malformed/truncated images, and oversized inputs are rejected with guidance to select/export a JPEG, PNG, or WebP. PNG validation walks bounded chunk lengths, verifies CRCs and rejects animation-control/frame chunks before Sharp; Sharp's page metadata alone does not identify APNG. iPhone users may need **Most Compatible** camera settings or JPEG export. Camera/library selection is browser/device-dependent; automated file selection does not prove physical camera behavior.

- Input: **20 MiB**, **60 million pixels**, maximum **16,000 pixels on either side**. Signed uploads bind Content-Length and Content-Type. Finalization independently checks stored length and bounds streamed bytes before decoding.
- Retained photo: JPEG at quality **94**, **4:4:4** chroma, maximum **3,200-pixel long edge**, never upscale. Thumbnail: maximum 480-pixel long edge, quality 85 JPEG.
- Apply visual orientation before resizing, convert to sRGB, and flatten transparent pixels on white. Sharp strips EXIF/GPS/device/time, XMP, IPTC and ICC metadata from retained files. Meaningful dates remain future explicit contributions. No strict tiny output-size target is imposed.
- Disable Sharp caching, use one processing thread per process, limit decoding pixels, and bound each encode to eight seconds. Service-wide **one active processing lease** reduces concurrent memory pressure across instances. This is a conservative pilot limit, not a processing SLA.
- Storage requests have connection/request deadlines and 10-second abort signals; no automatic SDK request retries. The finish route has a 60-second hosting limit and a 120-second lease. A killed worker can be retried after lease expiry.
- Upload authorization requests: 20 per account and 60 service-wide per 15-minute window. Finish attempts: 30 per account/window. These are separate from mail limits and are **not a billing cap** or protection against every bandwidth/CPU abuse scenario. Monitor usage; full warnings/pauses remain later tickets.

Synthetic fixtures in `tests/fixtures/photos/` include receipt text, maker's-mark text, fine lines/colour patches, small still PNG/WebP, genuine two-frame APNG/WebP, a still PNG with harmless animation-like text, and an EXIF-rotated JPEG with fake GPS/device/date metadata. Regenerate with `node --import tsx tests/fixtures/generate-photos.mts`. They contain no real family content. The numerical fidelity comparison supplements, not replaces, visual review.

## Private storage and authorization

Use a **private Cloudflare R2 Standard bucket** in production; do not enable `r2.dev` or a public custom domain. Set `OBJECT_STORAGE_ENDPOINT`, `OBJECT_STORAGE_BUCKET`, `OBJECT_STORAGE_ACCESS_KEY_ID`, and `OBJECT_STORAGE_SECRET_ACCESS_KEY` only on the server. Production rejects non-HTTPS storage endpoints. Use a bucket-scoped object read/write token, never account administration credentials. No credentials are sent to the browser; a presigned URL contains a public key identifier and a short-lived signature, not its secret key.

The initial POST checks authenticated membership and records a creator-bound upload intent. It returns a **120-second maximum presigned PUT** for a server-derived `staging/<collection>/<upload>` key, with signed content length/type. The browser sends directly to storage as `application/octet-stream`, avoiding Vercel's function request-body limit. Changing collection IDs, upload IDs, content length/type, or object keys is not an authorization shortcut. The SDK's optional automatic empty-body checksum is disabled: it cannot sign a checksum for bytes the browser has not supplied yet.

Configure bucket CORS for **only the exact application origin**, methods `PUT`/`GET`, and allowed header `Content-Type`. CORS is not authorization. Example (replace the development origin for production):

```json
[{"AllowedOrigins":["http://localhost:3000"],"AllowedMethods":["PUT","GET"],"AllowedHeaders":["Content-Type"],"MaxAgeSeconds":60}]
```

Configure a bucket lifecycle rule to delete **only `staging/` objects after one day**, including abandoned uploads/reuploads with still-valid old PUT URLs. Staged originals can temporarily contain hidden metadata; they are private, never exposed as item photos, and deleted best-effort after success. Retained photos have metadata removed. Never apply this expiration rule to `photos/`.

Photo/thumbnail GET routes query current item/collection membership and only then issue **60-second GET authorization** for the server-owned key. Anonymous requests receive 401; inaccessible/nonexistent photos receive 404; unauthorized item pages do not disclose data. Responses and objects use private/no-store caching. No public bucket access, image optimizer caching, or caller-supplied object-key API is used. Removing membership prevents new authorizations; already issued bearer URLs, in-flight reads, displayed images, and downloaded copies cannot be recalled. Keep signed URLs, cookies, raw filenames and credentials out of shared logs/screenshots/issues.

## Persistence, consistency and retry

Migration `0003_photo_drafts.sql` adds creator-bound upload intents, draft items and their first photo relationship. IDs are stable random UUIDs, independent of memberships or future Person/Storyteller records. Items record the creating account without equating it with storyteller credit. `item_photos` records storage keys, retained dimensions/byte length and SHA-256. There are no export formats already shipped to extend; future archives must include these files and relationships.

A selection has a client-generated operation ID retained **only while the page stays open**. Initial authorization and every finish request recheck collection access and intent ownership. Finalization claims a serialized lease, downloads bounded staged bytes, validates/optimizes them, stores full photo and thumbnail under unique attempt keys, then rechecks both membership and lease before publishing item + photo + saved intent in one database transaction. No item appears in the list or reports saved before this transaction succeeds.

A database failure rolls back publication and best-effort deletes that attempt's outputs. A second storage write failure similarly cleans the first output. Different attempts use different keys so a stale worker cannot overwrite/delete a replacement's files. Successful repeated/concurrent requests return the same item; a response lost after save can be retried without duplication. If a commit acknowledgement fails, reconciliation checks the committed photo before attempting cleanup. If that read also fails, leave the files untouched rather than risk deleting a committed record.

Failures leave the intent retryable while it remains valid (**15 minutes**), or locked until its processing lease expires. The UI retains the selected file in memory and says **save not confirmed**, not saved. Retry uses the same operation ID and checks durable success first. Expired intents require reselecting the file. Reloading/closing the page loses this local selection/operation ID; cross-interruption preservation is deliberately not claimed by #6.

Cleanup is best-effort, not a distributed transaction. Process death, failed deletion, or late PUT replay can leave storage-only objects. The staging lifecycle bounds staging retention. For uncommitted `photos/` attempts, an operator must compare object keys to `item_photos.photo_key`/`thumbnail_key` and active upload attempts, keeping all referenced keys and any recent/active/uncertain attempt. Do not delete based solely on a missing success response. Inventory/reconcile old unreferenced attempts after at least 24 hours with uploads paused and a healthy authoritative database; automated periodic reconciliation remains operational follow-up. Cleanup failure logs are generic and contain no keys or credentials. This does not create a completed-looking orphan item, but leftover objects can consume storage until reconciled.

## Isolated local integration tests

Install Node/npm dependencies, Chromium, and **Podman** with working rootless networking. The harness starts a disposable SeaweedFS S3 service, binds **only `127.0.0.1:9100`**, generates fresh test-only credentials, and configures a private bucket plus CORS for the test origin. Only the S3 port is published; unauthenticated filer/admin services are not exposed. The image is pinned by digest in `tests/start-server.ts`. Production storage credentials and `.env.local` values are explicitly replaced. No real family content, remote database, cloud bucket or email delivery is used.

```sh
npm ci
npx playwright install chromium
# First run needs registry access to pull the pinned SeaweedFS image.
npm test
npm run typecheck
npm run build
npm audit --omit=dev
git diff --check
```

Each run replaces only `.local/e2e/` and its own temporary container. The harness uses graceful SIGTERM shutdown to remove that container. If forcibly killed, inspect `podman ps` and remove **only the matching `family-belongings-e2e-*` container** before retrying; never remove unrelated containers. Disposable configuration/logs are ignored by Git and protected by a 0700 parent directory. The S3 config file is readable by the container's unprivileged user; it contains fresh test credentials only.

`tests/photo-drafts.spec.ts` exercises actual browser selection for both inputs, pending versus saved UI, another ordinary member's visibility, real S3 objects, signed access, private bucket denial, dimensions, orientation, metadata removal, colour/detail error, invalid formats/pixels/sizes, malformed PNG chunk lengths/CRCs/truncation/trailing data, duplicate/retried requests, stale/live leases, expiry, scoped revocation, storage write failure, transaction rollback and migration upgrade. A paused **test container** makes access removal during storage I/O deterministic; publication is rejected while earlier saved items survive. Another browser test loses the successful finish response and retries the same selection. Real file APIs and database state are checked instead of mocked internal call counts.

## Local interactive development

Use a separate local server on **127.0.0.1:9200**, not the disposable test port. Fill the four storage variables in `.env.local` with development-only values (generate fresh keys locally), and keep `TURSO_DATABASE_URL` a local file. Generate a private local S3 configuration without printing secrets:

```sh
node --env-file=.env.local --input-type=module <<'JS'
import {mkdirSync, writeFileSync} from 'node:fs';
mkdirSync('.local/storage', {recursive:true, mode:0o700});
writeFileSync('.local/storage/s3.json', JSON.stringify({identities:[{
  name:'local-development', credentials:[{
    accessKey:process.env.OBJECT_STORAGE_ACCESS_KEY_ID,
    secretKey:process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY
  }], actions:['Admin','Read','Write','List','Tagging']
}]}), {mode:0o644});
JS
podman run --rm --name family-belongings-development \
  -p 127.0.0.1:9200:8333 \
  -v "$PWD/.local/storage/s3.json:/etc/development-s3.json:ro,Z" \
  -v family-belongings-development:/data \
  docker.io/chrislusf/seaweedfs@sha256:b2e51562743be5637381a82eeeee4872eb2f86994b723d25a1bbd171855fe18d \
  mini -dir=/data -ip=127.0.0.1 -master.telemetry=false \
  -s3.config=/etc/development-s3.json -bucket=family-development \
  -s3.allowedOrigins=http://localhost:3000 -webdav=false -admin.ui=false \
  -s3.port.iceberg=0 -s3.port.lance=0
```

Match the bucket/origin to `.env.local`; the above uses `.env.example` defaults. Leave that terminal running, then run `npm run db:migrate` and `npm run dev` in another terminal. The named volume keeps development photos across container restarts. This local server is **not** a production deployment or a claim of exact R2 parity. Do not point this recipe at production credentials.

## Deployment ordering and acceptance still required

**Operator-reported rollout preparation:** the private `family-belongings-production` R2 Standard bucket, exact production-origin CORS, `staging/` one-day expiration rule, restricted credentials and Production-only Vercel variables have been configured. The operator reports running the production migration command successfully through migration #3. These are operator confirmations, not independently verified hosted photo acceptance; deployment and real-device checks remain outstanding.

For a fresh deployment, before an auto-deploying push: approve the rollout; provision a private R2 Standard bucket and scoped credentials; configure CORS/lifecycle; scope the four new variables to Production only; explicitly apply migration #3 using the hosted operator runbook. Local tests/build alone do not prove real R2 upload compatibility or Vercel processing limits. Recheck R2/Vercel pricing and usage before deploying; the total below-$10/month target remains unproven.

Migration #3 is additive. A rollback to #5 remains schema-compatible and hides photo capture/items; it does not erase saved records/files. Do not drop tables or delete objects during application rollback. Prefer a compatible fix-forward. Operational backups must eventually include retained files as well as records; do not rely on this pilot as the only family record before backup/recovery acceptance.

Manual checklist for later hosted/device acceptance:

- On actual iOS/Android, take a camera photo and choose a library photo. Verify unsupported HEIC guidance, portrait/landscape orientation, pending/saved/error states, retry and touch/keyboard/screen-reader usability.
- Test representative high-resolution item photos, tiny maker's marks, fine receipt text and wide-gamut colour. Compare retained output with input at useful viewing/print sizes; do not approve fidelity from the thumbnail alone. Confirm metadata removal independently.
- Confirm private bucket access, real R2 CORS/signed length/type/expiry behavior, two-relative visibility, collection isolation and rejection of **new** downloads after membership removal. Already issued links may work until expiry.
- Exercise interrupted uploads and processing failures with disposable records; confirm no duplicate or completed-looking orphan item. Measure 48-megapixel processing time/memory on Vercel and inspect operational storage cleanup.
- Record actual storage, request, processing and transfer usage against the pilot budget. This ticket does not deliver all later budget warning/pausing controls.

References: [R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/), [R2 CORS](https://developers.cloudflare.com/r2/buckets/cors/), [Sharp output/metadata](https://sharp.pixelplumbing.com/api-output/), [Sharp input limits](https://sharp.pixelplumbing.com/api-constructor/), [SeaweedFS](https://github.com/seaweedfs/seaweedfs).
