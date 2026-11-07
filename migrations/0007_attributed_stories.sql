CREATE TABLE stories (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id),
  storyteller_id TEXT NOT NULL REFERENCES people(id),
  storyteller_version INTEGER NOT NULL CHECK(storyteller_version >= 1),
  text TEXT NOT NULL CHECK(length(trim(text)) BETWEEN 1 AND 10000),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  recorded_by TEXT NOT NULL REFERENCES accounts(id),
  recorded_at INTEGER NOT NULL,
  last_edited_by TEXT NOT NULL REFERENCES accounts(id),
  updated_at INTEGER NOT NULL,
  creation_hash TEXT NOT NULL
);
CREATE INDEX stories_item ON stories(item_id, recorded_at, id);
