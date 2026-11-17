export type PDFFormat = "inventory" | "catalogue";
export type PDFWork = { format: PDFFormat; id: string; collectionId: string; accountId: string; lease: string; candidate: string };
export type PDFStatus = { id: string; status: string; phase: string; progress: number; total: number; attempts: number; createdAt: number; expiresAt: number; bytes: number | null; pages: number | null; error: string | null };
export class PDFExportError extends Error { constructor(message: string, readonly status = 400) { super(message); } }
