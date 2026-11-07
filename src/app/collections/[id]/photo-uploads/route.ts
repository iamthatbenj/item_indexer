import { currentAccount } from "@/server/auth";
import { formPost } from "@/server/http";
import { beginPhotoDraft, PhotoDraftError } from "@/server/photo-drafts";

export const runtime = "nodejs";
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return formPost(request, async form => {
    const account = await currentAccount();
    if (!account) return Response.json({ error: "Sign in again before saving your photo." }, { status: 401 });
    const { id } = await params;
    try {
      return Response.json(await beginPhotoDraft(account.id, id, form.get("id") ?? "", Number(form.get("size"))), { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      if (error instanceof PhotoDraftError) return Response.json({ error: error.message }, { status: error.status });
      throw error;
    }
  });
}
