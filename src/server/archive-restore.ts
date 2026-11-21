import "server-only";
import { randomUUID } from "node:crypto";
import { currentAccount } from "./auth";
import { writeTransaction } from "./database";
import { withVerifiedArchive } from "./archive-preflight";
import { putRetainedPhoto, removePhotoObject } from "./object-storage";
import { restorePlan } from "./archive-restore-records";

export class RestoreError extends Error { constructor(message: string, readonly status: number) { super(message); } }
const denied = () => new RestoreError("Sign in again as the approved founder who reviewed this archive.", 403);

export async function restoreArchive(accountId: string, reviewedHash: string, open: (consume: (path: string, signal: AbortSignal) => Promise<string>) => Promise<string>) {
  const attempt = randomUUID();
  const claim = await writeTransaction(async tx => {
    const account = await currentAccount(tx);
    if (!account?.founder || account.id !== accountId) throw denied();
    const now = Date.now();
    const row = (await tx.execute({ sql: "SELECT id,collection_id,lease_until FROM archive_restores WHERE account_id=? AND archive_sha256=?", args: [accountId, reviewedHash] })).rows[0];
    if (row?.collection_id) return { collection: String(row.collection_id) };
    const active = await tx.execute({ sql: "SELECT 1 FROM archive_restores WHERE collection_id IS NULL AND lease_until>? LIMIT 1", args: [now] });
    if (active.rows.length) throw new RestoreError("A restore is in progress. Wait a moment, then check again with the same archive.", 409);
    const job = row ? String(row.id) : randomUUID();
    if (row) await tx.execute({ sql: "UPDATE archive_restores SET attempt_id=?,lease_until=? WHERE id=?", args: [attempt, now + 90_000, job] });
    else await tx.execute({ sql: "INSERT INTO archive_restores(id,account_id,archive_sha256,attempt_id,lease_until,created_at) VALUES(?,?,?,?,?,?)", args: [job, accountId, reviewedHash, attempt, now + 90_000, now] });
    await tx.execute({ sql: "INSERT INTO archive_restore_attempts(id,restore_id,created_at) VALUES(?,?,?)", args: [attempt, job, now] });
    return { job };
  });
  if (claim.collection) return claim.collection;
  const job = claim.job!;
  const attemptedKeys: string[] = [];
  try {
    return await open((path, signal) => withVerifiedArchive(path, signal, async archive => {
      const plan = restorePlan(archive.data, attempt);
      for (const [source, key] of plan.attachments) {
        signal.throwIfAborted();
        const bytes = await archive.readAttachment(source);
        attemptedKeys.push(key);
        await putRetainedPhoto(key, bytes, signal);
      }
      return writeTransaction(async tx => {
        const account = await currentAccount(tx);
        if (account?.id !== accountId || !account.founder) throw denied();
        signal.throwIfAborted();
        const fenced = await tx.execute({ sql: "SELECT 1 FROM archive_restores WHERE id=? AND attempt_id=? AND lease_until>? AND collection_id IS NULL", args: [job, attempt, Date.now()] });
        if (!fenced.rows.length) throw new RestoreError("This restore attempt expired. Check again with the same archive.", 409);
        await plan.publish(tx, accountId, Date.now());
        signal.throwIfAborted();
        const latest = await currentAccount(tx);
        if (latest?.id !== accountId || !latest.founder) throw denied();
        await tx.execute({ sql: "UPDATE archive_restores SET collection_id=?,lease_until=0 WHERE id=? AND attempt_id=?", args: [plan.collection, job, attempt] });
        return plan.collection;
      });
    }));
  } catch (error) {
    // A failed response does not prove a failed commit. Fence this attempt off in
    // a fresh transaction before deleting its private candidate files.
    const state = await writeTransaction(async tx => {
      const row = (await tx.execute({ sql: "SELECT attempt_id,collection_id FROM archive_restores WHERE id=?", args: [job] })).rows[0];
      if (!row) return { cleanup: false };
      if (row.collection_id) return { completed: String(row.collection_id), cleanup: row.attempt_id !== attempt };
      await tx.execute({ sql: "UPDATE archive_restores SET lease_until=0 WHERE id=? AND attempt_id=? AND collection_id IS NULL", args: [job, attempt] });
      return { cleanup: true };
    }).catch(() => ({ cleanup: false, completed: undefined }));
    if (state.cleanup) {
      // Bound cleanup latency. Any unprocessed or uncertain keys remain tracked
      // by attempt ID for operator reconciliation, never an expiry on photos/.
      const cleanup = AbortSignal.timeout(3_000);
      for (let i = 0; i < attemptedKeys.length && !cleanup.aborted; i += 8) {
        await Promise.allSettled(attemptedKeys.slice(i, i + 8).map(key => removePhotoObject(key, cleanup)));
      }
    }
    if (state.completed) return state.completed;
    throw error;
  }
}
