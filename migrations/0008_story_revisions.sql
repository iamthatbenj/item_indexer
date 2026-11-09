CREATE TABLE story_revisions (
  id TEXT PRIMARY KEY,
  story_id TEXT NOT NULL REFERENCES stories(id),
  version INTEGER NOT NULL CHECK(version >= 1),
  text TEXT NOT NULL,
  storyteller_id TEXT NOT NULL REFERENCES people(id),
  storyteller_version INTEGER NOT NULL CHECK(storyteller_version >= 1),
  recorded_by TEXT NOT NULL REFERENCES accounts(id),
  recorded_at INTEGER NOT NULL,
  edited_by TEXT NOT NULL REFERENCES accounts(id),
  edited_at INTEGER NOT NULL,
  UNIQUE(story_id, version)
);
