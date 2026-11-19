import type { Client } from "@libsql/client";

export async function removeArchiveSchema(db: Client) {
  if (Number((await db.execute("SELECT COUNT(*) AS count FROM archive_exports")).rows[0].count) !== 0) throw new Error("Legacy fixture must have no archive requests.");
  await db.batch(["DROP TABLE archive_export_attempts", "DROP TABLE archive_exports", "DELETE FROM schema_migrations WHERE name='0011_portable_archives.sql'"], "write");
}

export async function removeCatalogueSchema(db: Client) {
  await removeArchiveSchema(db);
  if (Number((await db.execute("SELECT COUNT(*) AS count FROM catalogue_exports")).rows[0].count) !== 0) throw new Error("Legacy fixture must have no catalogue requests.");
  await db.batch(["DROP TABLE catalogue_export_attempts", "DROP TABLE catalogue_exports", "DELETE FROM schema_migrations WHERE name=\'0010_catalogue_exports.sql\'"], "write");
}

export async function removeInventorySchema(db: Client) {
  await removeCatalogueSchema(db);
  if (Number((await db.execute("SELECT COUNT(*) AS count FROM inventory_exports")).rows[0].count) !== 0) throw new Error("Legacy fixture must have no inventory requests.");
  await db.batch(["DROP TABLE inventory_export_attempts", "DROP TABLE inventory_exports", "DELETE FROM schema_migrations WHERE name='0009_inventory_exports.sql'"], "write");
}

export async function removeStoryRevisionsSchema(db: Client) {
  await removeInventorySchema(db);
  if (Number((await db.execute("SELECT COUNT(*) AS count FROM story_revisions")).rows[0].count) !== 0) throw new Error("Legacy fixture must have no story revisions.");
  await db.batch(["DROP TABLE story_revisions", "DELETE FROM schema_migrations WHERE name='0008_story_revisions.sql'"], "write");
}

export async function removeStoriesSchema(db: Client) {
  if (Number((await db.execute("SELECT COUNT(*) AS count FROM stories")).rows[0].count) !== 0) throw new Error("Legacy fixture must have no stories.");
  await removeStoryRevisionsSchema(db);
  await db.batch(["DROP TABLE stories", "DELETE FROM schema_migrations WHERE name='0007_attributed_stories.sql'"], "write");
}

// Only for isolated upgrade tests constructing pre-#9 databases. No people may
// exist: these tests are about migrating earlier populated item/photo schemas.
export async function removePeopleSchema(db: Client) {
  await removeStoriesSchema(db);
  if (Number((await db.execute("SELECT COUNT(*) AS count FROM people")).rows[0].count) !== 0) throw new Error("Legacy fixture must have no people.");
  await db.batch([
    "DROP INDEX items_current_keeper",
    "ALTER TABLE item_revisions DROP COLUMN current_keeper_version",
    "ALTER TABLE item_revisions DROP COLUMN current_keeper_id",
    "ALTER TABLE items DROP COLUMN current_keeper_version",
    "ALTER TABLE items DROP COLUMN current_keeper_id",
    "DROP TABLE person_revisions",
    "DROP TABLE people",
    "DELETE FROM schema_migrations WHERE name='0006_people_and_keepers.sql'",
  ], "write");
}
