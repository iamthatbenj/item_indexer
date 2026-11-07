import "server-only";
import { randomUUID } from "node:crypto";
import { database, writeTransaction } from "./database";
import { ITEM_NAME_LIMIT, ITEM_DESCRIPTION_LIMIT } from "@/shared/item-details";

export class ItemEditError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export async function listItems(accountId: string, collectionId: string) {
  const result = await database().execute({
    sql: `SELECT i.id, i.name, i.status FROM items i JOIN memberships m ON m.collection_id=i.collection_id
          WHERE i.collection_id=? AND m.account_id=? AND EXISTS (
            SELECT 1 FROM item_photos p WHERE p.item_id=i.id AND p.removed_at IS NULL
          ) ORDER BY i.created_at DESC, i.id`, args: [collectionId, accountId],
  });
  return result.rows.map(row => ({ id: String(row.id), name: String(row.name), status: String(row.status) }));
}

export async function getItem(accountId: string, collectionId: string, id: string) {
  const result = await database().execute({
    sql: `SELECT i.id, i.name, i.description, i.version, i.status, i.current_keeper_id, k.name AS keeper_name, k.note AS keeper_note, p.id AS photo_id, p.width, p.height FROM items i JOIN item_photos p ON p.item_id=i.id
          LEFT JOIN people k ON k.id=i.current_keeper_id AND k.collection_id=i.collection_id
          JOIN memberships m ON m.collection_id=i.collection_id WHERE i.id=? AND i.collection_id=? AND m.account_id=? AND p.removed_at IS NULL
          ORDER BY p.created_at, p.id`, args: [id, collectionId, accountId],
  });
  const row = result.rows[0];
  return row ? {
    id: String(row.id), name: String(row.name), description: String(row.description),
    version: Number(row.version), status: String(row.status),
    currentKeeper: row.current_keeper_id && row.keeper_name ? { id: String(row.current_keeper_id), name: String(row.keeper_name), note: String(row.keeper_note) } : null,
    photos: result.rows.map(photo => ({ id: String(photo.photo_id), width: Number(photo.width), height: Number(photo.height) })),
  } : null;
}

export async function editItem(accountId: string, collectionId: string, id: string, versionInput: string, nameInput: string, descriptionInput: string, keeperInput?: string) {
  const version = Number(versionInput);
  if (!/^[1-9]\d*$/.test(versionInput) || !Number.isSafeInteger(version) || version >= Number.MAX_SAFE_INTEGER) throw new ItemEditError("The editing version is invalid. Open the saved item again, keeping a copy of your text.");
  if (nameInput.length > ITEM_NAME_LIMIT || descriptionInput.length > ITEM_DESCRIPTION_LIMIT || /\0/.test(nameInput + descriptionInput)) throw new ItemEditError(`Use a name up to ${ITEM_NAME_LIMIT} characters and a short description up to ${ITEM_DESCRIPTION_LIMIT} characters, without null characters.`);
  const name = nameInput.trim();
  const description = descriptionInput.trim();
  return writeTransaction(async tx => {
    // The write transaction serializes competing edits and access removals.
    // Authorization does not depend on role or a caller-supplied editor identity.
    const row = (await tx.execute({
      sql: `SELECT i.name, i.description, i.status, i.version, i.current_keeper_id, i.current_keeper_version, i.last_edited_by, i.created_by, i.updated_at, i.created_at FROM items i JOIN memberships m ON m.collection_id=i.collection_id
            WHERE i.id=? AND i.collection_id=? AND m.account_id=?`, args: [id, collectionId, accountId],
    })).rows[0];
    if (!row) throw new ItemEditError("This item is unavailable. Your text remains on this page.", 404);
    const photo = await tx.execute({ sql: "SELECT 1 FROM item_photos WHERE item_id=? AND removed_at IS NULL", args: [id] });
    if (!photo.rows.length) throw new ItemEditError("A retained photo is required before saving item details. Your text remains on this page.", 409);
    if (Number(row.version) !== version) throw new ItemEditError("The saved version changed while you were editing. Your text remains below and has not replaced anyone’s changes. Open the latest saved item in a new tab to review it before editing again.", 409);
    // Older clients omitting the field preserve the keeper; an explicit empty
    // value clears it. A client cannot submit a keeper's collection or version.
    const keeperId = keeperInput === undefined ? row.current_keeper_id : keeperInput || null;
    let keeperVersion = row.current_keeper_version;
    if (keeperId !== null) {
      const keeper = (await tx.execute({ sql: "SELECT version FROM people WHERE id=? AND collection_id=?", args: [keeperId, collectionId] })).rows[0];
      if (!keeper) throw new ItemEditError("Choose a current keeper from this family collection. Your details remain on this page.");
      if (keeperId !== row.current_keeper_id) keeperVersion = keeper.version;
    } else keeperVersion = null;
    // Exact repeat/no-op on the current version does not manufacture history.
    if (row.name === name && row.description === description && row.current_keeper_id === keeperId) return;
    await tx.execute({
      sql: "INSERT INTO item_revisions (id, item_id, version, name, description, status, edited_by, edited_at, current_keeper_id, current_keeper_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      args: [randomUUID(), id, version, String(row.name), String(row.description), String(row.status), String(row.last_edited_by ?? row.created_by), row.updated_at ?? row.created_at, row.current_keeper_id, row.current_keeper_version],
    });
    const updated = await tx.execute({
      sql: "UPDATE items SET name=?, description=?, current_keeper_id=?, current_keeper_version=?, version=version+1, last_edited_by=?, updated_at=? WHERE id=? AND version=?",
      args: [name, description, keeperId, keeperVersion, accountId, Date.now(), id, version],
    });
    if (updated.rowsAffected !== 1) throw new ItemEditError("The saved version changed. Your text remains on this page; open the latest saved item before editing again.", 409);
  });
}
