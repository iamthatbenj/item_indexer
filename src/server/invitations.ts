import "server-only";
import { randomUUID } from "node:crypto";
import { database, writeTransaction } from "./database";
import { deliverInvitation } from "./mail";
import { allow } from "./security";

type Account = { id: string; email: string };
type Invitation = { id: string; collectionId: string; name: string; expiresAt: number; accepted: boolean };

export async function listInvitations(email: string): Promise<Invitation[]> {
  const result = await database().execute({
    sql: `SELECT i.id, i.collection_id, c.name, i.expires_at FROM invitations i
          JOIN collections c ON c.id=i.collection_id
          WHERE i.email=? AND i.accepted_at IS NULL AND i.expires_at>? ORDER BY i.created_at, i.id`,
    args: [email, Date.now()],
  });
  return result.rows.map(row => ({ id: String(row.id), collectionId: String(row.collection_id), name: String(row.name), expiresAt: Number(row.expires_at), accepted: false }));
}

export async function getInvitation(account: Account, id: string): Promise<Invitation | null> {
  const result = await database().execute({
    sql: `SELECT i.id, i.collection_id, c.name, i.expires_at, i.accepted_at FROM invitations i
          JOIN collections c ON c.id=i.collection_id
          WHERE i.id=? AND i.email=? AND
          ((i.accepted_at IS NULL AND i.expires_at>?) OR (i.accepted_at IS NOT NULL AND EXISTS
          (SELECT 1 FROM memberships m WHERE m.collection_id=i.collection_id AND m.account_id=?)))`,
    args: [id, account.email, Date.now(), account.id],
  });
  const row = result.rows[0];
  return row ? { id: String(row.id), collectionId: String(row.collection_id), name: String(row.name), expiresAt: Number(row.expires_at), accepted: row.accepted_at !== null } : null;
}

export async function inviteMember(account: Account, collectionId: string, email: string): Promise<"sent" | "forbidden" | "member" | "limited" | "failed"> {
  const id = randomUUID();
  const issued = await writeTransaction(async tx => {
    const collection = (await tx.execute({
      sql: `SELECT c.name FROM collections c JOIN memberships m ON m.collection_id=c.id
            WHERE c.id=? AND m.account_id=? AND m.role='administrator'`, args: [collectionId, account.id],
    })).rows[0];
    if (!collection) return { status: "forbidden" } as const;
    const member = await tx.execute({
      sql: `SELECT 1 FROM memberships m JOIN accounts a ON a.id=m.account_id WHERE m.collection_id=? AND a.email=?`, args: [collectionId, email],
    });
    if (member.rows.length) return { status: "member" } as const;
    const now = Date.now();
    if (!await allow(tx, "invite:global", 30, now) || !await allow(tx, `invite:account:${account.id}`, 10, now) || !await allow(tx, `invite:email:${email}`, 3, now)) return { status: "limited" } as const;
    await tx.execute({
      sql: `INSERT INTO invitations (id, collection_id, email, invited_by, created_at, expires_at, accepted_at) VALUES (?, ?, ?, ?, ?, ?, NULL)
            ON CONFLICT(collection_id, email) DO UPDATE SET id=excluded.id, invited_by=excluded.invited_by,
            created_at=excluded.created_at, expires_at=excluded.expires_at, accepted_at=NULL`,
      args: [id, collectionId, email, account.id, now, now + 7 * 24 * 60 * 60_000],
    });
    return { status: "issued", name: String(collection.name) } as const;
  });
  if (issued.status !== "issued") return issued.status;
  try {
    await deliverInvitation(email, issued.name, id);
    return "sent";
  } catch {
    // Do not remove a later resend or undo acceptance that completed during delivery.
    await database().execute({ sql: "DELETE FROM invitations WHERE id=? AND accepted_at IS NULL", args: [id] });
    console.error("Invitation email delivery failed. Check configured transport availability.");
    return "failed";
  }
}

export async function acceptInvitation(account: Account, id: string): Promise<string | null> {
  return writeTransaction(async tx => {
    const invitation = (await tx.execute({ sql: "SELECT * FROM invitations WHERE id=? AND email=?", args: [id, account.email] })).rows[0];
    if (!invitation) return null;
    const member = await tx.execute({ sql: "SELECT role FROM memberships WHERE collection_id=? AND account_id=?", args: [invitation.collection_id, account.id] });
    // Replays must never rejoin a departed/removed member or change an existing role.
    if (invitation.accepted_at !== null) return member.rows.length ? String(invitation.collection_id) : null;
    if (Number(invitation.expires_at) <= Date.now()) return null;
    await tx.execute({
      sql: "INSERT INTO memberships (collection_id, account_id, role, joined_at) VALUES (?, ?, 'member', ?) ON CONFLICT(collection_id, account_id) DO NOTHING",
      args: [invitation.collection_id, account.id, Date.now()],
    });
    await tx.execute({ sql: "UPDATE invitations SET accepted_at=? WHERE id=?", args: [Date.now(), id] });
    return String(invitation.collection_id);
  });
}
