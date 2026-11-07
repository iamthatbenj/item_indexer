import "server-only";

export function appOrigin(): string {
  const value = process.env.APP_ORIGIN;
  if (!value) throw new Error("APP_ORIGIN is required.");
  const url = new URL(value);
  if (url.origin !== value || (process.env.NODE_ENV === "production" && url.protocol !== "https:")) {
    throw new Error("APP_ORIGIN must be an exact origin, using HTTPS in production.");
  }
  return value;
}

export function go(path: string): Response {
  return new Response(null, { status: 303, headers: { Location: new URL(path, appOrigin()).toString(), "Cache-Control": "no-store" } });
}

// Native forms, no cross-origin write API, and bounded parsing before any auth/DB work.
export async function formPost(request: Request, work: (form: URLSearchParams) => Promise<Response>, maxBytes = 4096): Promise<Response> {
  try {
    if (request.headers.get("origin") !== appOrigin()) return new Response("Forbidden", { status: 403 });
    if (request.headers.get("content-type")?.split(";")[0] !== "application/x-www-form-urlencoded") {
      return new Response("Unsupported form encoding", { status: 415 });
    }
    const reader = request.body?.getReader();
    if (!reader) return new Response("Missing form", { status: 400 });
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        return new Response("Form is too large", { status: 413 });
      }
      chunks.push(value);
    }
    return await work(new URLSearchParams(Buffer.concat(chunks).toString("utf8")));
  } catch {
    // Never serialize a driver/transport exception, SQL arguments, or credentials to the response/log.
    console.error("Application request failed. Check service configuration and availability.");
    return new Response("The service is temporarily unavailable. Please go back and try again.", { status: 503 });
  }
}
