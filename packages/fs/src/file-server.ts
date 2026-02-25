import { Hono } from 'hono';
import { readFile, stat, readdir } from 'node:fs/promises';
import { join, extname, relative } from 'node:path';

export interface FileServerOptions {
  /** Base directory to serve files from (default: process.cwd()) */
  basePath?: string;
  /** URL prefix (default: '/files') */
  routePrefix?: string;
}

/**
 * Guess MIME type from file extension.
 * Supports common types: images, documents, text, code, archives, audio, video.
 */
export function guessMimeType(filename: string): string {
  const ext = extname(filename).toLowerCase().replace('.', '');

  const mimeMap: Record<string, string> = {
    // Images
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    ico: 'image/x-icon',
    bmp: 'image/bmp',
    tiff: 'image/tiff',
    tif: 'image/tiff',
    avif: 'image/avif',

    // Documents
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',

    // Text / Code
    txt: 'text/plain',
    md: 'text/markdown',
    html: 'text/html',
    htm: 'text/html',
    css: 'text/css',
    csv: 'text/csv',
    xml: 'application/xml',
    json: 'application/json',
    js: 'application/javascript',
    mjs: 'application/javascript',
    ts: 'application/typescript',
    tsx: 'application/typescript',
    jsx: 'application/javascript',
    py: 'text/x-python',
    rb: 'text/x-ruby',
    go: 'text/x-go',
    rs: 'text/x-rust',
    java: 'text/x-java',
    c: 'text/x-c',
    cpp: 'text/x-c++',
    h: 'text/x-c',
    sh: 'text/x-shellscript',
    yaml: 'text/yaml',
    yml: 'text/yaml',
    toml: 'text/toml',
    sql: 'text/x-sql',
    log: 'text/plain',

    // Archives
    zip: 'application/zip',
    gz: 'application/gzip',
    tar: 'application/x-tar',
    '7z': 'application/x-7z-compressed',
    rar: 'application/x-rar-compressed',

    // Audio
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    flac: 'audio/flac',
    aac: 'audio/aac',
    m4a: 'audio/mp4',
    weba: 'audio/webm',

    // Video
    mp4: 'video/mp4',
    webm: 'video/webm',
    avi: 'video/x-msvideo',
    mov: 'video/quicktime',
    mkv: 'video/x-matroska',

    // Fonts
    woff: 'font/woff',
    woff2: 'font/woff2',
    ttf: 'font/ttf',
    otf: 'font/otf',

    // Other
    wasm: 'application/wasm',
  };

  return mimeMap[ext] || 'application/octet-stream';
}

/**
 * Recursively list files in a directory, returning relative paths.
 */
async function listFilesRecursive(
  dir: string,
  base: string,
  maxDepth: number = 3,
  depth: number = 0,
): Promise<Array<{ name: string; path: string; size: number; mimeType: string }>> {
  if (depth >= maxDepth) return [];

  const results: Array<{ name: string; path: string; size: number; mimeType: string }> = [];

  try {
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      // Skip hidden files/directories and node_modules
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;

      const fullPath = join(dir, entry.name);
      const relPath = relative(base, fullPath);

      if (entry.isDirectory()) {
        const subFiles = await listFilesRecursive(fullPath, base, maxDepth, depth + 1);
        results.push(...subFiles);
      } else if (entry.isFile()) {
        try {
          const fileStat = await stat(fullPath);
          results.push({
            name: entry.name,
            path: relPath,
            size: fileStat.size,
            mimeType: guessMimeType(entry.name),
          });
        } catch {
          // Skip files we can't stat
        }
      }
    }
  } catch {
    // Directory doesn't exist or can't be read
  }

  return results;
}

/**
 * Create a Hono app that serves files from the filesystem.
 *
 * Routes:
 *   GET {prefix}/list     — list available files as JSON
 *   GET {prefix}/:path+   — serve a file with proper Content-Type
 */
export function createFileServer(options?: FileServerOptions): Hono {
  const basePath = options?.basePath ?? process.cwd();
  const prefix = (options?.routePrefix ?? '/files').replace(/\/$/, '');

  const app = new Hono();

  // ── List available output files ─────────────────────────────────────────
  app.get(`${prefix}/list`, async (c) => {
    const files = await listFilesRecursive(basePath, basePath);
    return c.json({
      basePath,
      count: files.length,
      files,
    });
  });

  // ── Serve a file ────────────────────────────────────────────────────────
  app.get(`${prefix}/*`, async (c) => {
    // Extract the path after the prefix
    const requestPath = c.req.path.slice(prefix.length + 1);
    if (!requestPath) {
      return c.json({ error: 'No file path specified' }, 400);
    }

    // Decode URI components and sanitize path traversal
    const decoded = decodeURIComponent(requestPath);

    // Prevent directory traversal attacks
    const resolved = join(basePath, decoded);
    if (!resolved.startsWith(basePath)) {
      return c.json({ error: 'Access denied: path traversal detected' }, 403);
    }

    try {
      // Check if the file exists and is a file (not directory)
      const fileStat = await stat(resolved);
      if (!fileStat.isFile()) {
        return c.json({ error: 'Not a file' }, 400);
      }

      const content = await readFile(resolved);
      const mimeType = guessMimeType(resolved);

      c.header('Content-Type', mimeType);
      c.header('Content-Length', fileStat.size.toString());
      c.header('Content-Disposition', `inline; filename="${decoded.split('/').pop()}"`);
      // Allow cross-origin access for platform downloads
      c.header('Access-Control-Allow-Origin', '*');

      return c.body(content);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return c.json({ error: 'File not found' }, 404);
      }
      if (code === 'EACCES') {
        return c.json({ error: 'Access denied' }, 403);
      }
      console.error(`[fs/server] Error serving file: ${resolved}`, err);
      return c.json({ error: 'Internal server error' }, 500);
    }
  });

  return app;
}
