import type { Client } from "@libsql/client";

export async function removeStoriesSchema(db: Client) {
  if (Number((await db.execute("SELECT COUNT(*) AS count FROM stories")).rows[0].count) !== 0) throw new Error("Legacy fixture must have no stories.");
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
