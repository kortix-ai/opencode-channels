import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { join, basename } from 'node:path';

const DEFAULT_UPLOAD_DIR = '/tmp/channel-uploads';

export interface IngestOptions {
  uploadDir?: string;
}

export interface IngestedFile {
  originalName: string;
  savedPath: string;
  mimeType?: string;
  size: number;
}

/**
 * Ensure the upload directory exists.
 */
async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

/**
 * Generate a unique filename by prefixing with a timestamp.
 */
function uniqueName(originalName: string): string {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  const safe = basename(originalName).replace(/[^a-zA-Z0-9._-]/g, '_');
  return `${ts}-${rand}-${safe}`;
}

/**
 * Decode a base64 data URL into a Buffer.
 * Expects format: data:[<mediatype>][;base64],<data>
 */
function decodeDataUrl(dataUrl: string): { buffer: Buffer; mimeType?: string } {
  const match = dataUrl.match(/^data:([^;,]*)?(?:;base64)?,(.*)$/);
  if (!match) {
    throw new Error('Invalid data URL format');
  }
  const mimeType = match[1] || undefined;
  const base64Data = match[2];
  const buffer = Buffer.from(base64Data, 'base64');
  return { buffer, mimeType };
}

/**
 * Download a file from an HTTP(S) URL.
 */
async function downloadFromUrl(
  url: string,
): Promise<{ buffer: Buffer; mimeType?: string }> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  }
  const mimeType = res.headers.get('content-type')?.split(';')[0] || undefined;
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, mimeType };
}

/**
 * Ingest a file from a platform attachment (base64 data URL or HTTP URL).
 * Downloads/decodes the file and saves it to the upload directory.
 */
export async function ingestFile(
  attachment: { url?: string; name?: string; mimeType?: string },
  options?: IngestOptions,
): Promise<IngestedFile | null> {
  const url = attachment.url;
  if (!url) return null;

  const uploadDir = options?.uploadDir ?? DEFAULT_UPLOAD_DIR;
  await ensureDir(uploadDir);

  try {
    let buffer: Buffer;
    let detectedMime: string | undefined;

    if (url.startsWith('data:')) {
      // Base64 data URL — decode inline
      const decoded = decodeDataUrl(url);
      buffer = decoded.buffer;
      detectedMime = decoded.mimeType;
    } else if (url.startsWith('http://') || url.startsWith('https://')) {
      // HTTP URL — download
      const downloaded = await downloadFromUrl(url);
      buffer = downloaded.buffer;
      detectedMime = downloaded.mimeType;
    } else {
      // Unknown scheme — skip
      console.warn(`[fs/ingest] Unsupported URL scheme: ${url.slice(0, 30)}...`);
      return null;
    }

    const mimeType = attachment.mimeType || detectedMime;
    const originalName = attachment.name || inferNameFromUrl(url, mimeType);
    const filename = uniqueName(originalName);
    const savedPath = join(uploadDir, filename);

    await writeFile(savedPath, buffer);

    return {
      originalName,
      savedPath,
      mimeType,
      size: buffer.length,
    };
  } catch (err) {
    console.error(
      `[fs/ingest] Failed to ingest file: ${attachment.name || '(unnamed)'}`,
      err,
    );
    return null;
  }
}

/**
 * Infer a filename from a URL or MIME type when no name is provided.
 */
function inferNameFromUrl(url: string, mimeType?: string): string {
  if (url.startsWith('data:')) {
    const ext = mimeToExtension(mimeType);
    return `file${ext}`;
  }

  try {
    const parsed = new URL(url);
    const pathSegment = parsed.pathname.split('/').pop();
    if (pathSegment && pathSegment.includes('.')) {
      return decodeURIComponent(pathSegment);
    }
  } catch {
    // not a valid URL
  }

  const ext = mimeToExtension(mimeType);
  return `file${ext}`;
}

/**
 * Map common MIME types to file extensions.
 */
function mimeToExtension(mimeType?: string): string {
  if (!mimeType) return '';

  const map: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/svg+xml': '.svg',
    'application/pdf': '.pdf',
    'text/plain': '.txt',
    'text/html': '.html',
    'text/css': '.css',
    'text/csv': '.csv',
    'application/json': '.json',
    'application/xml': '.xml',
    'audio/mpeg': '.mp3',
    'audio/wav': '.wav',
    'audio/ogg': '.ogg',
    'video/mp4': '.mp4',
    'video/webm': '.webm',
    'application/zip': '.zip',
    'application/gzip': '.gz',
    'application/javascript': '.js',
    'application/typescript': '.ts',
    'application/octet-stream': '.bin',
  };

  return map[mimeType] || '';
}

/**
 * Ingest multiple files. Processes all attachments, skipping failures.
 */
export async function ingestFiles(
  attachments: Array<{ url?: string; name?: string; mimeType?: string }>,
  options?: IngestOptions,
): Promise<IngestedFile[]> {
  const results: IngestedFile[] = [];

  for (const attachment of attachments) {
    const result = await ingestFile(attachment, options);
    if (result) {
      results.push(result);
    }
  }

  return results;
}

/**
 * Build OpenCode prompt fileParts from ingested files.
 * These are the parts that get sent with promptAsync.
 *
 * Reads each file from disk and encodes it as a base64 data URL
 * so it can be included inline in the prompt parts array.
 */
export function buildFileParts(
  files: IngestedFile[],
): Array<{ type: 'file'; mime: string; url: string; filename: string }> {
  return files.map((file) => {
    const mime = file.mimeType || 'application/octet-stream';

    // Use file:// URL for local filesystem files.
    // OpenCode can resolve these directly from the sandbox filesystem.
    const url = `file://${file.savedPath}`;

    return {
      type: 'file' as const,
      mime,
      url,
      filename: file.originalName,
    };
  });
}

/**
 * Build file parts with inline base64 encoding.
 * Use this when the OpenCode server cannot access the local filesystem
 * (e.g. remote server setup). Reads files and encodes them as data URLs.
 */
export async function buildFilePartsBase64(
  files: IngestedFile[],
): Promise<Array<{ type: 'file'; mime: string; url: string; filename: string }>> {
  const parts: Array<{ type: 'file'; mime: string; url: string; filename: string }> = [];

  for (const file of files) {
    try {
      const buffer = await readFile(file.savedPath);
      const mime = file.mimeType || 'application/octet-stream';
      const base64 = buffer.toString('base64');
      const url = `data:${mime};base64,${base64}`;

      parts.push({
        type: 'file' as const,
        mime,
        url,
        filename: file.originalName,
      });
    } catch (err) {
      console.error(
        `[fs/ingest] Failed to read file for base64 encoding: ${file.savedPath}`,
        err,
      );
    }
  }

  return parts;
}
