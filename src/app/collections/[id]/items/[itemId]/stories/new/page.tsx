import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { currentAccount } from "@/server/auth";
import { getItem } from "@/server/items";
import { listPeople } from "@/server/people";
import StoryRecorder from "./story-recorder";

export default async function NewStory({ params }: { params: Promise<{ id: string; itemId: string }> }) {
  const account = await currentAccount();
  if (!account) redirect("/sign-in");
  const { id, itemId } = await params;
  const item = await getItem(account.id, id, itemId);
  if (!item) notFound();
  const people = await listPeople(account.id, id);
  if (people === null) notFound();
  const path = `/collections/${id}/items/${itemId}`;
  return <>
    <Link href={path}>← Back to item</Link>
    <h1>Record a story</h1>
    <p>About {item.name || "this untitled belonging"}. Credit the person whose recollection this is, even if you are entering it for them.</p>
    <StoryRecorder path={path} peoplePath={`/collections/${id}/people`} people={people} />
  </>;
}
