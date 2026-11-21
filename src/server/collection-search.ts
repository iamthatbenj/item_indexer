import "server-only";
import { database } from "./database";
import { SEARCH_PAGE_SIZE } from "@/shared/collection-search";

export async function searchCollection(accountId: string, collectionId: string, query: string, page: number) {
  // Scope both the collection name and hits in the same statement. An unrelated
  // or revoked account gets no row, not even the empty-results collection name.
  const result = await database().execute({
    sql: `WITH allowed AS (
      SELECT c.id, c.name FROM collections c JOIN memberships m ON m.collection_id=c.id
      WHERE c.id=? AND m.account_id=?
    ), needle AS (SELECT lower(?) AS text), candidates AS (
      SELECT i.id, i.name, i.description, i.status, i.created_at,
        CASE
          WHEN instr(lower(i.name), n.text)>0 THEN 1
          WHEN instr(lower(i.description), n.text)>0 THEN 2
          ELSE 3
        END AS priority
      FROM allowed a JOIN items i ON i.collection_id=a.id CROSS JOIN needle n
      WHERE n.text<>'' AND EXISTS (
        SELECT 1 FROM item_photos p WHERE p.item_id=i.id AND p.removed_at IS NULL
      )
    ), matches AS (
      SELECT i.*, CASE WHEN i.priority=3 THEN (
        SELECT s.id FROM stories s WHERE s.item_id=i.id AND instr(lower(s.text), n.text)>0
        ORDER BY s.recorded_at, s.id LIMIT 1
      ) END AS story_id
      FROM candidates i CROSS JOIN needle n
    ), result_page AS (
      SELECT id, name, description, status, created_at, priority, story_id FROM matches
      WHERE priority<3 OR story_id IS NOT NULL
      ORDER BY priority, created_at DESC, id LIMIT ? OFFSET ?
    )
    SELECT a.name AS collection_name, r.id, r.name, r.status, r.priority,
      CASE r.priority WHEN 2 THEN substr(r.description, max(1,instr(lower(r.description),n.text)-40), 180)
                      WHEN 3 THEN substr(s.text, max(1,instr(lower(s.text),n.text)-40), 180) END AS excerpt
    FROM allowed a CROSS JOIN needle n LEFT JOIN result_page r ON 1=1 LEFT JOIN stories s ON s.id=r.story_id
    ORDER BY r.priority, r.created_at DESC, r.id`,
    args: [collectionId, accountId, query, SEARCH_PAGE_SIZE + 1, (page - 1) * SEARCH_PAGE_SIZE],
  });
  if (!result.rows.length) return null;
  const hits = result.rows.filter(row => row.id !== null);
  return {
    collectionName: String(result.rows[0].collection_name),
    hasNext: hits.length > SEARCH_PAGE_SIZE,
    items: hits.slice(0, SEARCH_PAGE_SIZE).map(row => ({
      id: String(row.id), name: String(row.name), draft: row.status !== "complete",
      field: row.priority === 1 ? "Item name" : row.priority === 2 ? "Description" : "Story",
      excerpt: row.excerpt === null ? null : String(row.excerpt).replace(/\s+/gu, " ").trim(),
    })),
  };
}
