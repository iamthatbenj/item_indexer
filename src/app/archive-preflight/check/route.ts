import { randomUUID, timingSafeEqual } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentAccount } from "@/server/auth";
import { formPost } from "@/server/http";
import { allow, digest } from "@/server/security";
import { writeTransaction } from "@/server/database";
import { authorizePhotoUpload, IncompleteArchiveUpload, removePhotoObject, stageArchiveOnDisk } from "@/server/object-storage";
import { RejectedArchive, validateStagedArchive } from "@/server/archive-preflight";
import { ARCHIVE_UPLOAD_LIMIT } from "@/archive-preview";

export const runtime = "nodejs";
export const maxDuration = 60;
const uploadSeconds = 600;
const headers = { "Cache-Control": "private, no-store" };
function result(data: object, status = 200) { return Response.json(data, { status, headers }); }
function failure(error: string, status: number, outcome = "failed") { return result({ outcome, error }, status); }
const key = (uuid: string) => `staging/preflight/${uuid}.zip`;
const mac = (accountId: string, payload: string) => digest(`archive-preflight:v1:${accountId}:${payload}`);

async function permit(account: { id: string; email: string }, step: string) {
  return writeTransaction(async tx => {
    const founder = await tx.execute({ sql: "SELECT 1 FROM approved_founders WHERE email=?", args: [account.email] });
    if (!founder.rows.length) return "forbidden";
    const now = Date.now();
    if (!await allow(tx, `archive-preflight:${step}:${account.id}`, 4, now) || !await allow(tx, `archive-preflight:${step}:global`, 12, now)) return "limited";
    return "allowed";
  });
}

export async function POST(request: Request) {
  return formPost(request, async form => {
    const action = form.get("action");
    const account = await currentAccount();
    if (!account) return failure("Sign in as an approved founder before checking an archive.", 401);
    if (!account.founder) return failure("Only an approved founder can check an archive.", 403);
    if (form.getAll("accountId").length !== 1 || form.get("accountId") !== account.id) return failure("The signed-in account changed. Reload before checking an archive.", 409);
    if (form.getAll("action").length !== 1 || (action !== "prepare" && action !== "validate")) return failure("Choose a valid archive check action.", 400);
    let objectId: string, bytes: number, ticket: string;
    if (action === "prepare") {
      const size = form.get("size");
      bytes = Number(size);
      if (form.getAll("size").length !== 1 || !size || !/^[0-9]{1,9}$/.test(size) || bytes < 1 || bytes > ARCHIVE_UPLOAD_LIMIT) return failure("Choose a nonempty ZIP no larger than 256 MiB.", 413, "rejected");
      objectId = randomUUID();
      const payload = `${objectId}.${bytes}.${Date.now() + uploadSeconds * 1000}`;
      ticket = `${payload}.${mac(account.id, payload)}`;
    } else {
      ticket = form.get("ticket") ?? "";
      const match = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([0-9]{1,9})\.([0-9]{13})\.([0-9a-f]{64})$/.exec(ticket);
      if (form.getAll("ticket").length !== 1 || !match || Number(match[3]) <= Date.now() || !timingSafeEqual(Buffer.from(match[4], "hex"), Buffer.from(mac(account.id, ticket.slice(0, -65)), "hex"))) return failure("The upload authorization is invalid or expired. Select and upload the ZIP again.", 409);
      objectId = match[1]; bytes = Number(match[2]);
    }
    const access = await permit(account, action);
    if (access === "forbidden") return failure("Founder approval is no longer available.", 403);
    if (access === "limited") return failure("Too many archive checks. Wait up to 15 minutes before trying again.", 429);
    if (action === "prepare") return result({ ticket, uploadUrl: await authorizePhotoUpload(key(objectId), bytes, uploadSeconds) });
    let directory: string | undefined;
    try {
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(45_000)]);
      directory = await mkdtemp(join(tmpdir(), "family-preflight-"));
      const path = join(directory, "archive.zip");
      await stageArchiveOnDisk(key(objectId), bytes, path, signal);
      const preview = await validateStagedArchive(path, signal);
      const latest = await currentAccount();
      if (latest?.id !== account.id || !latest.founder) return failure("Founder access changed during validation. No preview is available.", 403);
      signal.throwIfAborted();
      return result({ outcome: "supported", preview });
    } catch (error) {
      if (error instanceof RejectedArchive) return failure(error.message, 422, "rejected");
      if (error instanceof IncompleteArchiveUpload || (error as { name?: string })?.name === "NoSuchKey") return failure("The private upload did not complete. Upload the ZIP again.", 409);
      return failure("Validation did not complete. Check the connection and try uploading again; no collection was created.", 503);
    } finally {
      // Even if the route or cleanup is interrupted, the bucket lifecycle covers this prefix.
      await Promise.allSettled([removePhotoObject(key(objectId)), ...(directory ? [rm(directory, { recursive: true, force: true })] : [])]);
    }
  }, 1024);
}
