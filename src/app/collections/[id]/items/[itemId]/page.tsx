import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { currentAccount } from "@/server/auth";
import { getPhotoDraft } from "@/server/photo-drafts";

export default async function PhotoDraft({ params }: { params: Promise<{ id: string; itemId: string }> }) {
  const account = await currentAccount();
  if (!account) redirect("/sign-in");
  const { id, itemId } = await params;
  const item = await getPhotoDraft(account.id, id, itemId);
  if (!item) notFound();
  return <>
    <Link href={`/collections/${id}`}>← Back to family collection</Link>
    <p className="eyebrow">Draft item</p>
    <h1>Untitled belonging</h1>
    <p role="status" className="notice">Saved with one photo. This draft is visible to this collection’s members.</p>
    <p>Names, descriptions, and stories will be available in a later development slice.</p>
    <img className="item-photo" src={`/collections/${id}/items/${itemId}/photo`} width={item.width} height={item.height} alt="Retained photo of this belonging" />
    <p><a href={`/collections/${id}/items/${itemId}/photo`}>Open retained photo at full size</a></p>
  </>;
}
