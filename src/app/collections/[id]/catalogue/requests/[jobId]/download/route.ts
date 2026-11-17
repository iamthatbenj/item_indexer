import { currentAccount } from "@/server/auth";
import { catalogueDownload, CatalogueError } from "@/server/catalogue-exports";

export const runtime = "nodejs";
export async function GET(_request: Request, context: { params: Promise<{ id: string; jobId: string }> }) {
  const headers = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" };
  try {
    const account = await currentAccount();
    if (!account) return Response.json({ error: "Sign in again before downloading an catalogue." }, { status: 401, headers });
    const { id, jobId } = await context.params;
    const location = await catalogueDownload(account.id, id, jobId);
    return new Response(null, { status: 302, headers: { ...headers, Location: location } });
  } catch (error) {
    return Response.json({ error: error instanceof CatalogueError ? error.message : "The complete private PDF could not be verified. Check generation status and storage availability." }, { status: error instanceof CatalogueError ? error.status : 503, headers });
  }
}
