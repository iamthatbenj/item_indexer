import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { currentAccount } from "@/server/auth";
import { listPeople } from "@/server/people";

export default async function People({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ q?: string }> }) {
  const account = await currentAccount(); if (!account) redirect("/sign-in");
  const { id } = await params; const query = await searchParams;
  const q = typeof query.q === "string" ? query.q.slice(0, 200) : "";
  const people = await listPeople(account.id, id, q); if (people === null) notFound();
  const path = `/collections/${id}/people`;
  return <>
    <Link href={`/collections/${id}`}>← Back to family collection</Link>
    <h1>People in this family collection</h1>
    <p className="intro">Reusable people can be current keepers without using this app. Recording a person does not invite them or grant access.</p>
    <p><Link href={`${path}/new`}>Add a person</Link></p>
    <section className="card" aria-labelledby="people-heading">
      <h2 id="people-heading">Find a person</h2>
      <form method="get" action={path}>
        <label htmlFor="person-search">Search names and identifying notes</label>
        <input id="person-search" name="q" defaultValue={q} maxLength={200} />
        <button type="submit">Search people</button>
      </form>
      {people.length === 0 ? <p>{q ? "No matching people in this collection." : "No people recorded yet."}</p> : <ul className="collection-list people-list">{people.map(person => <li key={person.id}>
        <Link href={`${path}/${person.id}`}>{person.name}</Link>
        <p className="hint">{person.note || "No identifying note"}</p>
      </li>)}</ul>}
    </section>
  </>;
}
