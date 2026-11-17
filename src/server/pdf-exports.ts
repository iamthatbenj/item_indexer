import "server-only";
import { createHash, randomUUID } from "node:crypto";
import type { Transaction } from "@libsql/client";
import { database, writeTransaction } from "./database";
import { authorizeInventoryDownload, putInventoryPDF, removeInventoryObject } from "./object-storage";
import { renderInventoryPDF } from "./inventory-pdf";
import { renderCataloguePDF } from "./catalogue-pdf";
import { capturePDFSnapshot, preparePDFItem, type PDFSnapshot, type PreparedPDFItem } from "./pdf-snapshot";

const RETENTION = 7 * 24 * 60 * 60 * 1000;
const LEASE = 90_000;
const MAX_JOBS = 5;
const MAX_ATTEMPTS = 3;
const GENERATION_MS = 25_000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
import { PDFExportError, type PDFFormat, type PDFWork, type PDFStatus } from "./pdf-export-types";
export { PDFExportError } from "./pdf-export-types";
export type { PDFFormat, PDFWork, PDFStatus } from "./pdf-export-types";
export function pdfExports(format: PDFFormat) {
  const table = format === "inventory" ? "inventory_exports" : "catalogue_exports";
  const attemptTable = format === "inventory" ? "inventory_export_attempts" : "catalogue_export_attempts";
  const unavailable = () => new PDFExportError("This PDF export or family collection is unavailable.", 404);
  async function membership(tx: Pick<Transaction, "execute">, accountId: string, collectionId: string) {
    const result = await tx.execute({ sql: `SELECT c.name FROM collections c JOIN memberships m ON m.collection_id=c.id WHERE c.id=? AND m.account_id=?`, args: [collectionId, accountId] });
    if (!result.rows[0]) throw unavailable();
    return String(result.rows[0].name);
  }
  function view(row: Record<string, unknown>): PDFStatus {
    let status = String(row.status);
    if (Number(row.expires_at) <= Date.now()) status = "expired";
    else if (status === "processing" && Number(row.lease_expires_at) <= Date.now()) status = "interrupted";
    return { id: String(row.id), status, phase: String(row.phase), progress: Number(row.progress), total: Number(row.item_count), attempts: Number(row.attempts), createdAt: Number(row.created_at), expiresAt: Number(row.expires_at), bytes: row.pdf_bytes == null ? null : Number(row.pdf_bytes), pages: row.page_count == null ? null : Number(row.page_count), error: row.error == null ? null : String(row.error) };
  }
  async function inventoryList(accountId: string, collectionId: string): Promise<PDFStatus[]> {
    await membership(database(), accountId, collectionId);
    const result = await database().execute({ sql: `SELECT e.* FROM ${table} e JOIN memberships m ON m.collection_id=e.collection_id WHERE e.collection_id=? AND m.account_id=? ORDER BY e.created_at DESC, e.id`, args: [collectionId, accountId] });
    return result.rows.map(view);
  }
  async function inventoryStatus(accountId: string, collectionId: string, id: string): Promise<PDFStatus> {
    const result = await database().execute({ sql: `SELECT e.* FROM ${table} e JOIN memberships m ON m.collection_id=e.collection_id WHERE e.id=? AND e.collection_id=? AND m.account_id=?`, args: [id, collectionId, accountId] });
    if (!result.rows[0]) throw unavailable();
    return view(result.rows[0]);
  }

  async function requestInventory(accountId: string, collectionId: string, id: string, retry = false): Promise<{ job: PDFStatus; work: PDFWork | null }> {
    if (!uuid.test(id)) throw new PDFExportError("Use a valid PDF request identifier.");
    return writeTransaction(async tx => {
      const collectionName = await membership(tx, accountId, collectionId);
      const now = Date.now();
      const found = (await tx.execute({ sql: `SELECT * FROM ${table} WHERE id=?`, args: [id] })).rows[0];
      if (found && (String(found.collection_id) !== collectionId || !retry && String(found.requested_by) !== accountId)) throw new PDFExportError("That request identifier cannot be reused here.", 409);
      if (retry && !found) throw unavailable();
      if (found) {
        const job = view(found);
        if (!retry || job.status === "ready") return { job, work: null };
        if (job.status !== "failed" && job.status !== "interrupted") throw new PDFExportError("This generation cannot be retried now. Check its status or discard an old PDF export.", 409);
        if (job.attempts >= MAX_ATTEMPTS) throw new PDFExportError("Three generation attempts have been used. Discard this PDF export and request a fresh saved snapshot.", 409);
      }
      let snapshot: PDFSnapshot;
      if (found) snapshot = JSON.parse(String(found.snapshot));
      else {
        const count = (await tx.execute({ sql: `SELECT (SELECT COUNT(*) FROM inventory_exports WHERE collection_id=?) + (SELECT COUNT(*) FROM catalogue_exports WHERE collection_id=?) AS count`, args: [collectionId, collectionId] })).rows[0];
        if (Number(count.count) >= MAX_JOBS) throw new PDFExportError("This collection already has five PDF requests. Discard an old generated PDF before requesting another; family records are unaffected.", 429);
        snapshot = await capturePDFSnapshot(tx, format, collectionId, collectionName, now);
        if (Buffer.byteLength(JSON.stringify(snapshot)) > 2 * 1024 * 1024) throw new PDFExportError("Saved snapshot exceeds the pilot PDF limit.", 422);
      }
      const lease = randomUUID(); const attempt = found ? Number(found.attempts) + 1 : 1;
      const candidate = format === "inventory" ? `inventories/${collectionId}/${id}/${lease}.pdf` : `inventories/${collectionId}/catalogues/${id}/${lease}.pdf`;
      if (found) await tx.execute({ sql: `UPDATE ${table} SET status='processing',phase='photos',attempts=?,lease=?,lease_expires_at=?,progress=0,error=NULL WHERE id=?`, args: [attempt, lease, now + LEASE, id] });
      else await tx.execute({ sql: `INSERT INTO ${table}(id,collection_id,requested_by,snapshot,status,phase,attempts,lease,lease_expires_at,progress,item_count,created_at,expires_at)
        VALUES(?,?,?,?,'processing','photos',1,?,?,0,?,?,?)`, args: [id, collectionId, accountId, JSON.stringify(snapshot), lease, now + LEASE, snapshot.items.length, now, now + RETENTION] });
      await tx.execute({ sql: `INSERT INTO ${attemptTable}(export_id,attempt,started_by,candidate_key,started_at) VALUES(?,?,?,?,?)`, args: [id, attempt, accountId, candidate, now] });
      const row = (await tx.execute({ sql: `SELECT * FROM ${table} WHERE id=?`, args: [id] })).rows[0];
      return { job: view(row), work: { format, id, collectionId, accountId, lease, candidate } };
    });
  }

  async function generateInventory(work: PDFWork): Promise<void> {
    if (work.format !== format) throw new PDFExportError("The PDF work format does not match.", 409);
    const deadline = Date.now() + GENERATION_MS;
    const cancelled = new AbortController();
    const signal = AbortSignal.any([AbortSignal.timeout(GENERATION_MS), cancelled.signal]);
    const check = () => { signal.throwIfAborted(); if (Date.now() > deadline) throw new Error("Inventory generation deadline reached."); };
    async function progress(phase: string, count: number) {
      check();
      const updated = await database().execute({ sql: `UPDATE ${table} SET phase=?,progress=? WHERE id=? AND collection_id=? AND status='processing' AND lease=? AND lease_expires_at>?
        AND EXISTS(SELECT 1 FROM memberships WHERE collection_id=? AND account_id=?)`, args: [phase, count, work.id, work.collectionId, work.lease, Date.now(), work.collectionId, work.accountId] });
      if (updated.rowsAffected !== 1) throw unavailable();
    }
    try {
      const record = (await database().execute({ sql: `SELECT snapshot FROM ${table} WHERE id=? AND collection_id=? AND status='processing' AND lease=?`, args: [work.id, work.collectionId, work.lease] })).rows[0];
      if (!record) return;
      await progress("photos", 0);
      const snapshot: PDFSnapshot = JSON.parse(String(record.snapshot));
      const prepared: PreparedPDFItem[] = [];
      for (let offset = 0; offset < snapshot.items.length; offset += 4) {
        check();
        const pending = snapshot.items.slice(offset, offset + 4).map(item => preparePDFItem(item, format, signal));
        let batch: PreparedPDFItem[];
        try { batch = await Promise.all(pending); }
        catch (error) { cancelled.abort(); await Promise.allSettled(pending); throw error; }
        prepared.push(...batch);
        await progress("photos", prepared.length);
      }
      await progress("rendering", prepared.length);
      const render = format === "inventory" ? renderInventoryPDF : renderCataloguePDF;
      const pdf = await render({ collectionName: snapshot.collectionName, capturedAt: snapshot.capturedAt, items: prepared }, signal, async count => {
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
        const published = await tx.execute({ sql: `UPDATE ${table} SET status='ready',phase='done',artifact_key=?,pdf_bytes=?,sha256=?,page_count=?,finished_at=?,lease=NULL,lease_expires_at=NULL,error=NULL
          WHERE id=? AND collection_id=? AND status='processing' AND lease=? AND lease_expires_at>? AND expires_at>?`, args: [work.candidate, pdf.bytes.length, sha256, pdf.pages, Date.now(), work.id, work.collectionId, work.lease, Date.now(), Date.now()] });
        if (published.rowsAffected !== 1) throw unavailable();
      });
    } catch (error) {
      cancelled.abort();
      const failure = error instanceof Error && (error.message.startsWith("Some saved text is not supported") || error.message.startsWith("A retained photo does not match") || (error.message.startsWith("Inventory PDF exceeds") || error.message.startsWith("Catalogue PDF exceeds")))
        ? error.message : "Generation was not confirmed. Check access, saved photos and storage availability, then retry (up to three attempts). No partial PDF is available.";
      // Candidate files remain private and tracked, including ambiguous PUT/commit
      // outcomes. Never delete a possibly committed canonical PDF on this path.
      try {
        await database().execute({ sql: `UPDATE ${table} SET status='failed',phase='done',lease=NULL,lease_expires_at=NULL,error=? WHERE id=? AND status='processing' AND lease=?`, args: [failure, work.id, work.lease] });
      } catch { console.error("Inventory completion could not be confirmed. Check its durable status before retrying."); }
    }
  }

  async function inventoryDownload(accountId: string, collectionId: string, id: string): Promise<string> {
    const result = await database().execute({ sql: `SELECT e.* FROM ${table} e JOIN memberships m ON m.collection_id=e.collection_id WHERE e.id=? AND e.collection_id=? AND m.account_id=?`, args: [id, collectionId, accountId] });
    const row = result.rows[0];
    if (!row) throw unavailable();
    if (view(row).status !== "ready") throw new PDFExportError("A complete, unexpired PDF is not available. Check generation status.", 409);
    const expiresIn = Math.min(60, Math.floor((Number(row.expires_at) - Date.now()) / 1000));
    if (expiresIn < 1) throw new PDFExportError("This PDF export has expired. Request a fresh snapshot.", 410);
    const url = await authorizeInventoryDownload(String(row.artifact_key), Number(row.pdf_bytes), String(row.sha256), expiresIn, format);
    // HEAD/signing cross a storage boundary: removal meanwhile must prevent a new grant.
    const current = (await database().execute({ sql: `SELECT e.id FROM ${table} e JOIN memberships m ON m.collection_id=e.collection_id
      WHERE e.id=? AND e.collection_id=? AND m.account_id=? AND e.status='ready' AND e.artifact_key=? AND e.expires_at>?`, args: [id, collectionId, accountId, String(row.artifact_key), Date.now()] })).rows[0];
    if (!current) throw unavailable();
    return url;
  }

  async function discardInventory(accountId: string, collectionId: string, id: string): Promise<void> {
    const keys = await writeTransaction(async tx => {
      await membership(tx, accountId, collectionId);
      const row = (await tx.execute({ sql: `SELECT * FROM ${table} WHERE id=? AND collection_id=?`, args: [id, collectionId] })).rows[0];
      if (!row) throw unavailable();
      if (String(row.status) === "processing" && Number(row.lease_expires_at) + 120_000 > Date.now()) throw new PDFExportError("Generation may still be active. Check its status before discarding.", 409);
      await tx.execute({ sql: `UPDATE ${table} SET status='deleting',lease=NULL,lease_expires_at=NULL WHERE id=?`, args: [id] });
      return (await tx.execute({ sql: `SELECT candidate_key FROM ${attemptTable} WHERE export_id=?`, args: [id] })).rows.map(row => String(row.candidate_key));
    });
    await Promise.all(keys.map(key => removeInventoryObject(key)));
    await writeTransaction(async tx => {
      await membership(tx, accountId, collectionId);
      await tx.execute({ sql: `DELETE FROM ${table} WHERE id=? AND collection_id=? AND status='deleting'`, args: [id, collectionId] });
    });
  }

  return { list: inventoryList, status: inventoryStatus, request: requestInventory, generate: generateInventory, download: inventoryDownload, discard: discardInventory };
}
