import { currentAccount } from "@/server/auth";
import { formPost } from "@/server/http";
import { createStory, StoryError } from "@/server/stories";

const headers = { "Cache-Control": "private, no-store" };
export async function POST(request: Request, { params }: { params: Promise<{ id: string; itemId: string }> }) {
  return formPost(request, async form => {
    const account = await currentAccount();
    if (!account) return Response.json({ error: "Sign in again before recording. Keep this page open to copy your story." }, { status: 401, headers });
    const { id, itemId } = await params;
    try {
      for (const field of ["id", "storyteller", "text"]) if (form.getAll(field).length !== 1) throw new StoryError("Submit one recording request, storyteller, and story text.");
      await createStory(account.id, id, itemId, form.get("id")!, form.get("storyteller")!, form.get("text")!);
      return Response.json({ saved: true }, { headers });
    } catch (error) {
      if (error instanceof StoryError) return Response.json({ error: error.message }, { status: error.status, headers });
      throw error;
    }
  }, 96 * 1024);
}
