import "server-only";
import { database } from "./database";

// History and today's version are read in one statement/snapshot. Scope every
// branch through the currently accessible parent, never through a revision ID.
export async function itemHistory(accountId: string, collectionId: string, itemId: string) {
  const result = await database().execute({
    sql: `WITH accessible AS (
      SELECT i.* FROM items i JOIN memberships m ON m.collection_id=i.collection_id
      WHERE i.id=? AND i.collection_id=? AND m.account_id=?
      AND EXISTS (SELECT 1 FROM item_photos p WHERE p.item_id=i.id AND p.removed_at IS NULL)
    ), versions AS (
      SELECT r.id, r.version, r.name, r.description, r.status, r.current_keeper_id, r.current_keeper_version, r.category_id, r.location_id, r.edited_by, r.edited_at
      FROM item_revisions r JOIN accessible i ON i.id=r.item_id
      UNION ALL
      SELECT i.id, i.version, i.name, i.description, i.status, i.current_keeper_id, i.current_keeper_version, i.category_id, i.location_id,
        COALESCE(i.last_edited_by,i.created_by), COALESCE(i.updated_at,i.created_at) FROM accessible i
    ) SELECT v.*, COALESCE(a.historical_email,a.email) AS editor_email, c.name AS category_name, l.name AS location_name,
      CASE WHEN p.version=v.current_keeper_version THEN p.name ELSE pr.name END AS keeper_name,
      CASE WHEN p.version=v.current_keeper_version THEN p.note ELSE pr.note END AS keeper_note
      FROM versions v JOIN accounts a ON a.id=v.edited_by
      LEFT JOIN item_category_labels c ON c.id=v.category_id AND c.collection_id=?
      LEFT JOIN item_location_labels l ON l.id=v.location_id AND l.collection_id=?
      LEFT JOIN people p ON p.id=v.current_keeper_id AND p.collection_id=?
      LEFT JOIN person_revisions pr ON pr.person_id=p.id AND pr.version=v.current_keeper_version
      ORDER BY v.version`,
    args: [itemId, collectionId, accountId, collectionId, collectionId, collectionId],
  });
  return result.rows.map(row => ({
    id: String(row.id), version: Number(row.version), name: String(row.name), description: String(row.description), status: String(row.status),
    currentKeeperId: row.current_keeper_id === null ? "" : String(row.current_keeper_id),
    category: { id: row.category_id ? String(row.category_id) : "", name: row.category_name === null ? "" : String(row.category_name) },
    location: { id: row.location_id ? String(row.location_id) : "", name: row.location_name === null ? "" : String(row.location_name) },
    keeperLabel: row.current_keeper_id === null ? "Not recorded" : row.keeper_name === null ? "Identifying details unavailable" : `${row.keeper_name}${row.keeper_note ? ` — ${row.keeper_note}` : ""}`,
    editorEmail: String(row.editor_email), editedAt: Number(row.edited_at),
  }));
}

export async function storyHistory(accountId: string, collectionId: string, itemId: string, storyId: string) {
  const result = await database().execute({
    sql: `WITH accessible AS (
      SELECT s.* FROM stories s JOIN items i ON i.id=s.item_id JOIN memberships m ON m.collection_id=i.collection_id
      WHERE s.id=? AND i.id=? AND i.collection_id=? AND m.account_id=?
      AND EXISTS (SELECT 1 FROM item_photos p WHERE p.item_id=i.id AND p.removed_at IS NULL)
    ), versions AS (
      SELECT r.id, r.version, r.text, r.storyteller_id, r.storyteller_version, r.recorded_by, r.recorded_at, r.edited_by, r.edited_at
      FROM story_revisions r JOIN accessible s ON s.id=r.story_id
      UNION ALL
      SELECT s.id, s.version, s.text, s.storyteller_id, s.storyteller_version, s.recorded_by, s.recorded_at, s.last_edited_by, s.updated_at FROM accessible s
    ) SELECT v.*, COALESCE(a.historical_email,a.email) AS editor_email, COALESCE(recorder.historical_email,recorder.email) AS recorder_email,
      CASE WHEN p.version=v.storyteller_version THEN p.name ELSE pr.name END AS storyteller_name,
      CASE WHEN p.version=v.storyteller_version THEN p.note ELSE pr.note END AS storyteller_note
      FROM versions v JOIN accounts a ON a.id=v.edited_by JOIN accounts recorder ON recorder.id=v.recorded_by
      JOIN people p ON p.id=v.storyteller_id AND p.collection_id=?
      LEFT JOIN person_revisions pr ON pr.person_id=p.id AND pr.version=v.storyteller_version
      ORDER BY v.version`,
    args: [storyId, itemId, collectionId, accountId, collectionId],
  });
  return result.rows.map(row => ({
    id: String(row.id), version: Number(row.version), text: String(row.text), editorEmail: String(row.editor_email), editedAt: Number(row.edited_at),
    recorderEmail: String(row.recorder_email), recordedAt: Number(row.recorded_at),
    storytellerLabel: row.storyteller_name === null ? "Identifying details unavailable" : `${row.storyteller_name}${row.storyteller_note ? ` — ${row.storyteller_note}` : ""}`,
  }));
}

export function recoveryVersion(value: string | string[] | undefined): number | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) return NaN;
  return Number(value);
}
