import { requestCode } from "@/server/auth";
import { normalizeEmail } from "@/server/database";
import { formPost, go } from "@/server/http";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return formPost(request, async form => {
    const email = normalizeEmail(form.get("email"));
    if (!email) return go("/sign-in?error=email");
    await requestCode(email);
    return go(`/sign-in?sent=1&email=${encodeURIComponent(email)}`);
  });
}
