import "server-only";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import type { Transaction } from "@libsql/client";
import { database, writeTransaction } from "./database";
import { authorizeArchiveDownload, putPortableArchive, removeInventoryObject } from "./object-storage";
import { ArchiveError, captureArchiveSnapshot, type ArchiveSnapshot } from "./archive-snapshot";
import { buildArchiveZIP } from "./archive-zip";
import type { ArchiveStatus } from "@/shared/archive-exports";
export { ArchiveError } from "./archive-snapshot";

type Work = { id: string; collectionId: string; accountId: string; lease: string; candidate: string };
const RETENTION = 7 * 24 * 60 * 60 * 1000, LEASE = 90_000, GENERATION_MS = 45_000;
const unavailable = () => new ArchiveError("This archive or family collection is unavailable.", 404);
async function membership(tx: Pick<Transaction, "execute">, accountId: string, collectionId: string) {
  if (!(await tx.execute({ sql: "SELECT 1 FROM memberships WHERE collection_id=? AND account_id=?", args: [collectionId, accountId] })).rows.length) throw unavailable();
}
function view(row: Record<string, unknown>): ArchiveStatus {
  const status = Number(row.expires_at) <= Date.now() ? "expired" : row.status === "processing" && Number(row.lease_expires_at) <= Date.now() ? "interrupted" : String(row.status);
  return { id: String(row.id), status, phase: String(row.phase), progress: Number(row.progress), total: Number(row.file_count), attempts: Number(row.attempts), createdAt: Number(row.created_at), expiresAt: Number(row.expires_at), bytes: row.artifact_bytes === null ? null : Number(row.artifact_bytes), error: row.error === null ? null : String(row.error) };
}
export async function archiveList(accountId: string, collectionId: string) {
  await membership(database(), accountId, collectionId);
  const rows = (await database().execute({ sql: "SELECT e.* FROM archive_exports e JOIN memberships m ON m.collection_id=e.collection_id WHERE e.collection_id=? AND m.account_id=? ORDER BY e.created_at DESC,e.id", args: [collectionId, accountId] })).rows;
  return rows.map(view);
}
export async function requestArchive(accountId: string, collectionId: string, id: string, retry = false): Promise<{ job: ArchiveStatus; work: Work | null }> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new ArchiveError("Use a valid archive request identifier.");
  return writeTransaction(async tx => {
    await membership(tx, accountId, collectionId);
    const now = Date.now();
    const found = (await tx.execute({ sql: "SELECT * FROM archive_exports WHERE id=?", args: [id] })).rows[0];
    if (found && (found.collection_id !== collectionId || !retry && found.requested_by !== accountId)) throw new ArchiveError("That request identifier cannot be reused here.", 409);
    if (retry && !found) throw unavailable();
    if (found) {
      const job = view(found);
      if (!retry || job.status === "ready") return { job, work: null };
      if (!["failed", "interrupted"].includes(job.status)) throw new ArchiveError("This archive cannot be retried now. Check its status.", 409);
      if (job.attempts >= 3) throw new ArchiveError("Three attempts have been used. Discard this archive and request a fresh snapshot.", 409);
    } else {
      const count = (await tx.execute({ sql: "SELECT COUNT(*) AS count FROM archive_exports WHERE collection_id=?", args: [collectionId] })).rows[0];
      if (Number(count.count) >= 2) throw new ArchiveError("Two archive requests are already retained for this collection. Discard an old archive to free capacity; source records are unaffected.", 429);
    }
    const snapshot: ArchiveSnapshot = found ? JSON.parse(String(found.snapshot)) : await captureArchiveSnapshot(tx, collectionId, accountId, id, now);
    const lease = randomUUID(), attempt = found ? Number(found.attempts) + 1 : 1;
    const candidate = `inventories/${collectionId}/archives/${id}/${lease}.zip`;
    if (found) await tx.execute({ sql: "UPDATE archive_exports SET status='processing',phase='files',attempts=?,lease=?,lease_expires_at=?,progress=0,error=NULL WHERE id=?", args: [attempt, lease, now + LEASE, id] });
    else await tx.execute({ sql: "INSERT INTO archive_exports(id,collection_id,requested_by,snapshot,status,phase,attempts,lease,lease_expires_at,file_count,created_at,expires_at) VALUES(?,?,?,?,'processing','files',1,?,?,?,?,?)", args: [id, collectionId, accountId, JSON.stringify(snapshot), lease, now + LEASE, snapshot.files.length + 3, now, now + RETENTION] });
    await tx.execute({ sql: "INSERT INTO archive_export_attempts(export_id,attempt,started_by,candidate_key,started_at) VALUES(?,?,?,?,?)", args: [id, attempt, accountId, candidate, now] });
    return { job: view((await tx.execute({ sql: "SELECT * FROM archive_exports WHERE id=?", args: [id] })).rows[0]), work: { id, collectionId, accountId, lease, candidate } };
  });
}
export async function generateArchive(work: Work) {
  const signal = AbortSignal.timeout(GENERATION_MS);
  let archive: Awaited<ReturnType<typeof buildArchiveZIP>> | undefined;
  async function progress(phase: "files" | "publishing", files: number) {
    signal.throwIfAborted();
    const updated = await database().execute({ sql: `UPDATE archive_exports SET phase=?,progress=? WHERE id=? AND collection_id=? AND status='processing' AND lease=? AND lease_expires_at>?
      AND EXISTS(SELECT 1 FROM memberships WHERE collection_id=? AND account_id=?)`, args: [phase, files, work.id, work.collectionId, work.lease, Date.now(), work.collectionId, work.accountId] });
    if (updated.rowsAffected !== 1) throw unavailable();
  }
  try {
    const row = (await database().execute({ sql: "SELECT snapshot FROM archive_exports WHERE id=? AND collection_id=? AND status='processing' AND lease=?", args: [work.id, work.collectionId, work.lease] })).rows[0];
    if (!row) return;
    const snapshot: ArchiveSnapshot = JSON.parse(String(row.snapshot));
    await progress("files", 0);
    archive = await buildArchiveZIP(snapshot, signal, async count => {
      signal.throwIfAborted();
      if (count % 10 === 0 || count === snapshot.files.length + 3) await progress("files", count);
    });
    await progress("publishing", archive.fileCount);
    await putPortableArchive(work.candidate, archive.path, archive.bytes, archive.sha256, signal);
    signal.throwIfAborted();
    await writeTransaction(async tx => {
      await membership(tx, work.accountId, work.collectionId);
      signal.throwIfAborted();
      const result = await tx.execute({ sql: `UPDATE archive_exports SET status='ready',phase='done',artifact_key=?,artifact_bytes=?,sha256=?,finished_at=?,lease=NULL,lease_expires_at=NULL,error=NULL
        WHERE id=? AND collection_id=? AND status='processing' AND lease=? AND lease_expires_at>? AND expires_at>?`, args: [work.candidate, archive!.bytes, archive!.sha256, Date.now(), work.id, work.collectionId, work.lease, Date.now(), Date.now()] });
      if (result.rowsAffected !== 1) throw unavailable();
    });
  } catch (error) {
    const message = error instanceof ArchiveError && error.status !== 404 ? error.message : "Generation was not confirmed. Check access, retained files and storage availability, then retry (up to three attempts). No partial archive is available.";
    // A lost PUT/commit acknowledgement may hide a committed canonical object.
    // Keep every candidate tracked/private; never delete it on this catch path.
    try { await database().execute({ sql: "UPDATE archive_exports SET status='failed',phase='done',lease=NULL,lease_expires_at=NULL,error=? WHERE id=? AND status='processing' AND lease=?", args: [message, work.id, work.lease] }); }
    catch { console.error("Archive completion could not be confirmed. Check durable status before retrying."); }
  } finally {
    if (archive) await rm(archive.directory, { recursive: true, force: true }).catch(() => console.error("Private archive temporary-file cleanup failed."));
  }
}
export async function archiveDownload(accountId: string, collectionId: string, id: string) {
  const row = (await database().execute({ sql: "SELECT e.* FROM archive_exports e JOIN memberships m ON m.collection_id=e.collection_id WHERE e.id=? AND e.collection_id=? AND m.account_id=?", args: [id, collectionId, accountId] })).rows[0];
  if (!row) throw unavailable();
  if (view(row).status !== "ready") throw new ArchiveError("A complete unexpired archive is not available. Check generation status.", 409);
  const expiresIn = Math.min(60, Math.floor((Number(row.expires_at) - Date.now()) / 1000));
  if (expiresIn < 1) throw new ArchiveError("This archive expired. Request a fresh snapshot.", 410);
  const url = await authorizeArchiveDownload(String(row.artifact_key), Number(row.artifact_bytes), String(row.sha256), expiresIn);
  if (!(await database().execute({ sql: `SELECT e.id FROM archive_exports e JOIN memberships m ON m.collection_id=e.collection_id
    WHERE e.id=? AND e.collection_id=? AND m.account_id=? AND e.status='ready' AND e.artifact_key=? AND e.expires_at>?`, args: [id, collectionId, accountId, String(row.artifact_key), Date.now()] })).rows.length) throw unavailable();
  return url;
}
export async function discardArchive(accountId: string, collectionId: string, id: string) {
  const keys = await writeTransaction(async tx => {
    await membership(tx, accountId, collectionId);
    const row = (await tx.execute({ sql: "SELECT * FROM archive_exports WHERE id=? AND collection_id=?", args: [id, collectionId] })).rows[0];
    if (!row) throw unavailable();
    if (row.status === "processing" && Number(row.lease_expires_at) + 120_000 > Date.now()) throw new ArchiveError("Generation may still be active. Check its status before discarding.", 409);
    await tx.execute({ sql: "UPDATE archive_exports SET status='deleting',lease=NULL,lease_expires_at=NULL WHERE id=?", args: [id] });
    return (await tx.execute({ sql: "SELECT candidate_key FROM archive_export_attempts WHERE export_id=?", args: [id] })).rows.map(r => String(r.candidate_key));
  });
  await Promise.all(keys.map(key => removeInventoryObject(key)));
  await writeTransaction(async tx => {
    await membership(tx, accountId, collectionId);
    await tx.execute({ sql: "DELETE FROM archive_exports WHERE id=? AND collection_id=? AND status='deleting'", args: [id, collectionId] });
  });
}
