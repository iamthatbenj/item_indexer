CREATE TABLE people (
  id TEXT PRIMARY KEY,
  collection_id TEXT NOT NULL REFERENCES collections(id),
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 200),
  note TEXT NOT NULL DEFAULT '' CHECK(length(note) <= 400),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  created_by TEXT NOT NULL REFERENCES accounts(id),
  created_at INTEGER NOT NULL,
  creation_hash TEXT NOT NULL,
  last_edited_by TEXT NOT NULL REFERENCES accounts(id),
  updated_at INTEGER NOT NULL
);
CREATE INDEX people_collection ON people(collection_id, name, id);
CREATE TABLE person_revisions (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people(id),
  version INTEGER NOT NULL CHECK(version >= 1),
  name TEXT NOT NULL,
  note TEXT NOT NULL,
  edited_by TEXT NOT NULL REFERENCES accounts(id),
  edited_at INTEGER NOT NULL,
  UNIQUE(person_id, version)
);
ALTER TABLE items ADD COLUMN current_keeper_id TEXT REFERENCES people(id);
ALTER TABLE items ADD COLUMN current_keeper_version INTEGER CHECK(
  (current_keeper_id IS NULL AND current_keeper_version IS NULL) OR
  (current_keeper_id IS NOT NULL AND current_keeper_version >= 1 AND current_keeper_version IS NOT NULL)
);
ALTER TABLE item_revisions ADD COLUMN current_keeper_id TEXT REFERENCES people(id);
ALTER TABLE item_revisions ADD COLUMN current_keeper_version INTEGER CHECK(
  (current_keeper_id IS NULL AND current_keeper_version IS NULL) OR
  (current_keeper_id IS NOT NULL AND current_keeper_version >= 1 AND current_keeper_version IS NOT NULL)
);
CREATE INDEX items_current_keeper ON items(current_keeper_id);
