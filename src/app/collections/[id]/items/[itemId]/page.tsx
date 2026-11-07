import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { currentAccount } from "@/server/auth";
import { getItem } from "@/server/items";
import { listPeople } from "@/server/people";
import ItemEditor from "./item-editor";
import ItemPhotos from "./item-photos";

export default async function Item({ params, searchParams }: { params: Promise<{ id: string; itemId: string }>; searchParams: Promise<{ saved?: string }> }) {
  const account = await currentAccount();
  if (!account) redirect("/sign-in");
  const { id, itemId } = await params;
  const item = await getItem(account.id, id, itemId);
  if (!item) notFound();
  const people = await listPeople(account.id, id);
  if (people === null) notFound();
  const query = await searchParams;
  const path = `/collections/${id}/items/${itemId}`;
  return <>
    <Link href={`/collections/${id}`}>← Back to family collection</Link>
    <p className="eyebrow">{item.status === "complete" ? "Complete item" : "Draft item"}</p>
    <h1>{item.name || "Untitled belonging"}</h1>
    <p role="status" className="notice">{query.saved === "1" ? "Item details saved. " : ""}{item.status === "complete" ? "Complete with a photo, name, and short description. Visible to this collection’s members." : `Saved with ${item.photos.length === 1 ? "one photo" : `${item.photos.length} photos`}. This draft is visible to this collection’s members.`}</p>
    {item.description && <p className="item-description">{item.description}</p>}
    <p className="keeper-summary">Current keeper: {item.currentKeeper ? <><Link href={`/collections/${id}/people/${item.currentKeeper.id}`}>{item.currentKeeper.name}</Link>{item.currentKeeper.note ? ` — ${item.currentKeeper.note}` : ""}</> : "Not recorded"}. Keeping an item does not establish legal ownership.</p>
    <ItemPhotos collectionId={id} itemId={itemId} name={item.name} photos={item.photos} />
    <ItemEditor key={item.id} path={path} peoplePath={`/collections/${id}/people`} people={people} initial={{ name: item.name, description: item.description, version: item.version, currentKeeperId: item.currentKeeper?.id ?? "" }} />
  </>;
}
