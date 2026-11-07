import "server-only";
import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

let client: S3Client | undefined;
function storage() {
  const endpoint = process.env.OBJECT_STORAGE_ENDPOINT;
  const accessKeyId = process.env.OBJECT_STORAGE_ACCESS_KEY_ID;
  const secretAccessKey = process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY;
  if (!endpoint || !accessKeyId || !secretAccessKey || !process.env.OBJECT_STORAGE_BUCKET) throw new Error("Private object storage is not configured.");
  const url = new URL(endpoint);
  if (url.username || url.password || url.search || url.hash || (process.env.NODE_ENV === "production" && url.protocol !== "https:")) throw new Error("Invalid storage endpoint.");
  client ??= new S3Client({ endpoint, region: "auto", forcePathStyle: true, credentials: { accessKeyId, secretAccessKey }, maxAttempts: 1,
    // The browser supplies the body later; do not sign the SDK's empty-body CRC.
    requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED",
    requestHandler: { connectionTimeout: 3_000, requestTimeout: 10_000 } });
  return client;
}
function bucket() { return process.env.OBJECT_STORAGE_BUCKET!; }

// These functions accept only server-derived keys; routes never accept an arbitrary key.
export async function authorizePhotoUpload(key: string, size: number, expiresIn: number) {
  const s3 = storage();
  return getSignedUrl(s3, new PutObjectCommand({ Bucket: bucket(), Key: key, ContentType: "application/octet-stream", ContentLength: size }), {
    expiresIn, signableHeaders: new Set(["content-type", "content-length"]),
  });
}

export async function readStagedPhoto(key: string, expectedBytes: number): Promise<Buffer> {
  const s3 = storage();
  const response = await s3.send(new GetObjectCommand({ Bucket: bucket(), Key: key }), { abortSignal: AbortSignal.timeout(10_000) });
  const body = response.Body;
  if (!body) throw new Error("Missing staged photo.");
  // Check both the object size and streamed bytes; never trust a filename or MIME header.
  const reader = body.transformToWebStream().getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    if (response.ContentLength !== expectedBytes) throw new Error("Staged size mismatch.");
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > expectedBytes) throw new Error("Staged photo exceeds size limit.");
      chunks.push(value);
    }
    if (bytes !== expectedBytes) throw new Error("Incomplete staged photo.");
    return Buffer.concat(chunks);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function putRetainedPhoto(key: string, bytes: Buffer) {
  const s3 = storage();
  await s3.send(new PutObjectCommand({ Bucket: bucket(), Key: key, Body: bytes, ContentType: "image/jpeg", CacheControl: "private, no-store" }), { abortSignal: AbortSignal.timeout(10_000) });
}
export async function removePhotoObject(key: string) {
  const s3 = storage();
  await s3.send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }), { abortSignal: AbortSignal.timeout(10_000) });
}
export async function authorizePhotoDownload(key: string) {
  const s3 = storage();
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket(), Key: key, ResponseContentType: "image/jpeg", ResponseCacheControl: "private, no-store", ResponseContentDisposition: 'inline; filename="family-photo.jpg"' }), { expiresIn: 60 });
}
