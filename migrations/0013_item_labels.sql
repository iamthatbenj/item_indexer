CREATE TABLE item_category_labels (
  id TEXT PRIMARY KEY,
  collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 100),
  name_key TEXT NOT NULL,
  UNIQUE(collection_id, name_key)
);
ALTER TABLE items ADD COLUMN category_id TEXT REFERENCES item_category_labels(id);
ALTER TABLE item_revisions ADD COLUMN category_id TEXT REFERENCES item_category_labels(id);

CREATE TABLE item_location_labels (
  id TEXT PRIMARY KEY,
  collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 100),
  name_key TEXT NOT NULL,
  UNIQUE(collection_id, name_key)
);
ALTER TABLE items ADD COLUMN location_id TEXT REFERENCES item_location_labels(id);
ALTER TABLE item_revisions ADD COLUMN location_id TEXT REFERENCES item_location_labels(id);
