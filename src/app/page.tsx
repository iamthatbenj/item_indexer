import Link from "next/link";
import { redirect } from "next/navigation";
import { currentAccount } from "@/server/auth";
import { listCollections } from "@/server/collections";

export default async function Home({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const account = await currentAccount();
  if (!account) redirect("/sign-in");
  const collections = await listCollections(account.id);
  const query = await searchParams;
  return <>
    <div className="account"><p>Signed in as <strong>{account.email}</strong></p><form action="/auth/sign-out" method="post"><button className="secondary">Sign out</button></form></div>
    <p className="eyebrow">Your family record</p><h1>Family collections</h1>
    <p className="intro">Each collection is private to its own family members.</p>
    <section className="card" aria-labelledby="collections-heading">
      <h2 id="collections-heading">Your collections</h2>
      {collections.length ? <ul className="collection-list">{collections.map(collection => <li key={collection.id}><Link href={`/collections/${collection.id}`}>{collection.name}<span aria-hidden="true"> →</span></Link></li>)}</ul> : <p>You do not have a collection yet. Start a place for your family’s stories below.</p>}
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
    </section> : <p className="notice">Founder approval is required to create a new collection. Your existing collection membership is unchanged.</p>}
  </>;
}
