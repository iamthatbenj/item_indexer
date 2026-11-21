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
    <p>Preview a Family Belongings format 1.0, 1.1, or 1.2 archive. A check alone creates no collection and does not prove the archive’s origin. Only explicit confirmation restores a new private collection.</p>
    <Preflight key={account.id} accountId={account.id} />
  </>;
}
