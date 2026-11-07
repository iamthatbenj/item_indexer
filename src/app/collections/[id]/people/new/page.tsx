import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { currentAccount } from "@/server/auth";
import { getCollection } from "@/server/collections";
import PersonEditor from "../person-editor";

export default async function NewPerson({ params }: { params: Promise<{ id: string }> }) {
  const account = await currentAccount(); if (!account) redirect("/sign-in");
  const { id } = await params;
  if (!await getCollection(account.id, id)) notFound();
  const path = `/collections/${id}/people`;
  return <><Link href={path}>← Back to people</Link><h1>Record a person</h1><PersonEditor path={path} /></>;
}
