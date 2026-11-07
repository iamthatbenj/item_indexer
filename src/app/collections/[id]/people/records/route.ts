import { currentAccount } from "@/server/auth";
import { formPost } from "@/server/http";
import { createPerson, listPeople, PersonEditError } from "@/server/people";

const headers = { "Cache-Control": "private, no-store" };
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const account = await currentAccount();
  if (!account) return Response.json({ error: "Sign in to view people." }, { status: 401, headers });
  const { id } = await params;
  const people = await listPeople(account.id, id);
  return people === null ? Response.json({ error: "This collection is unavailable." }, { status: 404, headers }) : Response.json({ people }, { headers });
}
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return formPost(request, async form => {
    const account = await currentAccount();
    if (!account) return Response.json({ error: "Sign in again before saving. Keep this page open to copy your details." }, { status: 401, headers });
    const { id } = await params;
    try {
      for (const field of ["id", "name", "note"]) if (form.getAll(field).length !== 1) throw new PersonEditError("Submit one creation request, name, and identifying note.");
      await createPerson(account.id, id, form.get("id")!, form.get("name")!, form.get("note")!);
      return Response.json({ saved: true, personUrl: `/collections/${id}/people/${form.get("id")}` }, { headers });
    } catch (error) {
      if (error instanceof PersonEditError) return Response.json({ error: error.message }, { status: error.status, headers });
      throw error;
    }
  }, 16 * 1024);
}
