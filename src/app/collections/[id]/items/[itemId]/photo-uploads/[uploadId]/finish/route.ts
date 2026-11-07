import { currentAccount } from "@/server/auth";
import { formPost } from "@/server/http";
import { finishPhotoDraft, PhotoDraftError } from "@/server/photo-drafts";

export const runtime = "nodejs";
export const maxDuration = 60;
export async function POST(request: Request, { params }: { params: Promise<{ id: string; itemId: string; uploadId: string }> }) {
  return formPost(request, async () => {
    const account = await currentAccount();
    if (!account) return Response.json({ error: "Sign in again before saving your photo." }, { status: 401 });
    const { id, itemId, uploadId } = await params;
    try {
      return Response.json(await finishPhotoDraft(account.id, id, uploadId, itemId), { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      if (error instanceof PhotoDraftError) return Response.json({ error: error.message }, { status: error.status });
      throw error;
    }
  });
}
