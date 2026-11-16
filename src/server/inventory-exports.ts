import "server-only";
import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import type { Transaction } from "@libsql/client";
import { database, writeTransaction } from "./database";
import { authorizeInventoryDownload, putInventoryPDF, readInventoryThumbnail, removeInventoryObject } from "./object-storage";
import { INVENTORY_MAX_ITEMS, renderInventoryPDF, type InventoryRow } from "./inventory-pdf";

const RETENTION = 7 * 24 * 60 * 60 * 1000;
const LEASE = 90_000;
const MAX_JOBS = 5;
const MAX_ATTEMPTS = 3;
const GENERATION_MS = 25_000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Snapshot = { collectionName: string; capturedAt: number; items: { id: string; name: string; description: string; thumbnailKey: string }[] };
export type InventoryWork = { id: string; collectionId: string; accountId: string; lease: string; candidate: string };
export type InventoryStatus = { id: string; status: string; phase: string; progress: number; total: number; attempts: number; createdAt: number; expiresAt: number; bytes: number | null; pages: number | null; error: string | null };
export class InventoryError extends Error { constructor(message: string, readonly status = 400) { super(message); } }
const unavailable = () => new InventoryError("This inventory or family collection is unavailable.", 404);
async function membership(tx: Pick<Transaction, "execute">, accountId: string, collectionId: string) {
  const result = await tx.execute({ sql: "SELECT c.name FROM collections c JOIN memberships m ON m.collection_id=c.id WHERE c.id=? AND m.account_id=?", args: [collectionId, accountId] });
  if (!result.rows[0]) throw unavailable();
  return String(result.rows[0].name);
}
function view(row: Record<string, unknown>): InventoryStatus {
  let status = String(row.status);
  if (Number(row.expires_at) <= Date.now()) status = "expired";
  else if (status === "processing" && Number(row.lease_expires_at) <= Date.now()) status = "interrupted";
  return { id: String(row.id), status, phase: String(row.phase), progress: Number(row.progress), total: Number(row.item_count), attempts: Number(row.attempts), createdAt: Number(row.created_at), expiresAt: Number(row.expires_at), bytes: row.pdf_bytes == null ? null : Number(row.pdf_bytes), pages: row.page_count == null ? null : Number(row.page_count), error: row.error == null ? null : String(row.error) };
}
export async function inventoryList(accountId: string, collectionId: string): Promise<InventoryStatus[]> {
  await membership(database(), accountId, collectionId);
  const result = await database().execute({ sql: "SELECT e.* FROM inventory_exports e JOIN memberships m ON m.collection_id=e.collection_id WHERE e.collection_id=? AND m.account_id=? ORDER BY e.created_at DESC, e.id", args: [collectionId, accountId] });
  return result.rows.map(view);
}
export async function inventoryStatus(accountId: string, collectionId: string, id: string): Promise<InventoryStatus> {
  const result = await database().execute({ sql: "SELECT e.* FROM inventory_exports e JOIN memberships m ON m.collection_id=e.collection_id WHERE e.id=? AND e.collection_id=? AND m.account_id=?", args: [id, collectionId, accountId] });
  if (!result.rows[0]) throw unavailable();
  return view(result.rows[0]);
}

export async function requestInventory(accountId: string, collectionId: string, id: string, retry = false): Promise<{ job: InventoryStatus; work: InventoryWork | null }> {
  if (!uuid.test(id)) throw new InventoryError("Use a valid inventory request identifier.");
  return writeTransaction(async tx => {
    const collectionName = await membership(tx, accountId, collectionId);
    const now = Date.now();
    const found = (await tx.execute({ sql: "SELECT * FROM inventory_exports WHERE id=?", args: [id] })).rows[0];
    if (found && (String(found.collection_id) !== collectionId || !retry && String(found.requested_by) !== accountId)) throw new InventoryError("That request identifier cannot be reused here.", 409);
    if (retry && !found) throw unavailable();
    if (found) {
      const job = view(found);
      if (!retry || job.status === "ready") return { job, work: null };
      if (job.status !== "failed" && job.status !== "interrupted") throw new InventoryError("This generation cannot be retried now. Check its status or discard an old inventory.", 409);
      if (job.attempts >= MAX_ATTEMPTS) throw new InventoryError("Three generation attempts have been used. Discard this inventory and request a fresh saved snapshot.", 409);
    }
    let snapshot: Snapshot;
    if (found) snapshot = JSON.parse(String(found.snapshot));
    else {
      const count = (await tx.execute({ sql: "SELECT COUNT(*) AS count FROM inventory_exports WHERE collection_id=?", args: [collectionId] })).rows[0];
      if (Number(count.count) >= MAX_JOBS) throw new InventoryError("This collection already has five inventory requests. Discard an old generated inventory before requesting another; family records are unaffected.", 429);
      const rows = (await tx.execute({ sql: `SELECT i.id, i.name, i.description,
        (SELECT p.thumbnail_key FROM item_photos p WHERE p.item_id=i.id AND p.removed_at IS NULL ORDER BY p.created_at, p.id LIMIT 1) AS thumbnail_key
        FROM items i WHERE i.collection_id=? ORDER BY i.created_at, i.id LIMIT ?`, args: [collectionId, INVENTORY_MAX_ITEMS + 1] })).rows;
      if (rows.length > INVENTORY_MAX_ITEMS) throw new InventoryError(`The pilot inventory supports up to ${INVENTORY_MAX_ITEMS} current items. No partial PDF was created. Contact the operator for larger-collection support.`, 422);
      if (rows.some(row => !row.thumbnail_key)) throw new InventoryError("A saved item lacks its required retained photo. Repair that record before generating a complete inventory.", 409);
      snapshot = { collectionName, capturedAt: now, items: rows.map(row => ({ id: String(row.id), name: String(row.name), description: String(row.description), thumbnailKey: String(row.thumbnail_key) })) };
      if (Buffer.byteLength(JSON.stringify(snapshot)) > 2 * 1024 * 1024) throw new InventoryError("Saved snapshot exceeds the pilot inventory limit.", 422);
    }
    const lease = randomUUID(); const attempt = found ? Number(found.attempts) + 1 : 1;
    const candidate = `inventories/${collectionId}/${id}/${lease}.pdf`;
    if (found) await tx.execute({ sql: "UPDATE inventory_exports SET status='processing',phase='photos',attempts=?,lease=?,lease_expires_at=?,progress=0,error=NULL WHERE id=?", args: [attempt, lease, now + LEASE, id] });
    else await tx.execute({ sql: `INSERT INTO inventory_exports(id,collection_id,requested_by,snapshot,status,phase,attempts,lease,lease_expires_at,progress,item_count,created_at,expires_at)
      VALUES(?,?,?,?,'processing','photos',1,?,?,0,?,?,?)`, args: [id, collectionId, accountId, JSON.stringify(snapshot), lease, now + LEASE, snapshot.items.length, now, now + RETENTION] });
    await tx.execute({ sql: "INSERT INTO inventory_export_attempts(export_id,attempt,started_by,candidate_key,started_at) VALUES(?,?,?,?,?)", args: [id, attempt, accountId, candidate, now] });
    const row = (await tx.execute({ sql: "SELECT * FROM inventory_exports WHERE id=?", args: [id] })).rows[0];
    return { job: view(row), work: { id, collectionId, accountId, lease, candidate } };
  });
}

export async function generateInventory(work: InventoryWork): Promise<void> {
  const deadline = Date.now() + GENERATION_MS;
  const cancelled = new AbortController();
  const signal = AbortSignal.any([AbortSignal.timeout(GENERATION_MS), cancelled.signal]);
  const check = () => { signal.throwIfAborted(); if (Date.now() > deadline) throw new Error("Inventory generation deadline reached."); };
  async function progress(phase: string, count: number) {
    check();
    const updated = await database().execute({ sql: `UPDATE inventory_exports SET phase=?,progress=? WHERE id=? AND collection_id=? AND status='processing' AND lease=? AND lease_expires_at>?
      AND EXISTS(SELECT 1 FROM memberships WHERE collection_id=? AND account_id=?)`, args: [phase, count, work.id, work.collectionId, work.lease, Date.now(), work.collectionId, work.accountId] });
    if (updated.rowsAffected !== 1) throw unavailable();
  }
  try {
    const record = (await database().execute({ sql: "SELECT snapshot FROM inventory_exports WHERE id=? AND collection_id=? AND status='processing' AND lease=?", args: [work.id, work.collectionId, work.lease] })).rows[0];
    if (!record) return;
    await progress("photos", 0);
    const snapshot: Snapshot = JSON.parse(String(record.snapshot));
    const prepared: InventoryRow[] = [];
    for (let offset = 0; offset < snapshot.items.length; offset += 4) {
      check();
      const pending = snapshot.items.slice(offset, offset + 4).map(async item => {
        check();
        const retained = await readInventoryThumbnail(item.thumbnailKey, signal);
        check();
        const thumbnail = await sharp(retained, { limitInputPixels: 480 * 480, failOn: "warning" }).resize({ width: 160, height: 160, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
        check();
        return { id: item.id, name: item.name, description: item.description, thumbnail };
      });
      let batch: InventoryRow[];
      try { batch = await Promise.all(pending); }
      catch (error) { cancelled.abort(); await Promise.allSettled(pending); throw error; }
      prepared.push(...batch);
      await progress("photos", prepared.length);
    }
    await progress("rendering", prepared.length);
    const pdf = await renderInventoryPDF({ collectionName: snapshot.collectionName, capturedAt: snapshot.capturedAt, items: prepared }, signal, async count => {
      check();
      if (count % 10 === 0) { await new Promise<void>(resolve => setImmediate(resolve)); await progress("rendering", prepared.length); }
    });
    await progress("publishing", prepared.length);
    const sha256 = createHash("sha256").update(pdf.bytes).digest("hex");
    check();
    await putInventoryPDF(work.candidate, pdf.bytes, sha256, signal);
    check();
    await writeTransaction(async tx => {
      await membership(tx, work.accountId, work.collectionId);
      check();
      const published = await tx.execute({ sql: `UPDATE inventory_exports SET status='ready',phase='done',artifact_key=?,pdf_bytes=?,sha256=?,page_count=?,finished_at=?,lease=NULL,lease_expires_at=NULL,error=NULL
        WHERE id=? AND collection_id=? AND status='processing' AND lease=? AND lease_expires_at>? AND expires_at>?`, args: [work.candidate, pdf.bytes.length, sha256, pdf.pages, Date.now(), work.id, work.collectionId, work.lease, Date.now(), Date.now()] });
      if (published.rowsAffected !== 1) throw unavailable();
    });
  } catch (error) {
    cancelled.abort();
    const failure = error instanceof Error && (error.message.startsWith("Some saved text is not supported") || error.message.startsWith("Inventory PDF exceeds"))
      ? error.message : "Generation was not confirmed. Check access, saved photos and storage availability, then retry (up to three attempts). No partial PDF is available.";
    // Candidate files remain private and tracked, including ambiguous PUT/commit
    // outcomes. Never delete a possibly committed canonical PDF on this path.
    try {
      await database().execute({ sql: `UPDATE inventory_exports SET status='failed',phase='done',lease=NULL,lease_expires_at=NULL,error=? WHERE id=? AND status='processing' AND lease=?`, args: [failure, work.id, work.lease] });
    } catch { console.error("Inventory completion could not be confirmed. Check its durable status before retrying."); }
  }
}

export async function inventoryDownload(accountId: string, collectionId: string, id: string): Promise<string> {
  const result = await database().execute({ sql: "SELECT e.* FROM inventory_exports e JOIN memberships m ON m.collection_id=e.collection_id WHERE e.id=? AND e.collection_id=? AND m.account_id=?", args: [id, collectionId, accountId] });
  const row = result.rows[0];
  if (!row) throw unavailable();
  if (view(row).status !== "ready") throw new InventoryError("A complete, unexpired PDF is not available. Check generation status.", 409);
  const expiresIn = Math.min(60, Math.floor((Number(row.expires_at) - Date.now()) / 1000));
  if (expiresIn < 1) throw new InventoryError("This inventory has expired. Request a fresh snapshot.", 410);
  const url = await authorizeInventoryDownload(String(row.artifact_key), Number(row.pdf_bytes), String(row.sha256), expiresIn);
  // HEAD/signing cross a storage boundary: removal meanwhile must prevent a new grant.
  const current = (await database().execute({ sql: `SELECT e.id FROM inventory_exports e JOIN memberships m ON m.collection_id=e.collection_id
    WHERE e.id=? AND e.collection_id=? AND m.account_id=? AND e.status='ready' AND e.artifact_key=? AND e.expires_at>?`, args: [id, collectionId, accountId, String(row.artifact_key), Date.now()] })).rows[0];
  if (!current) throw unavailable();
  return url;
}

export async function discardInventory(accountId: string, collectionId: string, id: string): Promise<void> {
  const keys = await writeTransaction(async tx => {
    await membership(tx, accountId, collectionId);
    const row = (await tx.execute({ sql: "SELECT * FROM inventory_exports WHERE id=? AND collection_id=?", args: [id, collectionId] })).rows[0];
    if (!row) throw unavailable();
    if (String(row.status) === "processing" && Number(row.lease_expires_at) + 120_000 > Date.now()) throw new InventoryError("Generation may still be active. Check its status before discarding.", 409);
    await tx.execute({ sql: "UPDATE inventory_exports SET status='deleting',lease=NULL,lease_expires_at=NULL WHERE id=?", args: [id] });
    return (await tx.execute({ sql: "SELECT candidate_key FROM inventory_export_attempts WHERE export_id=?", args: [id] })).rows.map(row => String(row.candidate_key));
  });
  await Promise.all(keys.map(key => removeInventoryObject(key)));
  await writeTransaction(async tx => {
    await membership(tx, accountId, collectionId);
    await tx.execute({ sql: "DELETE FROM inventory_exports WHERE id=? AND collection_id=? AND status='deleting'", args: [id, collectionId] });
  });
}
