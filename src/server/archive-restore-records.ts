import "server-only";
import { randomUUID } from "node:crypto";
import type { InStatement, Transaction } from "@libsql/client";
import type { ArchiveData, ArchiveRow } from "./archive-snapshot";

// These are explicit destination columns, not identifiers taken from the ZIP.
const groups = [
  ["people", "people", "id collection_id name note version created_by created_at creation_hash last_edited_by updated_at"],
  ["items", "items", "id collection_id name description version created_by created_at last_edited_by updated_at current_keeper_id current_keeper_version"],
  ["stories", "stories", "id item_id storyteller_id storyteller_version text version recorded_by recorded_at last_edited_by updated_at creation_hash"],
  ["photos", "item_photos", "id item_id photo_key thumbnail_key width height photo_bytes sha256 created_at created_by removed_at removed_by"],
  ["person_revisions", "person_revisions", "id person_id version name note edited_by edited_at"],
  ["item_revisions", "item_revisions", "id item_id version name description status edited_by edited_at current_keeper_id current_keeper_version"],
  ["story_revisions", "story_revisions", "id story_id version text storyteller_id storyteller_version recorded_by recorded_at edited_by edited_at"],
] as const;
const references = { item_id: "items", person_id: "people", current_keeper_id: "people", storyteller_id: "people", story_id: "stories", created_by: "contributors", last_edited_by: "contributors", recorded_by: "contributors", edited_by: "contributors", removed_by: "contributors" } as const;

export function restorePlan(data: ArchiveData, attempt: string) {
  const collection = randomUUID();
  const groupsWithCredit = ["contributors", ...groups.map(([name]) => name)] as const;
  const ids = new Map(groupsWithCredit.map(group => [group, new Map(data[group].map(r => [String(r.id), randomUUID()]))]));
  function mapped(group: typeof groupsWithCredit[number], id: string | number | null) {
    if (id === null) return null;
    const value = ids.get(group)?.get(String(id));
    if (!value) throw new Error("A validated archive reference could not be mapped.");
    return value;
  }
  const attachments = new Map<string, string>();
  for (const p of data.photos) {
    const photo = mapped("photos", p.id);
    if (p.retained_file && p.thumbnail_file) {
      attachments.set(p.retained_file.path, `photos/archive-restore/${attempt}/${photo}-retained.jpg`);
      attachments.set(p.thumbnail_file.path, `photos/archive-restore/${attempt}/${photo}-thumbnail.jpg`);
    }
  }

  async function publish(tx: Transaction, admin: string, now: number) {
    const statements: InStatement[] = [];
    function add(table: string, keys: string, args: (string | number | null)[]) {
      statements.push({ sql: `INSERT INTO ${table} (${keys.replaceAll(" ", ",")}) VALUES (${args.map(() => "?").join(",")})`, args });
    }
    const origins = new Map(data.origins?.map(row => [JSON.stringify([row.record_type, row.record_id]), row]));
    const origin = (group: string, record: string | null, source: ArchiveRow["id"]) => {
      const previous = origins.get(JSON.stringify([group, source]));
      add("archive_origins", "collection_id record_type record_id source_collection_id source_record_id", [collection, group, record, previous?.source_collection_id ?? data.snapshot.source_collection_id, previous?.source_record_id ?? source]);
    };
    add("collections", "id name created_at", [collection, data.collection.name, now]);
    origin("collection", collection, data.collection.id);
    add("memberships", "collection_id account_id role joined_at", [collection, admin, "administrator", now]);
    for (const row of data.contributors) {
      const id = mapped("contributors", row.id);
      // This internal key cannot pass the sign-in email parser. Never match a
      // historical contributor to a live account, even if the email is equal.
      add("accounts", "id email created_at historical_email", [id, `archive-credit:${id}`, now, row.email]);
      origin("contributors", id, row.id);
    }
    for (const [group, table, keys] of groups) for (const row of data[group]) {
      const id = mapped(group, row.id);
      add(table, keys, keys.split(" ").map(key => {
        if (key === "id") return id;
        if (key === "collection_id") return collection;
        if (key === "creation_hash") return `archive-restore:${id}`;
        if (key === "photo_key" || key === "thumbnail_key") {
          if (group !== "photos") throw new Error("Unexpected file reference.");
          const p = data.photos.find(value => value.id === row.id)!;
          const f = key === "photo_key" ? p.retained_file : p.thumbnail_file;
          return f ? attachments.get(f.path)! : `removed/archive-restore/${id}/${key}`;
        }
        if (Object.hasOwn(references, key)) return mapped(references[key as keyof typeof references], row[key] as ArchiveRow["id"]);
        return row[key] as ArchiveRow["id"];
      }));
      origin(group, id, row.id);
    }
    for (let i = 0; i < statements.length; i += 100) await tx.batch(statements.slice(i, i + 100));
  }
  return { collection, attachments, publish };
}
