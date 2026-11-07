import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { currentAccount } from "@/server/auth";
import { getItem } from "@/server/items";
import ItemEditor from "./item-editor";

export default async function Item({ params, searchParams }: { params: Promise<{ id: string; itemId: string }>; searchParams: Promise<{ saved?: string }> }) {
  const account = await currentAccount();
  if (!account) redirect("/sign-in");
  const { id, itemId } = await params;
  const item = await getItem(account.id, id, itemId);
  if (!item) notFound();
  const query = await searchParams;
  const path = `/collections/${id}/items/${itemId}`;
  return <>
    <Link href={`/collections/${id}`}>← Back to family collection</Link>
    <p className="eyebrow">{item.status === "complete" ? "Complete item" : "Draft item"}</p>
    <h1>{item.name || "Untitled belonging"}</h1>
    <p role="status" className="notice">{query.saved === "1" ? "Item details saved. " : ""}{item.status === "complete" ? "Complete with a photo, name, and short description. Visible to this collection’s members." : "Saved with one photo. This draft is visible to this collection’s members."}</p>
    {item.description && <p className="item-description">{item.description}</p>}
    <img className="item-photo" src={`${path}/photo`} width={item.width} height={item.height} alt={`Retained photo of ${item.name || "this belonging"}`} />
    <p><a href={`${path}/photo`}>Open retained photo at full size</a></p>
    <ItemEditor key={item.id} path={path} initial={{ name: item.name, description: item.description, version: item.version }} />
  </>;
}
