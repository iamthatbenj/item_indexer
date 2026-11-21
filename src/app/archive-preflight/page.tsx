import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { currentAccount } from "@/server/auth";
import { Preflight } from "./preflight";

export default async function ArchivePreflight() {
  const account = await currentAccount();
  if (!account) redirect("/sign-in");
  if (!account.founder) notFound();
  return <>
    <p><Link href="/">Back to family collections</Link></p>
    <h1>Check a portable archive</h1>
    <p>Preview what a Family Belongings format 1.0 archive contains. This check does not create a family collection, restore access, or prove the archive’s origin.</p>
    <Preflight key={account.id} accountId={account.id} />
  </>;
}
