import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { currentAccount } from "@/server/auth";
import { getCollection } from "@/server/collections";

export default async function Collection({ params }: { params: Promise<{ id: string }> }) {
  const account = await currentAccount();
  if (!account) redirect("/sign-in");
  const { id } = await params;
  const collection = await getCollection(account.id, id);
  if (!collection) notFound();
  return <>
    <div className="account"><Link href="/">← Your collections</Link><form action="/auth/sign-out" method="post"><button className="secondary">Sign out</button></form></div>
    <p className="eyebrow">Private family collection</p>
    <h1>{collection.name}</h1>
    <p className="intro">A place for the belongings, memories, and people that matter to your family.</p>
    <section className="card">
      <h2>Your collection is ready</h2>
      <p>You are a family {collection.role}. Only this collection’s members can see its record.</p>
      <p>Photo capture and family invitations are coming in the next development slices.</p>
    </section>
  </>;
}
