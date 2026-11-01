import Link from "next/link";
import { redirect } from "next/navigation";
import { currentAccount } from "@/server/auth";
import { getInvitation } from "@/server/invitations";

export default async function Invitation({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const account = await currentAccount();
  // No collection name or invited email is disclosed before authentication.
  if (!account) redirect("/sign-in");
  const { id } = await params;
  const invitation = await getInvitation(account, id);
  const query = await searchParams;
  return <>
    <div className="account"><Link href="/">← Your collections</Link><form action="/auth/sign-out" method="post"><button className="secondary">Sign out</button></form></div>
    {!invitation ? <section className="card">
      <h1>Invitation unavailable</h1>
      <p>This invitation cannot be used by this account. It may have expired or been replaced. Sign in with the invited email, or ask the family administrator for a new invitation.</p>
    </section> : invitation.accepted ? <section className="card">
      <h1>Already joined</h1><p>You have already accepted this invitation.</p>
      <Link href={`/collections/${invitation.collectionId}`}>Open {invitation.name}</Link>
    </section> : <section className="card">
      <p className="eyebrow">Private family invitation</p><h1>Join {invitation.name}</h1>
      <p>Signed in as <strong>{account.email}</strong>. This invitation expires {new Date(invitation.expiresAt).toISOString().slice(0, 10)} (UTC).</p>
      <h2>Before you join</h2>
      <ul>
        <li>Every family member has equal permission to edit the shared record. Administrators manage invitations and access, not editorial authority.</li>
        <li>Your contributions remain attributed to you after you leave or lose access.</li>
        <li>Every member may export the whole collection, including financial evidence. Downloaded copies cannot be revoked.</li>
      </ul>
      <p className="hint">Item editing and export tools will arrive in later development slices.</p>
      {query.error && <p role="alert" className="notice error">Read and acknowledge the joining terms before accepting.</p>}
      <form action={`/invitations/${invitation.id}/accept`} method="post">
        <label className="check"><input type="checkbox" name="acknowledge" value="yes" required /> I understand these joining terms.</label>
        <button type="submit">Accept invitation</button>
      </form>
    </section>}
  </>;
}
