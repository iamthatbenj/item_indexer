export const ARCHIVE_UPLOAD_LIMIT = 256 * 1024 * 1024;
export type ArchivePreview = {
  version: string; collection: string; items: number; people: number; stories: number;
  photos: number; removedPhotos: number; revisions: number; files: number;
};
