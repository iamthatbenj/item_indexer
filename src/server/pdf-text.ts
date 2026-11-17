import "server-only";
import { create, type Font } from "fontkit";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
const files = ["DejaVuSans.ttf", "NotoSansCJKsc-Regular.otf", "NotoEmoji.ttf"];
let fontData: Promise<{ bytes: Buffer; font: Font }[]> | undefined;
export function fonts() {
  return fontData ??= Promise.all(files.map(async file => {
    const bytes = await readFile(join(process.cwd(), "assets/inventory-fonts", file));
    const font = create(bytes);
    if (!("hasGlyphForCodePoint" in font)) throw new Error("Inventory font is not an individual typeface.");
    return { bytes, font };
  })).catch(error => { fontData = undefined; throw error; });
}


export function pdfText(doc: PDFKit.PDFDocument, embedded: Awaited<ReturnType<typeof fonts>>, signal: AbortSignal) {
  embedded.forEach((font, index) => doc.registerFont(`inventory-${index}`, font.bytes));
  const selected = new Map<string, number>();
  const segmenter = new Intl.Segmenter("und", { granularity: "grapheme" });
  function text(value: string, x: number, y: number, width: number, size: number, height?: number) {
    signal.throwIfAborted();
    const runs: { font: number; text: string }[] = [];
    for (const { segment } of segmenter.segment(value.replace(/\r\n?/g, "\n").replace(/\t/g, "    "))) {
      let font = selected.get(segment);
      if (font === undefined) {
        const points = Array.from(segment, character => character.codePointAt(0)!);
        font = embedded.findIndex(({ font }) => points.every(point => point === 10 || point === 0x200d || point >= 0xfe00 && point <= 0xfe0f || font.hasGlyphForCodePoint(point)));
        if (font < 0) throw new Error("Some saved text is not supported by the embedded PDF fonts. No complete PDF was generated.");
        selected.set(segment, font);
      }
      const previous = runs[runs.length - 1];
      if (previous?.font === font) previous.text += segment;
      else runs.push({ font, text: segment });
    }
    runs.forEach((run, index) => {
      doc.font(`inventory-${run.font}`).fontSize(size);
      const options = { width, lineGap: 2, continued: index < runs.length - 1, ...(height === undefined ? {} : { height, ellipsis: true }) };
      if (index === 0) doc.text(run.text, x, y, options);
      else doc.text(run.text, options);
    });
  }
  return text;
}
