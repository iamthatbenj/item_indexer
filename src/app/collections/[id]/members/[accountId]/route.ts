import { currentAccount } from "@/server/auth";
import { formPost, go } from "@/server/http";
import { changeMembership } from "@/server/memberships";

export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ id: string; accountId: string }> }) {
  return formPost(request, async form => {
    const account = await currentAccount();
    if (!account) return go("/sign-in");
    const action = form.get("action");
    if (action !== "promote" && action !== "demote" && action !== "remove") return new Response("Choose a valid membership action.", { status: 400 });
    if (action === "remove" && form.get("confirm") !== "yes") return new Response("Confirm that removing access does not remove contributions or recall copies.", { status: 400 });
    const { id, accountId } = await params;
    const result = await changeMembership(account.id, id, accountId, action);
    if (result === "forbidden") return new Response("Administrator permission is required.", { status: 403 });
    if (result === "missing") return new Response("This membership is unavailable.", { status: 404 });
    if (result === "last-administrator") return go(`/collections/${encodeURIComponent(id)}/members?change=last-administrator`);
    if (account.id === accountId && action === "remove") return go("/?membership=removed");
    if (account.id === accountId && action === "demote") return go(`/collections/${encodeURIComponent(id)}?membership=demoted`);
    return go(`/collections/${encodeURIComponent(id)}/members?change=${result}`);
  });
}
