import { cookies } from "next/headers";
import { signOut } from "@/server/auth";
import { formPost, go } from "@/server/http";
import { expiredSessionCookie } from "@/server/session-cookie";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return formPost(request, async () => {
    await signOut();
    (await cookies()).set(expiredSessionCookie());
    return go("/sign-in?out=1");
  });
}
