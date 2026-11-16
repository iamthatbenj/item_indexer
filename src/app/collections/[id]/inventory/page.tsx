import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { currentAccount } from "@/server/auth";
import { getCollection } from "@/server/collections";
import { inventoryList } from "@/server/inventory-exports";
import Inventory from "./inventory";

export default async function InventoryPage({ params }: { params: Promise<{ id: string }> }) {
  const account = await currentAccount();
  if (!account) redirect("/sign-in");
  const { id } = await params;
  const collection = await getCollection(account.id, id);
  if (!collection) notFound();
  const jobs = await inventoryList(account.id, id);
  return <>
    <Link href={`/collections/${id}`}>← Back to collection</Link>
    <h1>Inventory PDF — {collection.name}</h1>
    <p>A compact printable snapshot of saved current items: names or draft placeholders, short descriptions and one retained thumbnail per item. Unsaved local text, stories, financial details and edit history are not included.</p>
    <Inventory key={`${account.id}:${id}`} accountId={account.id} collectionId={id} initialJobs={jobs} />
  </>;
}
