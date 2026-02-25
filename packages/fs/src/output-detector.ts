import type { StreamEvent, OpenCodeClient } from '@opencode-channels/core';

export interface DetectedFile {
  name: string;
  path: string;
  url: string;
  mimeType?: string;
  source: 'sse' | 'git-status';
}

/**
 * Collect files from SSE stream events.
 * Filters for type === 'file' events and deduplicates by path/url.
 */
export function collectFilesFromEvents(events: StreamEvent[]): DetectedFile[] {
  const seen = new Set<string>();
  const files: DetectedFile[] = [];

  for (const event of events) {
    if (event.type !== 'file' || !event.file) continue;

    const { name, url, mimeType } = event.file;
    if (!url && !name) continue;

    // Deduplicate by URL first, then by name
    const key = url || name;
    if (seen.has(key)) continue;
    seen.add(key);

    // Also deduplicate by name if different key
    if (url && name && name !== url) {
      if (seen.has(name)) continue;
      seen.add(name);
    }

    files.push({
      name,
      path: url || name, // URL is often the path in OpenCode
      url: url || name,
      mimeType,
      source: 'sse',
    });
  }

  return files;
}

/**
 * Detect new files via git status diff.
 * Compares files reported by the OpenCode client's getModifiedFiles()
 * against a snapshot taken before the prompt, returning only new files.
 */
export async function detectNewFiles(
  client: OpenCodeClient,
  beforeFiles: Array<{ name: string; path: string }>,
): Promise<DetectedFile[]> {
  const afterFiles = await client.getModifiedFiles().catch(() => []);

  // Build a set of paths that existed before the prompt
  const beforePaths = new Set(beforeFiles.map((f) => f.path));
  const beforeNames = new Set(beforeFiles.map((f) => f.name));

  const newFiles: DetectedFile[] = [];

  for (const file of afterFiles) {
    // Skip files that existed before
    if (beforePaths.has(file.path) || beforeNames.has(file.name)) continue;

    newFiles.push({
      name: file.name,
      path: file.path,
      url: file.path,
      mimeType: guessFileMime(file.name),
      source: 'git-status',
    });
  }

  return newFiles;
}

/**
 * Download a detected file's content from the OpenCode server.
 * Tries downloadFile (handles both HTTP URLs and filesystem paths)
 * and falls back to downloadFileByPath.
 */
export async function downloadDetectedFile(
  client: OpenCodeClient,
  file: DetectedFile,
): Promise<{ name: string; content: Buffer; mimeType?: string } | null> {
  try {
    // Try primary download (handles URLs and path normalization)
    let content = await client.downloadFile(file.url);

    if (!content && file.path !== file.url) {
      // Try using the path directly
      content = await client.downloadFileByPath(file.path);
    }

    if (!content) {
      // Last resort: try just the filename
      content = await client.downloadFileByPath(file.name);
    }

    if (!content) {
      console.warn(`[fs/output] Failed to download: ${file.name} (${file.url})`);
      return null;
    }

    return {
      name: file.name,
      content,
      mimeType: file.mimeType,
    };
  } catch (err) {
    console.error(`[fs/output] Download error for ${file.name}:`, err);
    return null;
  }
}

/**
 * Download all detected files, skipping failures.
 */
export async function downloadDetectedFiles(
  client: OpenCodeClient,
  files: DetectedFile[],
): Promise<Array<{ name: string; content: Buffer; mimeType?: string }>> {
  const results: Array<{ name: string; content: Buffer; mimeType?: string }> = [];

  for (const file of files) {
    const result = await downloadDetectedFile(client, file);
    if (result) {
      results.push(result);
    }
  }

  return results;
}

/**
 * Take a snapshot of currently modified files for later comparison.
 * Call this before sending a prompt to detect new files afterward.
 */
export async function snapshotModifiedFiles(
  client: OpenCodeClient,
): Promise<Array<{ name: string; path: string }>> {
  return client.getModifiedFiles().catch(() => []);
}

/**
 * Guess MIME type from filename extension.
 */
function guessFileMime(filename: string): string | undefined {
  const ext = filename.split('.').pop()?.toLowerCase();
  if (!ext) return undefined;

  const mimes: Record<string, string> = {
    // Images
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    webp: 'image/webp',
    // Documents
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    csv: 'text/csv',
    // Text / Code
    txt: 'text/plain',
    md: 'text/markdown',
    html: 'text/html',
    json: 'application/json',
    xml: 'application/xml',
    // Audio / Video
    mp3: 'audio/mpeg',
    mp4: 'video/mp4',
    wav: 'audio/wav',
  };

  return mimes[ext];
}
