import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { currentAccount } from "@/server/auth";
import { getCollection } from "@/server/collections";
import { catalogueList } from "@/server/catalogue-exports";
import PDFExports from "../inventory/inventory";

export default async function CataloguePage({ params }: { params: Promise<{ id: string }> }) {
  const account = await currentAccount(); if (!account) redirect("/sign-in");
  const { id } = await params; const collection = await getCollection(account.id, id); if (!collection) notFound();
  const jobs = await catalogueList(account.id, id);
  return <>
    <Link href={`/collections/${id}`}>← Back to collection</Link>
    <h1>Illustrated family catalogue — {collection.name}</h1>
    <p>A standalone saved snapshot with a navigable index, retained photos, descriptions, current keepers and separately attributed recollections. Storytellers are distinct from the members recording or editing their words. Conflicting stories remain separate; none is presented as verified history.</p>
    <p>Local unsaved work, supporting evidence, financial details and edit-history sections are not included. Layout is suitable for pilot review, not final print approval.</p>
    <PDFExports key={`${account.id}:${id}:catalogue`} accountId={account.id} collectionId={id} initialJobs={jobs} format="catalogue" />
  </>;
}
