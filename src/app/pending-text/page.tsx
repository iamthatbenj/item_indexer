import Link from "next/link";
import { redirect } from "next/navigation";
import { currentAccount } from "@/server/auth";
import PendingText from "./pending-text";

export default async function PendingTextPage() {
  const account = await currentAccount();
  if (!account) redirect("/sign-in");
  return <>
    <Link href="/">← Back to family collections</Link>
    <h1>Locally retained pending text</h1>
    <p>These are this contributor's browser-local copies, not saved records or an archive. You can inspect/copy or discard your own pending input even if its original record or collection is unavailable. Opening an editor still requires current access and an existing target; no access or deleted content is restored here.</p>
    <PendingText key={account.id} accountId={account.id} />
  </>;
}
