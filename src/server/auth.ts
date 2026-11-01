import "server-only";
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { database, writeTransaction } from "./database";
import { deliverCode } from "./mail";
import { sessionCookie } from "./session-cookie";
import { allow, canSignIn, digest } from "./security";

export { sessionCookie } from "./session-cookie";

const MINUTE = 60_000;

function sessionDigest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function requestCode(email: string): Promise<void> {
  const now = Date.now();
  const id = randomUUID();
  const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
  const issued = await writeTransaction(async tx => {
    if (!await allow(tx, "request:global", 30, now)) return false;
    if (!await allow(tx, `request:${email}`, 3, now)) return false;
    if (!await canSignIn(tx, email, now)) return false;
    await tx.execute({ sql: "DELETE FROM email_challenges WHERE expires_at <= ?", args: [now] });
    await tx.execute({
      sql: `INSERT INTO email_challenges (id, email, digest, created_at, expires_at, attempts) VALUES (?, ?, ?, ?, ?, 0)
            ON CONFLICT(email) DO UPDATE SET id=excluded.id, digest=excluded.digest, created_at=excluded.created_at, expires_at=excluded.expires_at, attempts=0`,
      args: [id, email, digest(`code:${id}:${email}:${code}`), now, now + 10 * MINUTE],
    });
    return true;
  });
  if (!issued) return;
  try {
    // Never hold a write transaction open during external delivery.
    await deliverCode(email, code, id);
  } catch {
    // A later resend may already exist: only invalidate this delivery's challenge.
    await database().execute({ sql: "DELETE FROM email_challenges WHERE id = ?", args: [id] });
    // Keep the public response identical to unknown/throttled addresses.
    console.error("Sign-in email delivery failed. Check configured transport availability.");
  }
}

export async function redeemCode(email: string, code: string, trusted: boolean): Promise<{ token: string; expiresAt: number } | null> {
  const now = Date.now();
  return writeTransaction(async tx => {
    if (!await allow(tx, "verify:global", 300, now)) return null;
    if (!await allow(tx, `verify:${email}`, 10, now)) return null;
    // Eligibility can expire or be removed between request and redemption.
    if (!await canSignIn(tx, email, now)) return null;
    const result = await tx.execute({ sql: "SELECT * FROM email_challenges WHERE email=?", args: [email] });
    const challenge = result.rows[0];
    if (!challenge || Number(challenge.expires_at) <= now || Number(challenge.attempts) >= 5) return null;
    await tx.execute({ sql: "UPDATE email_challenges SET attempts = attempts + 1 WHERE id = ?", args: [challenge.id] });
    const expected = Buffer.from(String(challenge.digest), "hex");
    const actual = Buffer.from(digest(`code:${challenge.id}:${email}:${code}`), "hex");
    if (!timingSafeEqual(expected, actual)) return null;
    await tx.execute({ sql: "DELETE FROM email_challenges WHERE id = ?", args: [challenge.id] });
    await tx.execute({ sql: "INSERT INTO accounts (id, email, created_at) VALUES (?, ?, ?) ON CONFLICT(email) DO NOTHING", args: [randomUUID(), email, now] });
    const account = (await tx.execute({ sql: "SELECT id FROM accounts WHERE email = ?", args: [email] })).rows[0];
    const token = randomBytes(32).toString("base64url");
    const expiresAt = now + (trusted ? 30 * 24 : 12) * 60 * MINUTE;
    await tx.execute({ sql: "DELETE FROM sessions WHERE expires_at <= ?", args: [now] });
    await tx.execute({ sql: "INSERT INTO sessions VALUES (?, ?, ?, ?)", args: [sessionDigest(token), account.id, now, expiresAt] });
    return { token, expiresAt };
  });
}

export async function currentAccount(): Promise<{ id: string; email: string; founder: boolean } | null> {
  const token = (await cookies()).get(sessionCookie())?.value;
  if (!token || !/^[\w-]{43}$/.test(token)) return null;
  const result = await database().execute({
    sql: `SELECT a.id, a.email, f.email IS NOT NULL AS founder FROM sessions s
          JOIN accounts a ON a.id=s.account_id LEFT JOIN approved_founders f ON f.email=a.email
          WHERE s.token_digest=? AND s.expires_at>?`,
    args: [sessionDigest(token), Date.now()],
  });
  const row = result.rows[0];
  return row ? { id: String(row.id), email: String(row.email), founder: Boolean(row.founder) } : null;
}

export async function signOut(): Promise<void> {
  const token = (await cookies()).get(sessionCookie())?.value;
  if (token) await database().execute({ sql: "DELETE FROM sessions WHERE token_digest = ?", args: [sessionDigest(token)] });
}
