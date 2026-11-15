import { currentAccount } from "@/server/auth";

const headers = { "Cache-Control": "private, no-store" };
// Fresh identity only: client-side account scoping is not authorization for writes.
export async function GET() {
  try {
    const account = await currentAccount();
    return Response.json(account ? { id: account.id } : { error: "Sign in again to resume your pending photos." }, {
      status: account ? 200 : 401, headers,
    });
  } catch {
    // Do not expose driver diagnostics or an unverified identity on failure.
    return Response.json({ error: "Account check unavailable. Reconnect and sign in before resuming pending photos." }, { status: 503, headers });
  }
}
