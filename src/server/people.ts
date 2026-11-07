import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { database, writeTransaction } from "./database";
import { PERSON_NAME_LIMIT, PERSON_NOTE_LIMIT, type PersonSummary } from "@/shared/people";

export class PersonEditError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function identifyingDetails(nameInput: string, noteInput: string) {
  const name = nameInput.trim(); const note = noteInput.trim();
  if (!name || nameInput.length > PERSON_NAME_LIMIT || noteInput.length > PERSON_NOTE_LIMIT || /\0/.test(nameInput + noteInput)) {
    throw new PersonEditError(`Enter a name up to ${PERSON_NAME_LIMIT} characters and an optional identifying note up to ${PERSON_NOTE_LIMIT} characters, without null characters.`);
  }
  return { name, note };
}

export async function listPeople(accountId: string, collectionId: string, query = ""): Promise<PersonSummary[] | null> {
  // Distinguish an authorized empty directory from an unavailable collection.
  const member = await database().execute({ sql: "SELECT 1 FROM memberships WHERE account_id=? AND collection_id=?", args: [accountId, collectionId] });
  if (!member.rows.length) return null;
  const result = await database().execute({
    sql: `SELECT p.id, p.name, p.note, p.version FROM people p JOIN memberships m ON m.collection_id=p.collection_id
          WHERE p.collection_id=? AND m.account_id=? AND instr(lower(p.name || char(10) || p.note), lower(?)) > 0
          ORDER BY p.name COLLATE NOCASE, p.note COLLATE NOCASE, p.id`, args: [collectionId, accountId, query.slice(0, PERSON_NAME_LIMIT)],
  });
  return result.rows.map(row => ({ id: String(row.id), name: String(row.name), note: String(row.note), version: Number(row.version) }));
}

export async function getPerson(accountId: string, collectionId: string, id: string): Promise<PersonSummary | null> {
  const result = await database().execute({
    sql: `SELECT p.id, p.name, p.note, p.version FROM people p JOIN memberships m ON m.collection_id=p.collection_id
          WHERE p.id=? AND p.collection_id=? AND m.account_id=?`, args: [id, collectionId, accountId],
  });
  const row = result.rows[0];
  return row ? { id: String(row.id), name: String(row.name), note: String(row.note), version: Number(row.version) } : null;
}

export async function createPerson(accountId: string, collectionId: string, id: string, nameInput: string, noteInput: string) {
  if (!uuid.test(id)) throw new PersonEditError("The creation request is invalid. Keep your details and open a new person form.");
  const { name, note } = identifyingDetails(nameInput, noteInput);
  const hash = createHash("sha256").update(JSON.stringify([name, note])).digest("hex");
  await writeTransaction(async tx => {
    const member = await tx.execute({ sql: "SELECT 1 FROM memberships WHERE account_id=? AND collection_id=?", args: [accountId, collectionId] });
    if (!member.rows.length) throw new PersonEditError("This collection is unavailable. Your details remain on this page.", 404);
    const existing = (await tx.execute({ sql: "SELECT collection_id, created_by, creation_hash FROM people WHERE id=?", args: [id] })).rows[0];
    if (existing) {
      if (existing.collection_id !== collectionId || existing.created_by !== accountId) throw new PersonEditError("This creation request is unavailable.", 404);
      if (existing.creation_hash !== hash) throw new PersonEditError("This creation request already saved different details. Open the saved person to review before editing again.", 409);
      return; // Lost-response retries must not create a second same-name person.
    }
    const now = Date.now();
    await tx.execute({
      sql: "INSERT INTO people (id, collection_id, name, note, created_by, created_at, creation_hash, last_edited_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      args: [id, collectionId, name, note, accountId, now, hash, accountId, now],
    });
  });
}

export async function editPerson(accountId: string, collectionId: string, id: string, versionInput: string, nameInput: string, noteInput: string) {
  const version = Number(versionInput);
  if (!/^[1-9]\d*$/.test(versionInput) || !Number.isSafeInteger(version) || version >= Number.MAX_SAFE_INTEGER) throw new PersonEditError("The editing version is invalid. Keep your details and open the saved person again.");
  const { name, note } = identifyingDetails(nameInput, noteInput);
  await writeTransaction(async tx => {
    const row = (await tx.execute({
      sql: `SELECT p.name, p.note, p.version, p.last_edited_by, p.updated_at FROM people p JOIN memberships m ON m.collection_id=p.collection_id
            WHERE p.id=? AND p.collection_id=? AND m.account_id=?`, args: [id, collectionId, accountId],
    })).rows[0];
    if (!row) throw new PersonEditError("This person is unavailable. Your details remain on this page.", 404);
    if (Number(row.version) !== version) throw new PersonEditError("The saved person changed while you were editing. Your attempted details remain below; open the latest saved person before editing again.", 409);
    if (row.name === name && row.note === note) return;
    await tx.execute({
      sql: "INSERT INTO person_revisions (id, person_id, version, name, note, edited_by, edited_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      args: [randomUUID(), id, version, String(row.name), String(row.note), String(row.last_edited_by), row.updated_at],
    });
    const updated = await tx.execute({
      sql: "UPDATE people SET name=?, note=?, version=version+1, last_edited_by=?, updated_at=? WHERE id=? AND version=?",
      args: [name, note, accountId, Date.now(), id, version],
    });
    if (updated.rowsAffected !== 1) throw new PersonEditError("The saved person changed. Your details remain on this page; open the latest saved person before editing again.", 409);
  });
}
