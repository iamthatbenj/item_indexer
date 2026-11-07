import { currentAccount } from "@/server/auth";
import { photoDownload } from "@/server/photo-drafts";

export const runtime = "nodejs";
export async function GET(request: Request, { params }: { params: Promise<{ id: string; itemId: string }> }) {
  const headers = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" };
  const account = await currentAccount();
  if (!account) return new Response("Sign in to view this photo.", { status: 401, headers });
  const { id, itemId } = await params;
  try {
    const url = await photoDownload(account.id, id, itemId, new URL(request.url).searchParams.get("size") === "thumbnail");
    if (!url) return new Response("Photo unavailable.", { status: 404, headers });
    return new Response(null, { status: 307, headers: { ...headers, Location: url } });
  } catch {
    console.error("Private photo authorization failed. Check service availability.");
    return new Response("Photo temporarily unavailable. Please retry.", { status: 503, headers });
  }
}
