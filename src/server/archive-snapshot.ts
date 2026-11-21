import "server-only";
import type { Transaction } from "@libsql/client";

export class ArchiveError extends Error { constructor(message: string, readonly status = 400) { super(message); } }
export const ARCHIVE_VERSION = "1.0";
export const ARCHIVE_ORIGINS_VERSION = "1.1";
export const ARCHIVE_LABELS_VERSION = "1.2";
export const ARCHIVE_MERGED_LABELS_VERSION = "1.3";
export const archiveLabelGroups = ["categories", "locations"] as const;
export const originGroups = ["collection", "contributors", "items", "people", "stories", "photos", "item_revisions", "person_revisions", "story_revisions", ...archiveLabelGroups] as const;
export type ArchiveOrigin = { record_type: typeof originGroups[number]; record_id: string; source_collection_id: string; source_record_id: string };
export const ARCHIVE_LIMIT = 256 * 1024 * 1024;
export type ArchiveRow = Record<string, string | number | null>;
export type ArchiveFile = { path: string; bytes: number; sha256: string };
export type ArchivePhoto = ArchiveRow & { retained_file: ArchiveFile | null; thumbnail_file: ArchiveFile | null };
export type ArchiveData = {
  format: "family-belongings"; version: string;
  snapshot: { id: string; captured_at: number; source_collection_id: string; generated_by: string };
  collection: ArchiveRow; contributors: ArchiveRow[]; items: ArchiveRow[]; item_revisions: ArchiveRow[];
  people: ArchiveRow[]; person_revisions: ArchiveRow[]; stories: ArchiveRow[]; story_revisions: ArchiveRow[];
  photos: ArchivePhoto[];
  origins?: ArchiveOrigin[];
  categories?: ArchiveRow[];
  locations?: ArchiveRow[];
};
export type ArchiveSnapshot = { data: ArchiveData; files: { path: string; key: string; maximum: number; bytes: number | null; sha256: string | null }[] };
const invalid = () => new ArchiveError("Saved relationships or history are incomplete. Contact the operator before exporting; no partial archive was created.", 409);
export const MAX_CREDITED_CONTRIBUTORS = 200;
export const MAX_ARCHIVE_ORIGINS = 10000 + MAX_CREDITED_CONTRIBUTORS + 2; // domain records, credits, requester, collection
const contributorFields = ["created_by", "last_edited_by", "recorded_by", "edited_by", "removed_by"] as const;
const limit = () => new ArchiveError("This collection exceeds the pilot archive limits (200 items, 2000 people, 1000 stories, 500 active photos, 10000 total records, 8 MiB structured data and 256 MiB ZIP). Contact the operator; nothing was silently omitted.", 422);

// Explicit columns are the export boundary: never serialize accounts.*, tokens,
// membership roles, idempotency hashes, storage keys or arbitrary future columns.
export async function captureArchiveSnapshot(tx: Transaction, collectionId: string, accountId: string, id: string, capturedAt: number): Promise<ArchiveSnapshot> {
  const collection = (await tx.execute({ sql: "SELECT c.id,c.name,c.created_at FROM collections c JOIN memberships m ON m.collection_id=c.id WHERE c.id=? AND m.account_id=?", args: [collectionId, accountId] })).rows[0];
  if (!collection) throw new ArchiveError("This archive or family collection is unavailable.", 404);
  async function rows(sql: string): Promise<ArchiveRow[]> {
    const result = await tx.execute({ sql, args: [collectionId] });
    return result.rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => {
      if (value !== null && typeof value !== "string" && typeof value !== "number") throw invalid();
      return [key, value];
    })) as ArchiveRow);
  }
  const items = await rows("SELECT id,name,description,status,version,created_by,created_at,last_edited_by,updated_at,current_keeper_id,current_keeper_version,category_id,location_id FROM items WHERE collection_id=? ORDER BY created_at,id LIMIT 201");
  const people = await rows("SELECT id,name,note,version,created_by,created_at,last_edited_by,updated_at FROM people WHERE collection_id=? ORDER BY created_at,id LIMIT 2001");
  const stories = await rows("SELECT s.id,s.item_id,s.storyteller_id,s.storyteller_version,s.text,s.version,s.recorded_by,s.recorded_at,s.last_edited_by,s.updated_at FROM stories s JOIN items i ON i.id=s.item_id WHERE i.collection_id=? ORDER BY s.recorded_at,s.id LIMIT 1001");
  const itemRevisions = await rows("SELECT r.id,r.item_id,r.version,r.name,r.description,r.status,r.edited_by,r.edited_at,r.current_keeper_id,r.current_keeper_version,r.category_id,r.location_id FROM item_revisions r JOIN items i ON i.id=r.item_id WHERE i.collection_id=? ORDER BY r.item_id,r.version LIMIT 10001");
  const personRevisions = await rows("SELECT r.id,r.person_id,r.version,r.name,r.note,r.edited_by,r.edited_at FROM person_revisions r JOIN people p ON p.id=r.person_id WHERE p.collection_id=? ORDER BY r.person_id,r.version LIMIT 10001");
  const storyRevisions = await rows("SELECT r.id,r.story_id,r.version,r.text,r.storyteller_id,r.storyteller_version,r.recorded_by,r.recorded_at,r.edited_by,r.edited_at FROM story_revisions r JOIN stories s ON s.id=r.story_id JOIN items i ON i.id=s.item_id WHERE i.collection_id=? ORDER BY r.story_id,r.version LIMIT 10001");
  const photoRows = await rows("SELECT p.id,p.item_id,p.photo_key,p.thumbnail_key,p.width,p.height,p.photo_bytes,p.sha256,p.created_at,p.created_by,p.removed_at,p.removed_by FROM item_photos p JOIN items i ON i.id=p.item_id WHERE i.collection_id=? ORDER BY p.created_at,p.id LIMIT 10001");
  const categories = await rows("SELECT id,name,merged_into_id FROM item_category_labels WHERE collection_id=? ORDER BY id LIMIT 10001");
  const locations = await rows("SELECT id,name,merged_into_id FROM item_location_labels WHERE collection_id=? ORDER BY id LIMIT 10001");
  const groups = [items, people, stories, itemRevisions, personRevisions, storyRevisions, photoRows, categories, locations];
  if (items.length > 200 || people.length > 2000 || stories.length > 1000 || photoRows.filter(p => p.removed_at === null).length > 500 || groups.reduce((n, group) => n + group.length, 0) > 10000) throw limit();
  const origins = (await tx.execute({ sql: "SELECT record_type,record_id,source_collection_id,source_record_id FROM archive_origins WHERE collection_id=? ORDER BY record_type,record_id LIMIT ?", args: [collectionId, MAX_ARCHIVE_ORIGINS + 1] })).rows;
  if (origins.length > MAX_ARCHIVE_ORIGINS) throw limit();
  const contributorIds = new Set<string>();
  for (const group of groups) for (const row of group) for (const field of ["created_by", "last_edited_by", "recorded_by", "edited_by", "removed_by"]) {
    if (row[field] !== undefined && row[field] !== null) contributorIds.add(String(row[field]));
  }
  if (contributorIds.size > MAX_CREDITED_CONTRIBUTORS) throw limit();
  contributorIds.add(accountId);
  if (!origins.length && !categories.length && !locations.length && contributorIds.size > MAX_CREDITED_CONTRIBUTORS) throw limit();
  const contributors = (await tx.execute({ sql: `SELECT id,COALESCE(historical_email,email) AS email FROM accounts WHERE id IN (${[...contributorIds].map(() => "?").join(",")}) ORDER BY id`, args: [...contributorIds] })).rows.map(row => ({ id: String(row.id), email: String(row.email) }));
  if (contributors.length !== contributorIds.size) throw invalid();
  const files: ArchiveSnapshot["files"] = [];
  const photos = photoRows.map((row, index) => {
    const { photo_key: main, thumbnail_key: thumb, ...record } = row;
    const photo = { ...record, retained_file: null, thumbnail_file: null } as ArchivePhoto;
    if (row.removed_at === null) {
      const prefix = `attachments/${String(index + 1).padStart(6, "0")}`;
      photo.retained_file = { path: `${prefix}/retained.jpg`, bytes: Number(row.photo_bytes), sha256: String(row.sha256) };
      photo.thumbnail_file = { path: `${prefix}/thumbnail.jpg`, bytes: 0, sha256: "" };
      files.push({ ...photo.retained_file, key: String(main), maximum: 20 * 1024 * 1024 });
      files.push({ path: photo.thumbnail_file.path, key: String(thumb), maximum: 512 * 1024, bytes: null, sha256: null });
    }
    return photo;
  });
  if (files.reduce((n, file) => n + (file.bytes ?? 0), 0) > 240 * 1024 * 1024) throw limit();
  const data: ArchiveData = { format: "family-belongings", version: ARCHIVE_VERSION, snapshot: { id, captured_at: capturedAt, source_collection_id: collectionId, generated_by: accountId }, collection: collection as ArchiveRow, contributors, items, item_revisions: itemRevisions, people, person_revisions: personRevisions, stories, story_revisions: storyRevisions, photos };
  if (origins.length) {
    data.version = ARCHIVE_ORIGINS_VERSION;
    data.origins = origins.filter(row => row.record_type !== "contributors" || contributorIds.has(String(row.record_id))).map(row => ({ record_type: String(row.record_type) as ArchiveOrigin["record_type"], record_id: String(row.record_id), source_collection_id: String(row.source_collection_id), source_record_id: String(row.source_record_id) }));
  }
  if (categories.length || locations.length || [...items, ...itemRevisions].some(row => row.category_id !== null || row.location_id !== null)) {
    const labels = [...categories, ...locations];
    data.version = labels.some(row => row.merged_into_id !== null) ? ARCHIVE_MERGED_LABELS_VERSION : ARCHIVE_LABELS_VERSION;
    if (data.version === ARCHIVE_LABELS_VERSION) for (const row of labels) delete row.merged_into_id;
    data.categories = categories; data.locations = locations;
    data.origins ??= [];
  } else for (const row of [...items, ...itemRevisions]) {
    delete row.category_id; delete row.location_id;
  }
  validateArchiveRelationships(data);
  if (Buffer.byteLength(JSON.stringify(data)) > 8 * 1024 * 1024) throw limit();
  return { data, files };
}

export function validateArchiveRelationships(data: ArchiveData) {
  function index(rows: ArchiveRow[]) {
    const result = new Map(rows.map(row => [row.id, row]));
    if (result.size !== rows.length || rows.some(row => typeof row.id !== "string" || !row.id)) throw invalid();
    return result;
  }
  const items = index(data.items), people = index(data.people), stories = index(data.stories), contributors = index(data.contributors);
  const personVersions = new Set([...data.people.map(p => `${p.id}:${p.version}`), ...data.person_revisions.map(p => `${p.person_id}:${p.version}`)]);
  const ref = (value: unknown, target: Map<unknown, ArchiveRow>, nullable = false) => { if (!(nullable && value === null) && !target.has(value)) throw invalid(); };
  const person = (id: unknown, version: unknown) => { if (id === null && version === null) return; if (!people.has(id as string) || !personVersions.has(`${id}:${version}`)) throw invalid(); };
  for (const row of [...data.items, ...data.item_revisions]) person(row.current_keeper_id, row.current_keeper_version);
  for (const row of data.stories) ref(row.item_id, items);
  for (const row of [...data.stories, ...data.story_revisions]) {
    person(row.storyteller_id, row.storyteller_version);
    if (row.storyteller_id === null) throw invalid();
  }
  for (const row of data.photos) {
    ref(row.item_id, items);
    if ((row.removed_at === null) !== (row.removed_by === null) || !/^[0-9a-f]{64}$/.test(String(row.sha256)) || !Number.isSafeInteger(row.photo_bytes) || Number(row.photo_bytes) < 1) throw invalid();
    if ([row.width, row.height].some(value => !Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 3200)) throw invalid();
  }
  for (const item of data.items) {
    if ((item.last_edited_by === null) !== (item.updated_at === null) || item.last_edited_by === null && item.version !== 1) throw invalid();
  }
  for (const item of data.items) if (!data.photos.some(p => p.item_id === item.id && p.removed_at === null)) throw invalid();
  for (const [current, revisions, parent] of [[data.items, data.item_revisions, "item_id"], [data.people, data.person_revisions, "person_id"], [data.stories, data.story_revisions, "story_id"]] as const) {
    index(revisions);
    const parents = index(current);
    for (const revision of revisions) ref(revision[parent], parents);
    for (const row of current) {
      const versions = revisions.filter(r => r[parent] === row.id).map(r => Number(r.version)).sort((a, b) => a - b);
      if (!Number.isSafeInteger(row.version) || Number(row.version) < 1 || versions.length !== Number(row.version) - 1 || versions.some((v, i) => v !== i + 1)) throw invalid();
    }
  }
  const photos = index(data.photos);
  const categories = index(data.categories ?? []), locations = index(data.locations ?? []);
  const merged = data.version === ARCHIVE_MERGED_LABELS_VERSION;
  if (data.version === ARCHIVE_LABELS_VERSION || merged) {
    for (const group of [categories, locations]) {
      const names = [...group.values()].map(row => row.name);
      if (names.some(name => typeof name !== "string" || !name || name.length > 100 || name !== name.trim().normalize("NFC") || /[\x00-\x1f\x7f]/u.test(name))) throw invalid();
      if (new Set(names.map(name => String(name).toLowerCase().normalize("NFC"))).size !== names.length) throw invalid();
      if (merged) for (const row of group.values()) {
        ref(row.merged_into_id, group, true);
        if (row.merged_into_id !== null && group.get(row.merged_into_id)?.merged_into_id !== null) throw invalid();
      }
    }
    for (const row of [...data.items, ...data.item_revisions]) {
      ref(row.category_id, categories, true); ref(row.location_id, locations, true);
    }
    if (merged && data.items.some(row => categories.get(row.category_id)?.merged_into_id || locations.get(row.location_id)?.merged_into_id)) throw invalid();
  }
  if (data.version !== ARCHIVE_VERSION) {
    if (!data.origins || data.origins.length > MAX_ARCHIVE_ORIGINS) throw invalid();
    const all = { collection: index([data.collection]), items, people, stories, contributors, photos, categories, locations, item_revisions: index(data.item_revisions), story_revisions: index(data.story_revisions), person_revisions: index(data.person_revisions) };
    const seen = new Set<string>();
    for (const origin of data.origins) {
      if (!originGroups.includes(origin.record_type) || !origin.source_collection_id || !origin.source_record_id) throw invalid();
      ref(origin.record_id, all[origin.record_type]);
      const key = JSON.stringify([origin.record_type, origin.record_id]);
      if (seen.has(key)) throw invalid();
      seen.add(key);
    }
    if ((data.version === ARCHIVE_ORIGINS_VERSION || data.origins.length) && !seen.has(JSON.stringify(["collection", data.collection.id]))) throw invalid();
  }
  ref(data.snapshot.generated_by, contributors);
  const credited = new Set<string>();
  for (const rows of [data.items, data.people, data.stories, data.photos, data.item_revisions, data.person_revisions, data.story_revisions]) for (const row of rows) for (const field of contributorFields) {
    const value = row[field];
    if (value === undefined) continue;
    ref(value, contributors, field === "last_edited_by" && "name" in row && "description" in row || field === "removed_by");
    if (typeof value === "string") credited.add(value);
  }
  if (credited.size > MAX_CREDITED_CONTRIBUTORS) throw invalid();
  if (contributors.size > MAX_CREDITED_CONTRIBUTORS) {
    // The only extra entry in 1.1 may be the requester, not another record credit.
    if (data.version === ARCHIVE_VERSION || credited.has(data.snapshot.generated_by) || contributors.size !== credited.size + 1) throw invalid();
  }
  for (const revision of data.story_revisions) {
    const current = stories.get(revision.story_id)!;
    if (["storyteller_id", "storyteller_version", "recorded_by", "recorded_at"].some(key => current[key] !== revision[key])) throw invalid();
  }
}
