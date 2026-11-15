import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { currentAccount } from "@/server/auth";
import { itemHistory, recoveryVersion } from "@/server/edit-history";
import { listPeople } from "@/server/people";
import HistoryCredit from "@/app/components/history-credit";
import ItemEditor from "../item-editor";

export default async function ItemHistory({ params, searchParams }: {
  params: Promise<{ id: string; itemId: string }>;
  searchParams: Promise<{ recover?: string | string[] }>;
}) {
  const account = await currentAccount();
  if (!account) redirect("/sign-in");
  const { id, itemId } = await params;
  const history = await itemHistory(account.id, id, itemId);
  const current = history.at(-1);
  if (!current) notFound();
  const selectedVersion = recoveryVersion((await searchParams).recover);
  const selected = selectedVersion === null ? null : history.find(entry => entry.version === selectedVersion && entry.version < current.version);
  if (selectedVersion !== null && !selected) notFound();
  const people = selected ? await listPeople(account.id, id) : null;
  if (selected && people === null) notFound();
  const path = `/collections/${id}/items/${itemId}`;
  return <>
    <Link href={path} target="_blank" rel="noopener">Open current item in a new tab</Link>
    <h1>Item edit history</h1>
    <p>Oldest to newest. Item details and keeper assignments are retained; this is not photo history. Keeper labels below use the identifying version retained with each assignment. Editing rights are equal for every member, including recovery.</p>
    {selected && <section aria-labelledby="recovery-heading">
      <h2 id="recovery-heading">Recover item version {selected.version} as a new edit</h2>
      <p className="notice">Review the earlier fields below, then use Save item details deliberately. Saving checks current version {current.version}; it does not erase later history or restore photos, access, or removed records. Current keeper choices use today's names. A changed assignment records today's identifying version.</p>
      <ItemEditor key={`${account.id}:${itemId}:${selected.version}`} scope={{ accountId: account.id, collectionId: id, itemId }} path={path} peoplePath={`/collections/${id}/people`} people={people!} initial={{ name: selected.name, description: selected.description, currentKeeperId: selected.currentKeeperId, version: current.version }} />
    </section>}
    <section aria-label="Item versions">
      {history.map(entry => <article key={entry.version} className="card edit-history" aria-label={`Item version ${entry.version}`}>
        <HistoryCredit {...entry} current={entry.version === current.version} />
        <h3>Name</h3><p className="story-text">{entry.name || "Not recorded"}</p>
        <h3>Short description</h3><p className="story-text">{entry.description || "Not recorded"}</p>
        <p>State: {entry.status}. Current keeper: {entry.keeperLabel}.</p>
        {entry.version < current.version && <Link href={`${path}/history?recover=${entry.version}`} target="_blank" rel="noopener">Review recovery of item version {entry.version} in a new tab</Link>}
      </article>)}
    </section>
    <p className="hint">Opening history or a recovery form writes nothing. Recovery uses the ordinary editor and conflict comparison. Saving unchanged current content creates no extra version. Keep forms open or copy unsaved text before closing/reloading.</p>
  </>;
}
