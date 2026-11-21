-- Imported identities hold credit only, never a usable login address.
ALTER TABLE accounts ADD COLUMN historical_email TEXT CHECK(historical_email IS NULL OR instr(email, '@') = 0);

CREATE TABLE archive_restores (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  archive_sha256 TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  lease_until INTEGER NOT NULL,
  collection_id TEXT REFERENCES collections(id),
  created_at INTEGER NOT NULL,
  UNIQUE(account_id, archive_sha256)
);

CREATE TABLE archive_restore_attempts (
  id TEXT PRIMARY KEY,
  restore_id TEXT NOT NULL REFERENCES archive_restores(id),
  created_at INTEGER NOT NULL
);

CREATE TABLE archive_origins (
  collection_id TEXT NOT NULL REFERENCES collections(id),
  record_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  source_collection_id TEXT NOT NULL,
  source_record_id TEXT NOT NULL,
  PRIMARY KEY(collection_id, record_type, record_id)
);
