ALTER TABLE items ADD COLUMN name TEXT NOT NULL DEFAULT '' CHECK(length(name) <= 200);
ALTER TABLE items ADD COLUMN description TEXT NOT NULL DEFAULT '' CHECK(length(description) <= 1200);
ALTER TABLE items ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1);
ALTER TABLE items ADD COLUMN last_edited_by TEXT REFERENCES accounts(id);
ALTER TABLE items ADD COLUMN updated_at INTEGER;

ALTER TABLE items DROP COLUMN status;
ALTER TABLE items ADD COLUMN status TEXT GENERATED ALWAYS AS (
  CASE WHEN length(name) > 0 AND length(description) > 0 THEN 'complete' ELSE 'draft' END
) VIRTUAL;

CREATE TABLE item_revisions (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id),
  version INTEGER NOT NULL CHECK(version >= 1),
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('draft', 'complete')),
  edited_by TEXT NOT NULL REFERENCES accounts(id),
  edited_at INTEGER NOT NULL,
  UNIQUE(item_id, version)
);
