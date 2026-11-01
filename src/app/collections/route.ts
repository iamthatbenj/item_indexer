import { currentAccount } from "@/server/auth";
import { createCollection } from "@/server/collections";
import { formPost, go } from "@/server/http";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return formPost(request, async form => {
    const account = await currentAccount();
    if (!account) return go("/sign-in");
    const name = (form.get("name") || "").trim();
    if (!name || name.length > 120) return go("/?error=name");
    const id = await createCollection(account, name);
    if (!id) return new Response("Founder approval is required to create a collection.", { status: 403 });
    return go(`/collections/${id}`);
  });
}
