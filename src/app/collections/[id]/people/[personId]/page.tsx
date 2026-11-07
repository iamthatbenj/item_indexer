import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { currentAccount } from "@/server/auth";
import { getPerson } from "@/server/people";
import PersonEditor from "../person-editor";

export default async function Person({ params, searchParams }: { params: Promise<{ id: string; personId: string }>; searchParams: Promise<{ saved?: string }> }) {
  const account = await currentAccount(); if (!account) redirect("/sign-in");
  const { id, personId } = await params;
  const person = await getPerson(account.id, id, personId); if (!person) notFound();
  const query = await searchParams;
  return <>
    <Link href={`/collections/${id}/people`}>← Back to people</Link>
    <h1 className="person-heading">{person.name}</h1>
    {person.note && <p className="item-description">{person.note}</p>}
    {query.saved === "1" && <p role="status" className="notice">Person details saved.</p>}
    <PersonEditor key={person.id} path={`/collections/${id}/people`} initial={person} />
  </>;
}
