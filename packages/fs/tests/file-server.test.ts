import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import { guessMimeType, createFileServer } from '../src/file-server.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = join(os.tmpdir(), `fs-server-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ─── guessMimeType ───────────────────────────────────────────────────────────

describe('guessMimeType', () => {
  it.each([
    ['script.js', 'application/javascript'],
    ['module.ts', 'application/typescript'],
    ['page.html', 'text/html'],
    ['style.css', 'text/css'],
    ['config.json', 'application/json'],
    ['photo.png', 'image/png'],
    ['photo.jpg', 'image/jpeg'],
    ['document.pdf', 'application/pdf'],
    ['data.csv', 'text/csv'],
    ['archive.zip', 'application/zip'],
    ['song.mp3', 'audio/mpeg'],
    ['video.mp4', 'video/mp4'],
    ['readme.md', 'text/markdown'],
    ['image.svg', 'image/svg+xml'],
    ['image.webp', 'image/webp'],
    ['image.gif', 'image/gif'],
  ])('"%s" returns "%s"', (filename, expected) => {
    expect(guessMimeType(filename)).toBe(expected);
  });

  it('returns "application/octet-stream" for unknown extension', () => {
    expect(guessMimeType('file.xyz123')).toBe('application/octet-stream');
  });

  it('returns "application/octet-stream" for no extension', () => {
    expect(guessMimeType('Makefile')).toBe('application/octet-stream');
  });

  it('handles uppercase extension by lowercasing', () => {
    expect(guessMimeType('IMAGE.PNG')).toBe('image/png');
    expect(guessMimeType('SCRIPT.JS')).toBe('application/javascript');
    expect(guessMimeType('doc.PDF')).toBe('application/pdf');
  });
});

// ─── createFileServer ────────────────────────────────────────────────────────

describe('createFileServer', () => {
  it('GET /files/list returns file listing', async () => {
    // Create some test files
    await writeFile(join(tmpDir, 'hello.txt'), 'hello world');
    await writeFile(join(tmpDir, 'data.json'), '{"key":"value"}');

    const app = createFileServer({ basePath: tmpDir, routePrefix: '/files' });

    const res = await app.request('/files/list');
    expect(res.status).toBe(200);

    const body = await res.json() as { basePath: string; count: number; files: Array<{ name: string; path: string; size: number; mimeType: string }> };
    expect(body.basePath).toBe(tmpDir);
    expect(body.count).toBe(2);

    const names = body.files.map((f: { name: string }) => f.name).sort();
    expect(names).toEqual(['data.json', 'hello.txt']);

    // Verify mimeType is present
    const txtFile = body.files.find((f: { name: string }) => f.name === 'hello.txt');
    expect(txtFile?.mimeType).toBe('text/plain');
  });

  it('GET /files/* serves file content with correct headers', async () => {
    const content = 'file content here';
    await writeFile(join(tmpDir, 'serve-me.txt'), content);

    const app = createFileServer({ basePath: tmpDir, routePrefix: '/files' });

    const res = await app.request('/files/serve-me.txt');
    expect(res.status).toBe(200);

    expect(res.headers.get('content-type')).toBe('text/plain');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');

    const body = await res.text();
    expect(body).toBe(content);
  });

  it('serves files from subdirectories', async () => {
    const subDir = join(tmpDir, 'sub');
    await mkdir(subDir, { recursive: true });
    await writeFile(join(subDir, 'nested.txt'), 'nested content');

    const app = createFileServer({ basePath: tmpDir, routePrefix: '/files' });

    const res = await app.request('/files/sub/nested.txt');
    expect(res.status).toBe(200);

    const body = await res.text();
    expect(body).toBe('nested content');
  });

  it('path traversal (../) returns 403', async () => {
    const app = createFileServer({ basePath: tmpDir, routePrefix: '/files' });

    // Hono normalizes "../" in URL paths, so we use URL-encoded dots to
    // bypass URL normalization while still triggering decodeURIComponent
    // in the handler. Use a raw Request to avoid any client-side normalization.
    const res = await app.request(
      new Request(`http://localhost/files/..%2F..%2F..%2Fetc%2Fpasswd`),
    );
    // The resolved path should be outside basePath
    expect(res.status).toBe(403);

    const body = await res.json() as { error: string };
    expect(body.error).toContain('path traversal');
  });

  it('non-existent file returns 404', async () => {
    const app = createFileServer({ basePath: tmpDir, routePrefix: '/files' });

    const res = await app.request('/files/does-not-exist.txt');
    expect(res.status).toBe(404);

    const body = await res.json() as { error: string };
    expect(body.error).toContain('not found');
  });

  it('directory path returns 400 (not a file)', async () => {
    const subDir = join(tmpDir, 'a-directory');
    await mkdir(subDir, { recursive: true });

    const app = createFileServer({ basePath: tmpDir, routePrefix: '/files' });

    const res = await app.request('/files/a-directory');
    expect(res.status).toBe(400);

    const body = await res.json() as { error: string };
    expect(body.error).toContain('Not a file');
  });

  it('uses default routePrefix /files when not specified', async () => {
    await writeFile(join(tmpDir, 'default.txt'), 'default');

    const app = createFileServer({ basePath: tmpDir });

    const res = await app.request('/files/default.txt');
    expect(res.status).toBe(200);
  });

  it('file listing skips hidden files and node_modules', async () => {
    await writeFile(join(tmpDir, '.hidden'), 'hidden');
    await writeFile(join(tmpDir, 'visible.txt'), 'visible');
    await mkdir(join(tmpDir, 'node_modules'), { recursive: true });
    await writeFile(join(tmpDir, 'node_modules', 'dep.js'), 'dep');

    const app = createFileServer({ basePath: tmpDir, routePrefix: '/files' });

    const res = await app.request('/files/list');
    const body = await res.json() as { files: Array<{ name: string }> };

    const names = body.files.map((f: { name: string }) => f.name);
    expect(names).toContain('visible.txt');
    expect(names).not.toContain('.hidden');
    expect(names).not.toContain('dep.js');
  });

  it('returns 400 when no file path is specified after prefix', async () => {
    const app = createFileServer({ basePath: tmpDir, routePrefix: '/files' });

    // The wildcard route GET /files/* matches /files/ with empty path
    const res = await app.request('/files/');
    // This should hit the "No file path specified" branch
    expect(res.status).toBe(400);
  });
});
