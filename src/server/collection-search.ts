import "server-only";
import { database } from "./database";
import { SEARCH_PAGE_SIZE, searchFilterKeys, type SearchChoice, type SearchChoices, type SearchFilter, type SearchFilters } from "@/shared/collection-search";

type StoredChoice = SearchChoice & { kind: Exclude<SearchFilter, "status"> };

export async function searchCollection(accountId: string, collectionId: string, query: string, page: number, filters: SearchFilters, showResults: boolean) {
  // Scope both the collection name and hits in the same statement. An unrelated
  // or revoked account gets no row, not even the empty-results collection name.
  const result = await database().execute({
    sql: `WITH allowed AS (
      SELECT c.id, c.name FROM collections c JOIN memberships m ON m.collection_id=c.id
      WHERE c.id=? AND m.account_id=?
    ), choices AS (
      SELECT 'category' AS kind, l.id, l.name, '' AS note FROM allowed a JOIN item_category_labels l ON l.collection_id=a.id WHERE l.merged_into_id IS NULL
      UNION ALL SELECT 'location', l.id, l.name, '' FROM allowed a JOIN item_location_labels l ON l.collection_id=a.id WHERE l.merged_into_id IS NULL
      UNION ALL SELECT 'keeper', p.id, p.name, p.note FROM allowed a JOIN people p ON p.collection_id=a.id
    ), input AS (SELECT lower(?) AS text, ? AS category, ? AS keeper, ? AS location, ? AS status, ? AS enabled),
    needle AS (
      SELECT * FROM input n WHERE n.enabled
        AND (n.category IN ('','unassigned') OR EXISTS (SELECT 1 FROM choices c WHERE c.kind='category' AND c.id=n.category))
        AND (n.keeper IN ('','unassigned') OR EXISTS (SELECT 1 FROM choices c WHERE c.kind='keeper' AND c.id=n.keeper))
        AND (n.location IN ('','unassigned') OR EXISTS (SELECT 1 FROM choices c WHERE c.kind='location' AND c.id=n.location))
    ), candidates AS (
      SELECT i.id, i.name, i.description, i.status, i.created_at,
        CASE
          WHEN n.text='' THEN 0
          WHEN instr(lower(i.name), n.text)>0 THEN 1
          WHEN instr(lower(i.description), n.text)>0 THEN 2
          ELSE 3
        END AS priority
      FROM allowed a JOIN items i ON i.collection_id=a.id CROSS JOIN needle n
      WHERE (n.category='' OR (n.category='unassigned' AND i.category_id IS NULL) OR i.category_id=n.category)
        AND (n.keeper='' OR (n.keeper='unassigned' AND i.current_keeper_id IS NULL) OR i.current_keeper_id=n.keeper)
        AND (n.location='' OR (n.location='unassigned' AND i.location_id IS NULL) OR i.location_id=n.location)
        AND (n.status='' OR i.status=n.status)
        AND EXISTS (
        SELECT 1 FROM item_photos p WHERE p.item_id=i.id AND p.removed_at IS NULL
      )
    ), matches AS (
      SELECT i.*, CASE WHEN i.priority=3 THEN (
        SELECT s.id FROM stories s WHERE s.item_id=i.id AND instr(lower(s.text), n.text)>0
        ORDER BY s.recorded_at, s.id LIMIT 1
      ) END AS story_id
      FROM candidates i CROSS JOIN needle n
    ), hits AS MATERIALIZED (
      SELECT id, name, description, status, created_at, priority, story_id FROM matches
      WHERE priority<3 OR story_id IS NOT NULL
    ), result_page AS (
      SELECT * FROM hits ORDER BY priority, created_at DESC, id LIMIT ? OFFSET ?
    ), metadata AS (
      SELECT (SELECT count(*) FROM hits) AS total,
        (SELECT json_group_array(json_object('kind',kind,'id',id,'name',name,'note',note))
           FROM (SELECT * FROM choices ORDER BY name COLLATE NOCASE, id)) AS options
    )
    SELECT a.name AS collection_name, r.id, r.name, r.status, r.priority, m.total,
      CASE WHEN r.id IS NULL OR r.id=(SELECT id FROM result_page ORDER BY priority, created_at DESC, id LIMIT 1) THEN m.options END AS options,
      CASE r.priority WHEN 2 THEN substr(r.description, max(1,instr(lower(r.description),n.text)-40), 180)
                      WHEN 3 THEN substr(s.text, max(1,instr(lower(s.text),n.text)-40), 180) END AS excerpt
    FROM allowed a CROSS JOIN metadata m CROSS JOIN input n LEFT JOIN result_page r ON 1=1 LEFT JOIN stories s ON s.id=r.story_id
    ORDER BY r.priority, r.created_at DESC, r.id`,
    args: [collectionId, accountId, query, filters.category, filters.keeper, filters.location, filters.status, showResults ? 1 : 0, SEARCH_PAGE_SIZE, (page - 1) * SEARCH_PAGE_SIZE],
  });
  if (!result.rows.length) return null;
  const hits = result.rows.filter(row => row.id !== null);
  const options: SearchChoices = { category: [], keeper: [], location: [], status: [{ id: "draft", name: "Draft items" }, { id: "complete", name: "Complete items" }] };
  for (const { kind, ...choice } of JSON.parse(String(result.rows.find(row => row.options !== null)?.options ?? "[]")) as StoredChoice[]) options[kind].push(choice);
  const unavailable = searchFilterKeys.filter(key => filters[key] !== "" && (key === "status" || filters[key] !== "unassigned") && !options[key].some(choice => choice.id === filters[key]));
  const total = Number(result.rows[0].total);
  return {
    collectionName: String(result.rows[0].collection_name), options, unavailable, total,
    hasNext: total > page * SEARCH_PAGE_SIZE,
    items: hits.map(row => ({
      id: String(row.id), name: String(row.name), draft: row.status !== "complete",
      field: row.priority === 1 ? "Item name" : row.priority === 2 ? "Description" : row.priority === 3 ? "Story" : null,
      excerpt: row.excerpt === null ? null : String(row.excerpt).replace(/\s+/gu, " ").trim(),
    })),
  };
}
