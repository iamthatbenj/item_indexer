import { currentAccount } from "@/server/auth";
import { normalizeEmail } from "@/server/database";
import { formPost, go } from "@/server/http";
import { inviteMember } from "@/server/invitations";

export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return formPost(request, async form => {
    const account = await currentAccount();
    if (!account) return go("/sign-in");
    const { id } = await params;
    const email = normalizeEmail(form.get("email"));
    if (!email) return go(`/collections/${encodeURIComponent(id)}?invite=email`);
    const result = await inviteMember(account, id, email);
    // Uniformly deny members, unrelated accounts, and nonexistent collections.
    if (result === "forbidden") return new Response("Invitation permission is required.", { status: 403 });
    return go(`/collections/${encodeURIComponent(id)}?invite=${result}`);
  });
}
