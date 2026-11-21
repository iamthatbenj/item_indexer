import "server-only";
import PDFDocument from "pdfkit";
import { fonts, pdfText } from "./pdf-text";

export const INVENTORY_MAX_ITEMS = 200;
export const INVENTORY_MAX_PDF_BYTES = 16 * 1024 * 1024;
export type InventoryRow = { id: string; name: string; description: string; category?: string; location?: string; thumbnail: Buffer };
export type InventoryDocument = { collectionName: string; capturedAt: number; items: InventoryRow[] };
// This module renders saved input only. It never fetches URLs, authorizes access,
// chooses photos, publishes a file or interprets local unconfirmed editor text.
export async function renderInventoryPDF(input: InventoryDocument, signal: AbortSignal, progress: (count: number) => Promise<void> = async () => {}): Promise<{ bytes: Buffer; pages: number }> {
  if (input.items.length > INVENTORY_MAX_ITEMS) throw new Error(`Inventory is limited to ${INVENTORY_MAX_ITEMS} saved items per generation.`);
  signal.throwIfAborted();
  const embedded = await fonts();
  signal.throwIfAborted();
  const doc = new PDFDocument({ autoFirstPage: false, bufferPages: true, size: "A4", margins: { top: 144, bottom: 44, left: 40, right: 40 },
    info: { Title: "Family collection inventory", Creator: "Family Belongings", CreationDate: new Date(input.capturedAt) } });
  const text = pdfText(doc, embedded, signal);
  const chunks: Buffer[] = [];
  let size = 0; let pages = 0; let currentItem: number | null = null;
  const continuations: (number | null)[] = [];
  const result = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > INVENTORY_MAX_PDF_BYTES) doc.destroy(new Error("Inventory PDF exceeds the generation size limit."));
      else chunks.push(chunk);
    });
    doc.once("error", reject);
    doc.once("end", () => resolve(Buffer.concat(chunks)));
  });
  // A stream error can occur while progress is awaiting database work.
  void result.catch(() => {});
  const abort = () => doc.destroy(new Error("Inventory generation exceeded its time limit."));
  signal.addEventListener("abort", abort, { once: true });
  doc.on("pageAdded", () => {
    pages++;
    if (pages > 250) throw new Error("Inventory PDF exceeds the 250-page pilot limit. No partial PDF was generated.");
    continuations.push(currentItem);
    doc.x = 136; doc.y = 144;
  });
  function decoratePage(pageNumber: number, continuedItem: number | null) {
    doc.fillColor("#20252b");
    text("Family collection inventory", 40, 28, 515, 16);
    // A repeated header must never recursively paginate an unusual collection
    // name. Its complete normalized name is also printed in the first body.
    text(input.collectionName.replace(/\s+/gu, " ").trim(), 40, 53, 515, 9, 30);
    text(`Saved snapshot: ${new Date(input.capturedAt).toISOString()} | ${input.items.length} items`, 40, 91, 515, 8);
    doc.font("inventory-0").fontSize(9).text("Photo", 40, 113, { lineBreak: false });
    doc.text(continuedItem === null ? "Item and short description" : `Item and short description — item ${continuedItem} continued`, 136, 113, { lineBreak: false });
    doc.moveTo(40, 130).lineTo(555, 130).strokeColor("#b5bac0").stroke();
    doc.fontSize(8).text(`Private saved inventory | Page ${pageNumber} | Not a valuation or proof of legal ownership`, 40, doc.page.height - 29, { lineBreak: false });
  }
  try {
    doc.addPage();
    text(`Family collection: ${input.collectionName.replace(/\s+/gu, " ").trim()}`, 136, doc.y, 419, 10);
    doc.y += 12;
    if (!input.items.length) text("No saved items in this family collection at the snapshot time.", 136, doc.y, 419, 10);
    for (let index = 0; index < input.items.length; index++) {
      signal.throwIfAborted();
      if (doc.destroyed) throw new Error("Inventory output could not be completed.");
      currentItem = null;
      if (doc.y > doc.page.height - 144) doc.addPage();
      currentItem = index + 1;
      const row = input.items[index]; const startPage = pages; const y = doc.y;
      doc.image(row.thumbnail, 40, y, { fit: [76, 76], align: "center" });
      text(`${index + 1}. ${row.name || "Untitled belonging"}${!row.name || !row.description ? " — Draft item" : ""}`, 136, y, 419, 11);
      text(row.description || "No short description recorded.", 136, doc.y + 4, 419, 10);
      for (const [label, value] of [["Category", row.category], ["Location", row.location]]) if (value) text(`${label}: ${value}`, 136, doc.y + 4, 419, 10);
      doc.y = (pages === startPage ? Math.max(doc.y, y + 80) : doc.y) + 15;
      doc.moveTo(136, doc.y - 7).lineTo(555, doc.y - 7).strokeColor("#e0e2e5").stroke();
      await progress(index + 1);
    }
    // Headers use their own text flows only after body layout is complete.
    // Drawing them from pageAdded changes PDFKit's active font and continued
    // text wrapper in the middle of an automatically paginated body run.
    const range = doc.bufferedPageRange();
    for (let index = range.start; index < range.start + range.count; index++) {
      signal.throwIfAborted();
      doc.switchToPage(index);
      decoratePage(index + 1, continuations[index]);
    }
    signal.throwIfAborted();
    doc.end();
    const bytes = await result;
    signal.throwIfAborted();
    return { bytes, pages };
  } catch (error) {
    doc.destroy(error instanceof Error ? error : new Error("Inventory rendering failed."));
    await result.catch(() => {});
    throw error;
  } finally { signal.removeEventListener("abort", abort); }
}
