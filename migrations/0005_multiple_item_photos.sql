CREATE TABLE item_photos_next (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id),
  photo_key TEXT NOT NULL UNIQUE,
  thumbnail_key TEXT NOT NULL UNIQUE,
  width INTEGER NOT NULL CHECK(width BETWEEN 1 AND 3200),
  height INTEGER NOT NULL CHECK(height BETWEEN 1 AND 3200),
  photo_bytes INTEGER NOT NULL CHECK(photo_bytes > 0),
  sha256 TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL REFERENCES accounts(id),
  removed_at INTEGER,
  removed_by TEXT REFERENCES accounts(id),
  CHECK ((removed_at IS NULL AND removed_by IS NULL) OR (removed_at IS NOT NULL AND removed_by IS NOT NULL))
);
INSERT INTO item_photos_next (id, item_id, photo_key, thumbnail_key, width, height, photo_bytes, sha256, created_at, created_by)
  SELECT p.id, p.item_id, p.photo_key, p.thumbnail_key, p.width, p.height, p.photo_bytes, p.sha256, p.created_at, i.created_by
  FROM item_photos p JOIN items i ON i.id=p.item_id;
DROP TABLE item_photos;
ALTER TABLE item_photos_next RENAME TO item_photos;
CREATE INDEX item_photos_item ON item_photos(item_id, removed_at, created_at, id);
ALTER TABLE photo_uploads ADD COLUMN target_item_id TEXT REFERENCES items(id);
