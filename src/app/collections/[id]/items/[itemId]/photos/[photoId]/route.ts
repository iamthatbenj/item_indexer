import { currentAccount } from "@/server/auth";
import { formPost } from "@/server/http";
import { photoDownload, removeItemPhoto, PhotoDraftError } from "@/server/photo-drafts";

export const runtime = "nodejs";
type Context = { params: Promise<{ id: string; itemId: string; photoId: string }> };
const headers = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" };
export async function GET(request: Request, { params }: Context) {
  try {
    const account = await currentAccount();
    if (!account) return new Response("Sign in to view this photo.", { status: 401, headers });
    const { id, itemId, photoId } = await params;
    const url = await photoDownload(account.id, id, itemId, new URL(request.url).searchParams.get("size") === "thumbnail", photoId);
    return url ? new Response(null, { status: 307, headers: { ...headers, Location: url } }) : new Response("Photo unavailable.", { status: 404, headers });
  } catch {
    console.error("Private photo authorization failed. Check service availability.");
    return new Response("Photo temporarily unavailable. Please retry.", { status: 503, headers });
  }
}
export async function POST(request: Request, { params }: Context) {
  return formPost(request, async form => {
    const account = await currentAccount();
    if (!account) return Response.json({ error: "Sign in again before removing a photo." }, { status: 401 });
    if (form.getAll("confirm").length !== 1 || form.get("confirm") !== "yes") return Response.json({ error: "Confirm removal of this view." }, { status: 400 });
    const { id, itemId, photoId } = await params;
    try {
      await removeItemPhoto(account.id, id, itemId, photoId);
      return Response.json({ removed: true }, { headers });
    } catch (error) {
      if (error instanceof PhotoDraftError) return Response.json({ error: error.message }, { status: error.status, headers });
      throw error;
    }
  });
}
