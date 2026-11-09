import { currentAccount } from "@/server/auth";
import { formPost } from "@/server/http";
import { editStory, getStory, StoryError } from "@/server/stories";

const headers = { "Cache-Control": "private, no-store" };
type Context = { params: Promise<{ id: string; itemId: string; storyId: string }> };
export async function GET(_request: Request, { params }: Context) {
  const account = await currentAccount();
  if (!account) return Response.json({ error: "Sign in to compare the saved story." }, { status: 401, headers });
  const { id, itemId, storyId } = await params;
  const story = await getStory(account.id, id, itemId, storyId);
  if (!story) return Response.json({ error: "This story is unavailable." }, { status: 404, headers });
  return Response.json({ current: { version: story.version, fields: [{ label: "Story", value: story.text }] } }, { headers });
}
export async function POST(request: Request, { params }: Context) {
  return formPost(request, async form => {
    const account = await currentAccount();
    if (!account) return Response.json({ error: "Sign in again before saving. Keep your attempted story on this page." }, { status: 401, headers });
    const { id, itemId, storyId } = await params;
    try {
      for (const field of ["version", "text"]) if (form.getAll(field).length !== 1) throw new StoryError("Submit one editing version and story text.");
      await editStory(account.id, id, itemId, storyId, form.get("version")!, form.get("text")!);
      return Response.json({ saved: true }, { headers });
    } catch (error) {
      if (error instanceof StoryError) return Response.json({ error: error.message }, { status: error.status, headers });
      throw error;
    }
  }, 96 * 1024);
}
