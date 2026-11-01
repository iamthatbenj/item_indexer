import "server-only";
import { createHmac } from "node:crypto";
import type { Transaction } from "@libsql/client";

export function digest(value: string): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 32 || secret.startsWith("replace-this")) throw new Error("Set a random AUTH_SECRET of at least 32 characters.");
  return createHmac("sha256", secret).update(value).digest("hex");
}

// Shared, durable fixed-window counters. Namespace scopes by operation.
export async function allow(tx: Transaction, scope: string, limit: number, now: number): Promise<boolean> {
  const window = 15 * 60_000;
  const key = digest(`rate:${scope}`);
  const start = Math.floor(now / window) * window;
  await tx.execute({ sql: "DELETE FROM rate_limits WHERE window_start < ?", args: [start - window] });
  const result = await tx.execute({
    sql: `INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
          ON CONFLICT(key, window_start) DO UPDATE SET count = count + 1 RETURNING count`,
    args: [key, start],
  });
  return Number(result.rows[0].count) <= limit;
}

export async function canSignIn(tx: Transaction, email: string, now: number): Promise<boolean> {
  const result = await tx.execute({
    sql: `SELECT 1 FROM approved_founders WHERE email=?
          UNION ALL SELECT 1 FROM memberships m JOIN accounts a ON a.id=m.account_id WHERE a.email=?
          UNION ALL SELECT 1 FROM invitations WHERE email=? AND accepted_at IS NULL AND expires_at>? LIMIT 1`,
    args: [email, email, email, now],
  });
  return result.rows.length > 0;
}
