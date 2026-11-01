import "server-only";
import { database, writeTransaction } from "./database";

type Role = "administrator" | "member";
type Member = { id: string; email: string; role: Role };
export type MembershipAction = "promote" | "demote" | "remove";
type ChangeResult = "changed" | "unchanged" | "forbidden" | "missing" | "last-administrator";

// Authorize and fetch the administrator-only member list in one database snapshot.
export async function getMembershipManagement(accountId: string, collectionId: string): Promise<{
  name: string; members: Member[];
} | null> {
  const result = await database().execute({
    sql: `SELECT c.name, a.id, a.email, m.role FROM collections c
          JOIN memberships m ON m.collection_id=c.id JOIN accounts a ON a.id=m.account_id
          WHERE c.id=? AND EXISTS (SELECT 1 FROM memberships actor
          WHERE actor.collection_id=c.id AND actor.account_id=? AND actor.role='administrator')
          ORDER BY m.role, a.email, a.id`,
    args: [collectionId, accountId],
  });
  if (!result.rows.length) return null;
  return {
    name: String(result.rows[0].name),
    members: result.rows.map(row => ({ id: String(row.id), email: String(row.email), role: String(row.role) as Role })),
  };
}

export async function changeMembership(actorId: string, collectionId: string, memberId: string, action: MembershipAction): Promise<ChangeResult> {
  // A write transaction serializes both the current-actor check and the last-admin
  // check with promotion/demotion/removal, including competing administrators.
  return writeTransaction(async tx => {
    const actor = await tx.execute({
      sql: "SELECT 1 FROM memberships WHERE collection_id=? AND account_id=? AND role='administrator'",
      args: [collectionId, actorId],
    });
    if (!actor.rows.length) return "forbidden";
    const target = (await tx.execute({
      sql: `SELECT m.role, a.email FROM memberships m JOIN accounts a ON a.id=m.account_id
            WHERE m.collection_id=? AND m.account_id=?`, args: [collectionId, memberId],
    })).rows[0];
    if (!target) return "missing";
    if ((action === "promote" && target.role === "administrator") || (action === "demote" && target.role === "member")) return "unchanged";
    if (target.role === "administrator" && action !== "promote") {
      // Administrators need an account/membership, not founder approval or an
      // unexpired session: membership itself permits future email-code sign-in.
      const other = await tx.execute({
        sql: `SELECT 1 FROM memberships m JOIN accounts a ON a.id=m.account_id
              WHERE m.collection_id=? AND m.role='administrator' AND m.account_id<>? LIMIT 1`,
        args: [collectionId, memberId],
      });
      if (!other.rows.length) return "last-administrator";
    }
    if (action === "remove") {
      // Invalidate any still-pending way back into THIS collection. Consumed
      // invitations remain for history, but cannot rejoin a removed membership.
      await tx.execute({ sql: "DELETE FROM invitations WHERE collection_id=? AND email=? AND accepted_at IS NULL", args: [collectionId, target.email] });
      await tx.execute({ sql: "DELETE FROM memberships WHERE collection_id=? AND account_id=?", args: [collectionId, memberId] });
      // Never delete accounts, sessions, founder approval, or contributions:
      // attribution and access to other family collections must survive.
    } else {
      await tx.execute({
        sql: "UPDATE memberships SET role=? WHERE collection_id=? AND account_id=?",
        args: [action === "promote" ? "administrator" : "member", collectionId, memberId],
      });
    }
    return "changed";
  });
}
