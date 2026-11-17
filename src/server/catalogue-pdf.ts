import "server-only";
import PDFDocument from "pdfkit";
import { fonts, pdfText } from "./pdf-text";
import { INVENTORY_MAX_PDF_BYTES } from "./inventory-pdf";
import type { PreparedPDFItem } from "./pdf-snapshot";

type Input = { collectionName: string; capturedAt: number; items: PreparedPDFItem[] };
export async function renderCataloguePDF(input: Input, signal: AbortSignal, progress: (count: number) => Promise<void>): Promise<{ bytes: Buffer; pages: number }> {
  signal.throwIfAborted();
  const embedded = await fonts(); signal.throwIfAborted();
  const doc = new PDFDocument({ autoFirstPage: false, bufferPages: true, size: "A4", margins: { top: 190, bottom: 44, left: 40, right: 40 },
    info: { Title: "Illustrated family catalogue", Creator: "Family Belongings", CreationDate: new Date(input.capturedAt) } });
  const text = pdfText(doc, embedded, signal);
  const chunks: Buffer[] = []; let size = 0; let pages = 0; let context = "Index";
  const contexts: string[] = []; const starts: number[] = [];
  const result = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (chunk: Buffer) => { size += chunk.length; if (size > INVENTORY_MAX_PDF_BYTES) doc.destroy(new Error("Catalogue PDF exceeds the 16 MiB limit. No partial PDF was generated.")); else chunks.push(chunk); });
    doc.once("error", reject); doc.once("end", () => resolve(Buffer.concat(chunks)));
  });
  void result.catch(() => {});
  const abort = () => doc.destroy(new Error("Catalogue generation exceeded its time limit."));
  signal.addEventListener("abort", abort, { once: true });
  const title = (item: PreparedPDFItem) => item.name || "Untitled belonging";
  function space(height: number) { if (doc.y + height > doc.page.height - 44) doc.addPage(); }
  function paragraph(value: string, size = 11) { text(value, 40, doc.y, 515, size); doc.y += 12; }
  doc.on("pageAdded", () => {
    pages++; if (pages > 250) throw new Error("Catalogue PDF exceeds the 250-page pilot limit. No partial PDF was generated.");
    contexts.push(context); doc.x = 40; doc.y = 190;
  });
  try {
    // Fixed-height abbreviated index rows reserve known pages. Full identifying
    // names remain in their item sections. Destinations and page numbers are
    // filled only after body layout, never inside an active text continuation.
    const perIndexPage = 22; const indexPages = Math.max(1, Math.ceil(input.items.length / perIndexPage));
    for (let index = 0; index < indexPages; index++) doc.addPage();
    for (let index = 0; index < input.items.length; index++) {
      signal.throwIfAborted();
      const item = input.items[index];
      context = `Item ${index + 1}`; doc.addPage(); starts.push(pages);
      doc.addNamedDestination(`item-${item.id}`, "XYZ", 40, 170, 0);
      doc.outline.addItem(`${index + 1}. ${title(item).replace(/\s+/gu, " ")}`);
      paragraph(`${index + 1}. ${title(item)}${!item.name || !item.description ? " — Draft item" : ""}`, 17);
      paragraph(item.description || "No short description recorded.");
      paragraph(item.keeper ? `Current keeper: ${item.keeper}\nKeeping does not establish legal ownership.` : "Current keeper: not recorded.", 10);
      for (let photo = 0; photo < item.images.length; photo++) {
        signal.throwIfAborted(); space(270);
        text(`Retained photo ${photo + 1} of ${item.images.length}`, 40, doc.y, 515, 9);
        const y = doc.y + 6; doc.image(item.images[photo], 40, y, { fit: [515, 230], align: "center" }); doc.y = y + 245;
      }
      space(50); paragraph("Independent recollections — differences are not resolved or verified here.", 10);
      if (!item.stories?.length) paragraph("No stories recorded.");
      for (let storyIndex = 0; storyIndex < (item.stories?.length ?? 0); storyIndex++) {
        const story = item.stories![storyIndex];
        context = `Item ${index + 1} / Story ${storyIndex + 1} — Storyteller: ${story.storytellerName}`;
        space(110);
        paragraph(`Story ${storyIndex + 1} — Storyteller: ${story.storyteller}`, 12);
        paragraph(`Recorded by: ${story.recorder}\nRecorded at: ${new Date(story.recordedAt).toISOString()}` +
          (story.version > 1 ? `\nLast edited by: ${story.editor}\nEdited at: ${new Date(story.updatedAt).toISOString()} | Saved version ${story.version}` : ""), 9);
        paragraph(story.text);
      }
      await progress(index + 1);
    }
    for (let page = 0; page < indexPages; page++) {
      signal.throwIfAborted(); doc.switchToPage(page);
      text(`Family collection: ${input.collectionName.replace(/\s+/gu, " ").trim()}`, 40, 190, 515, 11);
      text("Index — select a name or page number to open its item section.", 40, 265, 515, 10);
      if (!input.items.length) text("No saved items in this family collection at the snapshot time.", 40, 300, 515, 11);
      for (let row = 0; row < perIndexPage; row++) {
        const index = page * perIndexPage + row; const item = input.items[index]; if (!item) break;
        const y = 290 + row * 22;
        text(`${index + 1}. ${title(item).replace(/\s+/gu, " ")}`, 40, y, 435, 10, 18);
        text(`p. ${starts[index]}`, 490, y, 65, 10);
        doc.goTo(40, y, 515, 20, `item-${item.id}`);
      }
    }
    // Body is complete: page decoration cannot corrupt active font/text state.
    for (let page = 0; page < pages; page++) {
      signal.throwIfAborted(); doc.switchToPage(page);
      text("Illustrated family catalogue", 40, 28, 515, 17);
      text(input.collectionName.replace(/\s+/gu, " ").trim(), 40, 56, 515, 10, 28);
      text(contexts[page], 40, 90, 515, 10, 74);
      text(`Saved snapshot: ${new Date(input.capturedAt).toISOString()}`, 40, 169, 515, 8);
      doc.font("inventory-0").fontSize(8).text(`Private saved catalogue | Page ${page + 1} | Not a valuation or proof of legal ownership`, 40, doc.page.height - 29, { lineBreak: false });
    }
    signal.throwIfAborted(); doc.end(); const bytes = await result; signal.throwIfAborted(); return { bytes, pages };
  } catch (error) { doc.destroy(error instanceof Error ? error : new Error("Catalogue rendering failed.")); await result.catch(() => {}); throw error; }
  finally { signal.removeEventListener("abort", abort); }
}
