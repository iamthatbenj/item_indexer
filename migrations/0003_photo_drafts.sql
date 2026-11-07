CREATE TABLE photo_uploads (
  id TEXT PRIMARY KEY,
  collection_id TEXT NOT NULL REFERENCES collections(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  input_bytes INTEGER NOT NULL CHECK(input_bytes BETWEEN 1 AND 20971520),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending', 'processing', 'saved')),
  attempt TEXT,
  lease_until INTEGER
);
CREATE INDEX photo_uploads_account ON photo_uploads(account_id, created_at);
CREATE INDEX photo_uploads_lease ON photo_uploads(state, lease_until);

CREATE TABLE items (
  id TEXT PRIMARY KEY,
  collection_id TEXT NOT NULL REFERENCES collections(id),
  created_by TEXT NOT NULL REFERENCES accounts(id),
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status = 'draft')
);
CREATE INDEX items_collection ON items(collection_id, created_at);

CREATE TABLE item_photos (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL UNIQUE REFERENCES items(id),
  photo_key TEXT NOT NULL UNIQUE,
  thumbnail_key TEXT NOT NULL UNIQUE,
  width INTEGER NOT NULL CHECK(width BETWEEN 1 AND 3200),
  height INTEGER NOT NULL CHECK(height BETWEEN 1 AND 3200),
  photo_bytes INTEGER NOT NULL CHECK(photo_bytes > 0),
  sha256 TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
