import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { currentAccount } from "@/server/auth";
import { getStory } from "@/server/stories";
import { personLabel } from "@/shared/people";
import StoryEditor from "./story-editor";

export default async function EditStory({ params, searchParams }: { params: Promise<{ id: string; itemId: string; storyId: string }>; searchParams: Promise<{ saved?: string }> }) {
  const account = await currentAccount();
  if (!account) redirect("/sign-in");
  const { id, itemId, storyId } = await params;
  const story = await getStory(account.id, id, itemId, storyId);
  if (!story) notFound();
  const path = `/collections/${id}/items/${itemId}/stories/${storyId}`;
  return <>
    <Link href={`/collections/${id}/items/${itemId}#story-${storyId}`}>← Back to item</Link>
    <h1>Edit a story</h1>
    {(await searchParams).saved === "1" && <p role="status" className="notice">Story changes saved.</p>}
    <p className="story-attribution">Storyteller: <Link href={`/collections/${id}/people/${story.storyteller.id}`}>{personLabel(story.storyteller)}</Link>. Editing the text does not change storyteller credit.</p>
    <p className="story-attribution">Originally recorded by {story.recorderEmail}. Last edited by {story.editorEmail}.</p>
    <StoryEditor key={story.id} path={path} initial={{ text: story.text, version: story.version }} />
  </>;
}
