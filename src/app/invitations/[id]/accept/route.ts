import { currentAccount } from "@/server/auth";
import { formPost, go } from "@/server/http";
import { acceptInvitation } from "@/server/invitations";

export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return formPost(request, async form => {
    const account = await currentAccount();
    if (!account) return go("/sign-in");
    const { id } = await params;
    if (form.get("acknowledge") !== "yes") return go(`/invitations/${encodeURIComponent(id)}?error=terms`);
    const collectionId = await acceptInvitation(account, id);
    if (!collectionId) return new Response("This invitation is unavailable for this account. Ask the family administrator for a new invitation.", { status: 404 });
    return go(`/collections/${collectionId}`);
  });
}
