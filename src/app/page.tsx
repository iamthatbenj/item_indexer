import Link from "next/link";
import { redirect } from "next/navigation";
import { currentAccount } from "@/server/auth";
import { listCollections } from "@/server/collections";
import { listInvitations } from "@/server/invitations";

export default async function Home({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const account = await currentAccount();
  if (!account) redirect("/sign-in");
  const collections = await listCollections(account.id);
  const invitations = await listInvitations(account.email);
  const query = await searchParams;
  return <>
    <div className="account"><p>Signed in as <strong>{account.email}</strong></p><form action="/auth/sign-out" method="post"><button className="secondary">Sign out</button></form></div>
    <p className="eyebrow">Your family record</p><h1>Family collections</h1>
    <p className="intro">Each collection is private to its own family members.</p>
    {invitations.length > 0 && <section className="card" aria-labelledby="invitations-heading">
      <h2 id="invitations-heading">Your invitations</h2>
      <ul className="collection-list">{invitations.map(invitation => <li key={invitation.id}><Link href={`/invitations/${invitation.id}`}>Review invitation to {invitation.name}</Link></li>)}</ul>
      <p>Review the joining terms before becoming a member. An invitation alone does not grant access to collection records.</p>
    </section>}
    <section className="card" aria-labelledby="collections-heading">
      <h2 id="collections-heading">Your collections</h2>
      {collections.length ? <ul className="collection-list">{collections.map(collection => <li key={collection.id}><Link href={`/collections/${collection.id}`}>{collection.name}<span aria-hidden="true"> →</span></Link></li>)}</ul> : <p>You have not joined a collection yet. Accept an invitation above, or ask a family administrator to invite your email address.</p>}
    </section>
    {account.founder ? <section className="card" aria-labelledby="create-heading">
      <h2 id="create-heading">Create a family collection</h2>
      <p>As an approved founder, you will be its first family administrator. A collection is not tied to a location.</p>
      {query.error && <p role="alert" className="notice error">Give your collection a name between 1 and 120 characters.</p>}
      <form action="/collections" method="post">
        <label htmlFor="name">Collection name</label>
        <input id="name" name="name" required maxLength={120} placeholder="For example, The Morgan family" />
        <button type="submit">Create collection</button>
      </form>
    </section> : <p className="notice">Founder approval is required to create a new collection. You can still join invitations and access your existing family collections.</p>}
  </>;
}
