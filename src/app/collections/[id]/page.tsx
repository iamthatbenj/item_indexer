import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { currentAccount } from "@/server/auth";
import { getCollection, listCollections } from "@/server/collections";
import { listPhotoDrafts } from "@/server/photo-drafts";
import PhotoCapture from "./photo-capture";

export default async function Collection({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ invite?: string; membership?: string }> }) {
  const account = await currentAccount();
  if (!account) redirect("/sign-in");
  const { id } = await params;
  const collection = await getCollection(account.id, id);
  if (!collection) notFound();
  const collections = await listCollections(account.id);
  const drafts = await listPhotoDrafts(account.id, id);
  const query = await searchParams;
  const messages: Record<string, string> = {
    sent: "Invitation sent. It expires in seven days. The recipient must sign in with the invited email.",
    member: "That email is already a member of this collection. Their role is unchanged.",
    email: "Enter a valid email address.",
    limited: "Invitation limit reached. Wait at least 15 minutes before trying again.",
    failed: "The invitation email could not be sent. Please try again later.",
  };
  return <>
    <div className="account"><Link href="/">← Your collections</Link><form action="/auth/sign-out" method="post"><button className="secondary">Sign out</button></form></div>
    <p className="eyebrow">Private family collection</p>
    <h1>{collection.name}</h1>
    <p className="intro">A place for the belongings, memories, and people that matter to your family.</p>
    {query.membership === "demoted" && <p role="status" className="notice">You are now a family member. Another administrator manages invitations and access; your editing rights are unchanged.</p>}
    <section className="card">
      <h2>Your collection is ready</h2>
      <p>You are a family {collection.role}. Only this collection’s members can see its record.</p>
      <p>All members have equal editing permissions. Administrators manage invitations and access, not editorial authority.</p>
    </section>
    <PhotoCapture collectionId={id} />
    <section className="card" aria-labelledby="belongings-heading">
      <h2 id="belongings-heading">Belongings</h2>
      {drafts.length === 0 ? <p>No saved belongings yet. Start with one photo.</p> : <ul className="draft-grid">{drafts.map(draft => <li key={draft.id}>
        <Link href={`/collections/${id}/items/${draft.id}`}>
          <img src={`/collections/${id}/items/${draft.id}/photo?size=thumbnail`} alt="Photo of an untitled belonging" loading="lazy" width={240} height={240} />
          <span>Untitled belonging — Draft item</span>
        </Link>
      </li>)}</ul>}
    </section>
    <nav className="card" aria-label="Switch family collection">
      <h2>Switch family collection</h2>
      <ul className="collection-list">{collections.map(item => <li key={item.id}><Link href={`/collections/${item.id}`} aria-current={item.id === id ? "page" : undefined}>{item.name}{item.id === id ? " (current)" : ""}</Link></li>)}</ul>
    </nav>
    {collection.role === "administrator" && <section className="card" aria-labelledby="invite-heading">
      <h2 id="invite-heading">Invite a family member</h2>
      <p><Link href={`/collections/${id}/members`}>Manage family members and administrators</Link></p>
      <p>Invitations expire after seven days. Sending again replaces the previous link. Only the invited email can accept; a forwarded link does not grant access.</p>
      {query.invite && Object.hasOwn(messages, query.invite) && <p role={query.invite === "sent" || query.invite === "member" ? "status" : "alert"} className="notice">{messages[query.invite]}</p>}
      <form action={`/collections/${id}/invitations`} method="post">
        <label htmlFor="invite-email">Relative’s email address</label>
        <input id="invite-email" name="email" type="email" autoComplete="email" maxLength={254} required />
        <button type="submit">Send invitation</button>
      </form>
    </section>}
  </>;
}
