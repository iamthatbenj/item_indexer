import { cookies } from "next/headers";
import { redeemCode, sessionCookie } from "@/server/auth";
import { normalizeEmail } from "@/server/database";
import { formPost, go } from "@/server/http";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return formPost(request, async form => {
    const email = normalizeEmail(form.get("email"));
    const code = form.get("code") || "";
    const trusted = form.get("trusted") === "yes";
    if (!email || !/^\d{6}$/.test(code)) return go("/sign-in?error=code");
    const session = await redeemCode(email, code, trusted);
    if (!session) return go(`/sign-in?error=code&email=${encodeURIComponent(email)}`);
    (await cookies()).set(sessionCookie(), session.token, {
      httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/",
      ...(trusted ? { expires: new Date(session.expiresAt) } : {}),
    });
    return go("/");
  });
}
