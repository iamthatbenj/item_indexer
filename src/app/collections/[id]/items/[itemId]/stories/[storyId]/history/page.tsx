import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { currentAccount } from "@/server/auth";
import { storyHistory, recoveryVersion } from "@/server/edit-history";
import HistoryCredit from "@/app/components/history-credit";
import StoryEditor from "../story-editor";

export default async function StoryHistory({ params, searchParams }: {
  params: Promise<{ id: string; itemId: string; storyId: string }>;
  searchParams: Promise<{ recover?: string | string[] }>;
}) {
  const account = await currentAccount();
  if (!account) redirect("/sign-in");
  const { id, itemId, storyId } = await params;
  const history = await storyHistory(account.id, id, itemId, storyId);
  const current = history.at(-1);
  if (!current) notFound();
  const selectedVersion = recoveryVersion((await searchParams).recover);
  const selected = selectedVersion === null ? null : history.find(entry => entry.version === selectedVersion && entry.version < current.version);
  if (selectedVersion !== null && !selected) notFound();
  const path = `/collections/${id}/items/${itemId}/stories/${storyId}`;
  return <>
    <Link href={path} target="_blank" rel="noopener">Open current story in a new tab</Link>
    <h1>Story edit history</h1>
    <p>Oldest to newest. Storyteller labels use the identifying version retained when the story was recorded, not today's name. Storyteller, original recorder and editing member are separate credits. Departed members remain credited.</p>
    {selected && <section aria-labelledby="recovery-heading">
      <h2 id="recovery-heading">Recover story version {selected.version} as a new edit</h2>
      <p className="notice">Review the earlier text below, then use Save story changes deliberately. Saving checks current version {current.version}, keeps storyteller and recording credit unchanged, and retains later history. It cannot restore removed records or collection access.</p>
      <StoryEditor key={`${account.id}:${storyId}:${selected.version}`} scope={{ accountId: account.id, collectionId: id, itemId }} storyId={storyId} path={path} initial={{ text: selected.text, version: current.version }} />
    </section>}
    <section aria-label="Story versions">
      {history.map(entry => <article key={entry.version} className="card edit-history" aria-label={`Story version ${entry.version}`}>
        <HistoryCredit {...entry} current={entry.version === current.version} />
        <p>Storyteller: {entry.storytellerLabel}.</p>
        <p>Originally recorded by {entry.recorderEmail} on <time dateTime={new Date(entry.recordedAt).toISOString()}>{new Date(entry.recordedAt).toISOString()}</time>.</p>
        <p className="story-text">{entry.text}</p>
        {entry.version < current.version && <Link href={`${path}/history?recover=${entry.version}`} target="_blank" rel="noopener">Review recovery of story version {entry.version} in a new tab</Link>}
      </article>)}
    </section>
    <p className="hint">Opening history or a recovery form writes nothing. Recovery uses the ordinary editor and conflict comparison. Saving unchanged current content creates no extra version. Keep forms open or copy unsaved text before closing/reloading.</p>
  </>;
}
