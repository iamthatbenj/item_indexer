CREATE TABLE invitations (
  id TEXT PRIMARY KEY,
  collection_id TEXT NOT NULL REFERENCES collections(id),
  email TEXT NOT NULL,
  invited_by TEXT NOT NULL REFERENCES accounts(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  accepted_at INTEGER,
  UNIQUE(collection_id, email)
);
CREATE INDEX invitations_email ON invitations(email, accepted_at, expires_at);
