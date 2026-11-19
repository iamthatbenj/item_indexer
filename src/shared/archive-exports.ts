export type ArchiveStatus = {
  id: string; status: string; phase: string; progress: number; total: number;
  attempts: number; createdAt: number; expiresAt: number; bytes: number | null; error: string | null;
};
