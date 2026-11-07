import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { database, writeTransaction } from "./database";
import { allow } from "./security";
import { authorizePhotoUpload, readStagedPhoto, putRetainedPhoto, removePhotoObject, authorizePhotoDownload } from "./object-storage";
import { processPhoto, PhotoInputError, MAX_PHOTO_BYTES } from "./photo-processing";

export class PhotoDraftError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const itemUrl = (collection: string, id: string) => `/collections/${collection}/items/${id}`;
const stagingKey = (collection: string, id: string) => `staging/${collection}/${id}`;

export async function beginPhotoDraft(accountId: string, collectionId: string, id: string, size: number) {
  if (!uuid.test(id) || !Number.isSafeInteger(size) || size < 1 || size > MAX_PHOTO_BYTES) throw new PhotoDraftError("Choose a non-empty photo no larger than 20 MiB.");
  const upload = await writeTransaction(async tx => {
    const member = await tx.execute({ sql: "SELECT 1 FROM memberships WHERE account_id=? AND collection_id=?", args: [accountId, collectionId] });
    if (!member.rows.length) throw new PhotoDraftError("This collection is unavailable.", 404);
    const now = Date.now();
    // Bound even URL-renewal requests; no new allowance is implied by an old ID.
    if (!await allow(tx, `photo:begin:${accountId}`, 20, now) || !await allow(tx, "photo:begin:global", 60, now)) throw new PhotoDraftError("Photo request limit reached. Wait 15 minutes before trying again.", 429);
    const existing = (await tx.execute({ sql: "SELECT * FROM photo_uploads WHERE id=?", args: [id] })).rows[0];
    if (existing) {
      if (existing.account_id !== accountId || existing.collection_id !== collectionId || Number(existing.input_bytes) !== size) throw new PhotoDraftError("This upload is unavailable. Select the photo again.", 404);
      if (existing.state === "saved") return { saved: true, expiresAt: 0 };
      if (Number(existing.expires_at) <= now) throw new PhotoDraftError("This upload expired. Select the photo again.", 410);
      if (existing.state === "processing" && Number(existing.lease_until) > now) throw new PhotoDraftError("This photo is still being processed. Wait a moment, then retry.", 409);
      return { saved: false, expiresAt: Number(existing.expires_at) };
    }
    const expiresAt = now + 15 * 60_000;
    await tx.execute({ sql: "INSERT INTO photo_uploads (id, collection_id, account_id, input_bytes, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)", args: [id, collectionId, accountId, size, now, expiresAt] });
    return { saved: false, expiresAt };
  });
  if (upload.saved) return { itemUrl: itemUrl(collectionId, id) };
  return { uploadUrl: await authorizePhotoUpload(stagingKey(collectionId, id), size, Math.max(1, Math.min(120, Math.floor((upload.expiresAt - Date.now()) / 1000)))) };
}

export async function finishPhotoDraft(accountId: string, collectionId: string, id: string) {
  const attempt = randomUUID();
  const claimed = await writeTransaction(async tx => {
    const row = (await tx.execute({
      sql: `SELECT u.* FROM photo_uploads u JOIN memberships m ON m.collection_id=u.collection_id AND m.account_id=u.account_id
            WHERE u.id=? AND u.collection_id=? AND u.account_id=?`, args: [id, collectionId, accountId],
    })).rows[0];
    if (!row) throw new PhotoDraftError("This upload is unavailable.", 404);
    if (row.state === "saved") return { saved: true, size: 0 };
    const now = Date.now();
    if (Number(row.expires_at) <= now) throw new PhotoDraftError("This upload expired. Select the photo again.", 410);
    if (!await allow(tx, `photo:finish:${accountId}`, 30, now)) throw new PhotoDraftError("Processing request limit reached. Wait 15 minutes before trying again.", 429);
    const active = await tx.execute({ sql: "SELECT 1 FROM photo_uploads WHERE state='processing' AND lease_until>? LIMIT 1", args: [now] });
    if (active.rows.length) throw new PhotoDraftError("A photo is still being processed. Wait a moment, then retry.", 409);
    await tx.execute({ sql: "UPDATE photo_uploads SET state='processing', attempt=?, lease_until=? WHERE id=?", args: [attempt, now + 120_000, id] });
    return { saved: false, size: Number(row.input_bytes) };
  });
  if (claimed.saved) return { itemUrl: itemUrl(collectionId, id) };
  // Unique attempt keys prevent an expired worker from overwriting/deleting a
  // replacement worker's files. Staged bytes are never served as item photos.
  const photoKey = `photos/${collectionId}/${id}/${attempt}.jpg`;
  const thumbnailKey = `photos/${collectionId}/${id}/${attempt}-thumb.jpg`;
  try {
    const input = await readStagedPhoto(stagingKey(collectionId, id), claimed.size);
    const image = await processPhoto(input);
    await putRetainedPhoto(photoKey, image.photo);
    await putRetainedPhoto(thumbnailKey, image.thumbnail);
    await writeTransaction(async tx => {
      // Recheck both membership and lease before publishing. Removal during I/O
      // must not authorize a new record or return successful completion.
      const authorized = await tx.execute({
        sql: `SELECT 1 FROM photo_uploads u JOIN memberships m ON m.collection_id=u.collection_id AND m.account_id=u.account_id
              WHERE u.id=? AND u.state='processing' AND u.attempt=? AND u.lease_until>?`, args: [id, attempt, Date.now()],
      });
      if (!authorized.rows.length) throw new PhotoDraftError("Collection access changed or processing expired. This photo was not saved.", 409);
      const now = Date.now();
      await tx.execute({ sql: "INSERT INTO items (id, collection_id, created_by, created_at) VALUES (?, ?, ?, ?)", args: [id, collectionId, accountId, now] });
      await tx.execute({ sql: "INSERT INTO item_photos VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", args: [randomUUID(), id, photoKey, thumbnailKey, image.width, image.height, image.photo.length, createHash("sha256").update(image.photo).digest("hex"), now] });
      await tx.execute({ sql: "UPDATE photo_uploads SET state='saved', lease_until=NULL WHERE id=? AND attempt=?", args: [id, attempt] });
    });
  } catch (error) {
    // A commit response can be lost AFTER durable success. Never delete photo
    // files on an uncertain commit. Reconcile from the database first; if that
    // read also fails, leave objects in place for retry/operator reconciliation.
    const saved = await database().execute({ sql: "SELECT 1 FROM item_photos WHERE item_id=? AND photo_key=?", args: [id, photoKey] });
    if (saved.rows.length) return { itemUrl: itemUrl(collectionId, id) };
    await Promise.all([cleanup(photoKey), cleanup(thumbnailKey)]);
    await database().execute({ sql: "UPDATE photo_uploads SET state='pending', lease_until=NULL WHERE id=? AND attempt=? AND state='processing'", args: [id, attempt] });
    if (error instanceof PhotoInputError) throw new PhotoDraftError(error.message);
    throw error;
  }
  await cleanup(stagingKey(collectionId, id));
  return { itemUrl: itemUrl(collectionId, id) };
}
async function cleanup(key: string) {
  try { await removePhotoObject(key); }
  catch { console.error("Photo object cleanup failed. Operator reconciliation may be needed."); }
}

export async function listPhotoDrafts(accountId: string, collectionId: string) {
  const result = await database().execute({
    sql: `SELECT i.id FROM items i JOIN item_photos p ON p.item_id=i.id JOIN memberships m ON m.collection_id=i.collection_id
          WHERE i.collection_id=? AND m.account_id=? ORDER BY i.created_at DESC, i.id`, args: [collectionId, accountId],
  });
  return result.rows.map(row => ({ id: String(row.id) }));
}
export async function getPhotoDraft(accountId: string, collectionId: string, id: string) {
  const result = await database().execute({
    sql: `SELECT i.id, p.width, p.height FROM items i JOIN item_photos p ON p.item_id=i.id
          JOIN memberships m ON m.collection_id=i.collection_id WHERE i.id=? AND i.collection_id=? AND m.account_id=?`, args: [id, collectionId, accountId],
  });
  const row = result.rows[0];
  return row ? { id: String(row.id), width: Number(row.width), height: Number(row.height) } : null;
}
export async function photoDownload(accountId: string, collectionId: string, id: string, thumbnail: boolean) {
  const result = await database().execute({
    sql: `SELECT p.photo_key, p.thumbnail_key FROM item_photos p JOIN items i ON i.id=p.item_id
          JOIN memberships m ON m.collection_id=i.collection_id WHERE i.id=? AND i.collection_id=? AND m.account_id=?`, args: [id, collectionId, accountId],
  });
  const row = result.rows[0];
  return row ? authorizePhotoDownload(String(thumbnail ? row.thumbnail_key : row.photo_key)) : null;
}
