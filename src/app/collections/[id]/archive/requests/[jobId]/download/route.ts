import { currentAccount } from "@/server/auth";
import { archiveDownload, ArchiveError } from "@/server/archive-exports";

export const runtime = "nodejs";
export async function GET(_request: Request, context: { params: Promise<{ id: string; jobId: string }> }) {
  const headers = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" };
  try {
    const account = await currentAccount();
    if (!account) return Response.json({ error: "Sign in again before downloading an archive." }, { status: 401, headers });
    const { id, jobId } = await context.params;
    const location = await archiveDownload(account.id, id, jobId);
    return new Response(null, { status: 302, headers: { ...headers, Location: location } });
  } catch (error) {
    return Response.json({ error: error instanceof ArchiveError ? error.message : "The complete private archive could not be verified. Check generation status and storage availability." }, { status: error instanceof ArchiveError ? error.status : 503, headers });
  }
}
