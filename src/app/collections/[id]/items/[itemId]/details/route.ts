import { currentAccount } from "@/server/auth";
import { formPost } from "@/server/http";
import { editItem, ItemEditError } from "@/server/items";

export async function POST(request: Request, { params }: { params: Promise<{ id: string; itemId: string }> }) {
  return formPost(request, async form => {
    const account = await currentAccount();
    if (!account) return Response.json({ error: "Sign in again before saving. Keep this page open to copy your text." }, { status: 401 });
    const { id, itemId } = await params;
    try {
      // Never accept a client-declared status, photo, revision, or editor identity.
      for (const field of ["version", "name", "description"]) {
        if (form.getAll(field).length !== 1) throw new ItemEditError("Submit one editing version, name, and description.");
      }
      if (form.getAll("currentKeeper").length > 1) throw new ItemEditError("Submit at most one current keeper.");
      await editItem(account.id, id, itemId, form.get("version")!, form.get("name")!, form.get("description")!, form.has("currentKeeper") ? form.get("currentKeeper")! : undefined);
      return Response.json({ saved: true }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      if (error instanceof ItemEditError) return Response.json({ error: error.message }, { status: error.status, headers: { "Cache-Control": "no-store" } });
      throw error;
    }
  }, 16 * 1024);
}
