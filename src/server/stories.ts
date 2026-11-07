import "server-only";
import { createHash } from "node:crypto";
import { database, writeTransaction } from "./database";
import { STORY_TEXT_LIMIT } from "@/shared/stories";

export class StoryError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function listStories(accountId: string, collectionId: string, itemId: string) {
  const result = await database().execute({
    sql: `SELECT s.id, s.text, s.recorded_at, a.email AS recorder_email, p.id AS storyteller_id, p.name, p.note
          FROM stories s JOIN items i ON i.id=s.item_id
          JOIN memberships m ON m.collection_id=i.collection_id
          JOIN people p ON p.id=s.storyteller_id AND p.collection_id=i.collection_id
          JOIN accounts a ON a.id=s.recorded_by
          WHERE i.id=? AND i.collection_id=? AND m.account_id=? ORDER BY s.recorded_at, s.id`,
    args: [itemId, collectionId, accountId],
  });
  return result.rows.map(row => ({ id: String(row.id), text: String(row.text), recordedAt: Number(row.recorded_at), recorderEmail: String(row.recorder_email), storyteller: { id: String(row.storyteller_id), name: String(row.name), note: String(row.note) } }));
}

export async function createStory(accountId: string, collectionId: string, itemId: string, id: string, storytellerId: string, textInput: string) {
  if (!uuid.test(id)) throw new StoryError("The recording request is invalid. Keep your story and open a new story form.");
  const text = textInput.trim();
  if (!text || textInput.length > STORY_TEXT_LIMIT || /\0/.test(textInput)) throw new StoryError(`Enter a story up to ${STORY_TEXT_LIMIT.toLocaleString("en-US")} characters, without null characters.`);
  const hash = createHash("sha256").update(JSON.stringify([storytellerId, text])).digest("hex");
  await writeTransaction(async tx => {
    const item = await tx.execute({
      sql: `SELECT 1 FROM items i JOIN memberships m ON m.collection_id=i.collection_id
            WHERE i.id=? AND i.collection_id=? AND m.account_id=? AND EXISTS (SELECT 1 FROM item_photos p WHERE p.item_id=i.id AND p.removed_at IS NULL)`,
      args: [itemId, collectionId, accountId],
    });
    if (!item.rows.length) throw new StoryError("This item is unavailable. Your story remains on this page.", 404);
    const existing = (await tx.execute({ sql: "SELECT item_id, recorded_by, creation_hash FROM stories WHERE id=?", args: [id] })).rows[0];
    if (existing) {
      if (existing.item_id !== itemId || existing.recorded_by !== accountId) throw new StoryError("This recording request is unavailable.", 404);
      if (existing.creation_hash !== hash) throw new StoryError("This request already saved a different story. Open the saved item to review it; keep this tab to copy your attempted text.", 409);
      return;
    }
    const storyteller = (await tx.execute({ sql: "SELECT version FROM people WHERE id=? AND collection_id=?", args: [storytellerId, collectionId] })).rows[0];
    if (!storyteller) throw new StoryError("Choose a storyteller from this family collection. They do not need an app account.");
    const now = Date.now();
    await tx.execute({
      sql: "INSERT INTO stories (id, item_id, storyteller_id, storyteller_version, text, recorded_by, recorded_at, last_edited_by, updated_at, creation_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      args: [id, itemId, storytellerId, storyteller.version, text, accountId, now, accountId, now, hash],
    });
  });
}
