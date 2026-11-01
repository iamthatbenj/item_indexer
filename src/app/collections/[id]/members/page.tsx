import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { currentAccount } from "@/server/auth";
import { getMembershipManagement } from "@/server/memberships";

const messages: Record<string, string> = {
  changed: "Membership updated.",
  unchanged: "That family member already has the requested role. No change was needed.",
  "last-administrator": "Keep at least one family administrator. Promote another current member before removing or demoting the final administrator.",
};

export default async function Members({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ change?: string | string[] }>;
}) {
  const account = await currentAccount();
  if (!account) redirect("/sign-in");
  const { id } = await params;
  const management = await getMembershipManagement(account.id, id);
  if (!management) notFound();
  const { change } = await searchParams;
  const message = typeof change === "string" && Object.hasOwn(messages, change) ? messages[change] : null;
  return <>
    <div className="account"><Link href={`/collections/${id}`}>← Back to family collection</Link><form action="/auth/sign-out" method="post"><button className="secondary">Sign out</button></form></div>
    <p className="eyebrow">{management.name}</p>
    <h1>Manage family members</h1>
    <p>Administrators manage invitations and access, not editorial authority. Every family member has equal permission to edit the shared record.</p>
    <div className="notice" id="access-consequences">
      <p>Removing access preserves contributions and historical attribution. It does not delete an account or affect membership in other family collections.</p>
      <p>Existing sessions lose permission for new requests to this collection. Previously downloaded or displayed records cannot be recalled. Any already issued file links may work until their bounded expiry; prior downloads and exported copies cannot be revoked.</p>
      <p className="hint">Photo and export tools are not implemented yet. Those tools must check current membership before issuing new access.</p>
    </div>
    <p>Keep at least one administrator who can still sign in. You can change your own role or remove your own access only while another administrator remains.</p>
    {message && <p role={change === "last-administrator" ? "alert" : "status"} className={`notice${change === "last-administrator" ? " error" : ""}`}>{message}</p>}
    <ul className="member-list">{management.members.map(member => <li key={member.id} className="card">
      <h2 className="member-email">{member.email}{member.id === account.id ? " (you)" : ""}</h2>
      <p>Family {member.role}</p>
      <div className="member-actions">
        <form action={`/collections/${id}/members/${member.id}`} method="post" aria-label={`Change role for ${member.email}`}>
          <input type="hidden" name="action" value={member.role === "administrator" ? "demote" : "promote"} />
          <button type="submit">{member.role === "administrator" ? "Make family member" : "Make administrator"}</button>
        </form>
        <form action={`/collections/${id}/members/${member.id}`} method="post" aria-label={`Remove access for ${member.email}`} aria-describedby="access-consequences">
          <input type="hidden" name="action" value="remove" />
          <label className="check"><input type="checkbox" name="confirm" value="yes" required /> I understand that removing access for {member.email} keeps their contributions and cannot recall copies.</label>
          <button type="submit" className="danger">Remove access</button>
        </form>
      </div>
    </li>)}</ul>
  </>;
}
