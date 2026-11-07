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

// A null target creates a photo-backed draft; a fixed target adds a view.
// Targets cannot be changed when renewing/retrying an upload operation.
export async function beginPhotoDraft(accountId: string, collectionId: string, id: string, size: number, targetItemId: string | null = null) {
  if (!uuid.test(id) || !Number.isSafeInteger(size) || size < 1 || size > MAX_PHOTO_BYTES) throw new PhotoDraftError("Choose a non-empty photo no larger than 20 MiB.");
  const upload = await writeTransaction(async tx => {
    const member = await tx.execute({ sql: "SELECT 1 FROM memberships WHERE account_id=? AND collection_id=?", args: [accountId, collectionId] });
    if (!member.rows.length) throw new PhotoDraftError("This collection is unavailable.", 404);
    if (targetItemId !== null) {
      const item = await tx.execute({ sql: "SELECT 1 FROM items WHERE id=? AND collection_id=?", args: [targetItemId, collectionId] });
      if (!item.rows.length) throw new PhotoDraftError("This item is unavailable.", 404);
    }
    const now = Date.now();
    // Bound even URL-renewal requests; no new allowance is implied by an old ID.
    if (!await allow(tx, `photo:begin:${accountId}`, 20, now) || !await allow(tx, "photo:begin:global", 60, now)) throw new PhotoDraftError("Photo request limit reached. Wait 15 minutes before trying again.", 429);
    const existing = (await tx.execute({ sql: "SELECT account_id, collection_id, input_bytes, state, target_item_id, expires_at, lease_until FROM photo_uploads WHERE id=?", args: [id] })).rows[0];
    if (existing) {
      if (existing.account_id !== accountId || existing.collection_id !== collectionId || existing.target_item_id !== targetItemId || Number(existing.input_bytes) !== size) throw new PhotoDraftError("This upload is unavailable. Select the photo again.", 404);
      if (existing.state === "saved") return { saved: true, expiresAt: 0 };
      if (Number(existing.expires_at) <= now) throw new PhotoDraftError("This upload expired. Select the photo again.", 410);
      if (existing.state === "processing" && Number(existing.lease_until) > now) throw new PhotoDraftError("This photo is still being processed. Wait a moment, then retry.", 409);
      return { saved: false, expiresAt: Number(existing.expires_at) };
    }
    const expiresAt = now + 15 * 60_000;
    await tx.execute({ sql: "INSERT INTO photo_uploads (id, collection_id, account_id, input_bytes, created_at, expires_at, target_item_id) VALUES (?, ?, ?, ?, ?, ?, ?)", args: [id, collectionId, accountId, size, now, expiresAt, targetItemId] });
    return { saved: false, expiresAt };
  });
  if (upload.saved) return { itemUrl: itemUrl(collectionId, targetItemId ?? id) };
  return { uploadUrl: await authorizePhotoUpload(stagingKey(collectionId, id), size, Math.max(1, Math.min(120, Math.floor((upload.expiresAt - Date.now()) / 1000)))) };
}

export async function finishPhotoDraft(accountId: string, collectionId: string, id: string, targetItemId: string | null = null) {
  const destination = targetItemId ?? id;
  const attempt = randomUUID();
  const claimed = await writeTransaction(async tx => {
    const row = (await tx.execute({
      sql: `SELECT u.state, u.expires_at, u.input_bytes FROM photo_uploads u JOIN memberships m ON m.collection_id=u.collection_id AND m.account_id=u.account_id
            WHERE u.id=? AND u.collection_id=? AND u.account_id=? AND u.target_item_id IS ?`, args: [id, collectionId, accountId, targetItemId],
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
  if (claimed.saved) return { itemUrl: itemUrl(collectionId, destination) };
  // Unique attempt keys prevent an expired worker from overwriting/deleting a
  // replacement worker's files. Staged bytes are never served as item photos.
  const photoKey = `photos/${collectionId}/${destination}/${attempt}.jpg`;
  const thumbnailKey = `photos/${collectionId}/${destination}/${attempt}-thumb.jpg`;
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
      if (targetItemId === null) {
        await tx.execute({ sql: "INSERT INTO items (id, collection_id, created_by, created_at) VALUES (?, ?, ?, ?)", args: [destination, collectionId, accountId, now] });
      } else {
        const item = await tx.execute({ sql: "SELECT 1 FROM items WHERE id=? AND collection_id=?", args: [destination, collectionId] });
        if (!item.rows.length) throw new PhotoDraftError("This item is unavailable.", 404);
      }
      await tx.execute({ sql: "INSERT INTO item_photos (id, item_id, photo_key, thumbnail_key, width, height, photo_bytes, sha256, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", args: [id, destination, photoKey, thumbnailKey, image.width, image.height, image.photo.length, createHash("sha256").update(image.photo).digest("hex"), now, accountId] });
      await tx.execute({ sql: "UPDATE photo_uploads SET state='saved', lease_until=NULL WHERE id=? AND attempt=?", args: [id, attempt] });
    });
  } catch (error) {
    // A commit response can be lost AFTER durable success. Never delete photo
    // files on an uncertain commit. Reconcile from the database first; if that
    // read also fails, leave objects in place for retry/operator reconciliation.
    const saved = await database().execute({ sql: "SELECT 1 FROM item_photos WHERE item_id=? AND photo_key=?", args: [destination, photoKey] });
    if (saved.rows.length) return { itemUrl: itemUrl(collectionId, destination) };
    await Promise.all([cleanup(photoKey), cleanup(thumbnailKey)]);
    await database().execute({ sql: "UPDATE photo_uploads SET state='pending', lease_until=NULL WHERE id=? AND attempt=? AND state='processing'", args: [id, attempt] });
    if (error instanceof PhotoInputError) throw new PhotoDraftError(error.message);
    throw error;
  }
  await cleanup(stagingKey(collectionId, id));
  return { itemUrl: itemUrl(collectionId, destination) };
}
async function cleanup(key: string) {
  try { await removePhotoObject(key); }
  catch { console.error("Photo object cleanup failed. Operator reconciliation may be needed."); }
}

// Removing a view is a recoverable relationship change, not object deletion.
// Keep the immutable files/identity for history and later controlled purging.
export async function removeItemPhoto(accountId: string, collectionId: string, itemId: string, photoId: string) {
  await writeTransaction(async tx => {
    const photo = (await tx.execute({
      sql: `SELECT p.removed_at FROM item_photos p JOIN items i ON i.id=p.item_id
            JOIN memberships m ON m.collection_id=i.collection_id
            WHERE p.id=? AND i.id=? AND i.collection_id=? AND m.account_id=?`,
      args: [photoId, itemId, collectionId, accountId],
    })).rows[0];
    if (!photo) throw new PhotoDraftError("This photo is unavailable.", 404);
    if (photo.removed_at !== null) return;
    const remaining = (await tx.execute({ sql: "SELECT COUNT(*) AS count FROM item_photos WHERE item_id=? AND removed_at IS NULL", args: [itemId] })).rows[0];
    if (Number(remaining.count) <= 1) throw new PhotoDraftError("Keep at least one photo on this item. Add another view before removing this one.", 409);
    await tx.execute({ sql: "UPDATE item_photos SET removed_at=?, removed_by=? WHERE id=? AND removed_at IS NULL", args: [Date.now(), accountId, photoId] });
  });
}

export async function photoDownload(accountId: string, collectionId: string, id: string, thumbnail: boolean, photoId: string | null = null) {
  const result = await database().execute({
    sql: `SELECT p.photo_key, p.thumbnail_key FROM item_photos p JOIN items i ON i.id=p.item_id
          JOIN memberships m ON m.collection_id=i.collection_id WHERE i.id=? AND i.collection_id=? AND m.account_id=?
          AND p.removed_at IS NULL AND (? IS NULL OR p.id=?) ORDER BY p.created_at, p.id LIMIT 1`, args: [id, collectionId, accountId, photoId, photoId],
  });
  const row = result.rows[0];
  return row ? authorizePhotoDownload(String(thumbnail ? row.thumbnail_key : row.photo_key)) : null;
}
