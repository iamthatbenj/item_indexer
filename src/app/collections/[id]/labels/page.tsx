import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { currentAccount } from "@/server/auth";
import { getCollection } from "@/server/collections";
import { listItemLabels } from "@/server/item-labels";
import ManageLabels from "./manage-labels";

export default async function LabelsPage({ params }: { params: Promise<{ id: string }> }) {
  const account = await currentAccount();
  if (!account) redirect("/sign-in");
  const { id } = await params;
  const collection = await getCollection(account.id, id);
  if (!collection) notFound();
  const choices = await listItemLabels(account.id, id);
  return <>
    <Link href={`/collections/${id}`}>← {collection.name}</Link>
    <h1>Manage categories and locations</h1>
    <p>Any family member can rename a shared label or merge duplicates. Neither action changes access to belongings.</p>
    <ManageLabels key={`${account.id}:${id}`} accountId={account.id} endpoint={`/collections/${id}/labels/operations`} choices={choices} />
  </>;
}
