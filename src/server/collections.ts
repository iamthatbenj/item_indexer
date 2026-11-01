import "server-only";
import { randomUUID } from "node:crypto";
import { database, writeTransaction } from "./database";

export async function listCollections(accountId: string): Promise<{ id: string; name: string }[]> {
  const result = await database().execute({
    sql: `SELECT c.id, c.name FROM collections c JOIN memberships m ON m.collection_id=c.id
          WHERE m.account_id=? ORDER BY c.created_at, c.id`, args: [accountId],
  });
  return result.rows.map(row => ({ id: String(row.id), name: String(row.name) }));
}

export async function getCollection(accountId: string, id: string): Promise<{ id: string; name: string; role: string } | null> {
  const result = await database().execute({
    sql: `SELECT c.id, c.name, m.role FROM collections c JOIN memberships m ON m.collection_id=c.id
          WHERE c.id=? AND m.account_id=?`, args: [id, accountId],
  });
  const row = result.rows[0];
  return row ? { id: String(row.id), name: String(row.name), role: String(row.role) } : null;
}

export async function createCollection(account: { id: string; email: string }, name: string): Promise<string | null> {
  return writeTransaction(async tx => {
    const approved = await tx.execute({ sql: "SELECT email FROM approved_founders WHERE email=?", args: [account.email] });
    if (!approved.rows.length) return null;
    const id = randomUUID();
    const now = Date.now();
    await tx.execute({ sql: "INSERT INTO collections VALUES (?, ?, ?)", args: [id, name, now] });
    await tx.execute({ sql: "INSERT INTO memberships VALUES (?, ?, 'administrator', ?)", args: [id, account.id, now] });
    return id;
  });
}
