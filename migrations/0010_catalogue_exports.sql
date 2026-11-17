-- Generated private derivatives, not new item/story source records.
CREATE TABLE catalogue_exports (
  id TEXT PRIMARY KEY,
  collection_id TEXT NOT NULL REFERENCES collections(id),
  requested_by TEXT NOT NULL REFERENCES accounts(id),
  snapshot TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('processing', 'ready', 'failed', 'deleting')),
  phase TEXT NOT NULL CHECK(phase IN ('photos', 'rendering', 'publishing', 'done')),
  attempts INTEGER NOT NULL CHECK(attempts BETWEEN 1 AND 3),
  lease TEXT,
  lease_expires_at INTEGER,
  progress INTEGER NOT NULL DEFAULT 0 CHECK(progress BETWEEN 0 AND 200),
  item_count INTEGER NOT NULL CHECK(item_count BETWEEN 0 AND 200),
  artifact_key TEXT UNIQUE,
  pdf_bytes INTEGER,
  sha256 TEXT,
  page_count INTEGER,
  error TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER,
  expires_at INTEGER NOT NULL,
  CHECK ((status = 'processing' AND lease IS NOT NULL AND lease_expires_at IS NOT NULL) OR
         (status <> 'processing' AND lease IS NULL AND lease_expires_at IS NULL)),
  CHECK (status <> 'ready' OR (artifact_key IS NOT NULL AND pdf_bytes > 0 AND sha256 IS NOT NULL AND page_count > 0 AND finished_at IS NOT NULL))
);
CREATE INDEX catalogue_exports_collection ON catalogue_exports(collection_id, created_at, id);
CREATE TABLE catalogue_export_attempts (
  export_id TEXT NOT NULL REFERENCES catalogue_exports(id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL CHECK(attempt BETWEEN 1 AND 3),
  started_by TEXT NOT NULL REFERENCES accounts(id),
  candidate_key TEXT NOT NULL UNIQUE,
  started_at INTEGER NOT NULL,
  PRIMARY KEY(export_id, attempt)
);
