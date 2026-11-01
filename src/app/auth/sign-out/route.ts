import { cookies } from "next/headers";
import { sessionCookie, signOut } from "@/server/auth";
import { formPost, go } from "@/server/http";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return formPost(request, async () => {
    await signOut();
    (await cookies()).delete(sessionCookie());
    return go("/sign-in?out=1");
  });
}
