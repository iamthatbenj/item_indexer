import { currentAccount } from "@/server/auth";
import { formPost } from "@/server/http";
import { editPerson, PersonEditError } from "@/server/people";

export async function POST(request: Request, { params }: { params: Promise<{ id: string; personId: string }> }) {
  return formPost(request, async form => {
    const headers = { "Cache-Control": "private, no-store" };
    const account = await currentAccount();
    if (!account) return Response.json({ error: "Sign in again before saving. Keep this page open to copy your details." }, { status: 401, headers });
    const { id, personId } = await params;
    try {
      for (const field of ["version", "name", "note"]) if (form.getAll(field).length !== 1) throw new PersonEditError("Submit one editing version, name, and identifying note.");
      await editPerson(account.id, id, personId, form.get("version")!, form.get("name")!, form.get("note")!);
      return Response.json({ saved: true }, { headers });
    } catch (error) {
      if (error instanceof PersonEditError) return Response.json({ error: error.message }, { status: error.status, headers });
      throw error;
    }
  }, 16 * 1024);
}
