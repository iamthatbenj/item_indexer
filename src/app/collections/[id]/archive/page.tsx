import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { currentAccount } from "@/server/auth";
import { getCollection } from "@/server/collections";
import { archiveList } from "@/server/archive-exports";
import ArchiveRequests from "./archive";

export default async function ArchivePage({ params }: { params: Promise<{ id: string }> }) {
  const account = await currentAccount(); if (!account) redirect("/sign-in");
  const { id } = await params; const collection = await getCollection(account.id, id); if (!collection) notFound();
  const jobs = await archiveList(account.id, id);
  return <>
    <Link href={`/collections/${id}`}>← Back to collection</Link>
    <h1>Portable family archive — {collection.name}</h1>
    <p>A versioned ZIP of saved item/person/story data, separate storyteller/recorder/editor credit, supported edit history, and unchanged retained high-quality photos with thumbnails. These are retained optimized photos, not necessarily camera originals. Removed photos retain removal metadata, not deleted files.</p>
    <p>Contribution identities preserve credit, not account access or permissions. No membership grants, invitations, sessions, provider secrets, local unsaved drafts or generated PDFs are included. Restoration, merging, transfers and scheduled backups are separate work. Keep your downloaded archive private.</p>
    <ArchiveRequests key={`${account.id}:${id}:archive`} accountId={account.id} collectionId={id} initialJobs={jobs} />
  </>;
}
