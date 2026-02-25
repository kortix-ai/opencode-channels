// ─── File ingestion (platform → sandbox) ────────────────────────────────────
export {
  ingestFile,
  ingestFiles,
  buildFileParts,
  buildFilePartsBase64,
} from './file-ingester.js';
export type { IngestOptions, IngestedFile } from './file-ingester.js';

// ─── File server (sandbox → platform) ───────────────────────────────────────
export { createFileServer, guessMimeType } from './file-server.js';
export type { FileServerOptions } from './file-server.js';

// ─── Output detection ───────────────────────────────────────────────────────
export {
  collectFilesFromEvents,
  detectNewFiles,
  downloadDetectedFile,
  downloadDetectedFiles,
  snapshotModifiedFiles,
} from './output-detector.js';
export type { DetectedFile } from './output-detector.js';

// ─── Plugin ─────────────────────────────────────────────────────────────────
export { default as filePlugin } from './plugin.js';
