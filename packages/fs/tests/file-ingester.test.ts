import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFile, mkdir, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import {
  ingestFile,
  ingestFiles,
  buildFileParts,
  buildFilePartsBase64,
} from '../src/file-ingester.js';
import type { IngestedFile } from '../src/file-ingester.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = join(os.tmpdir(), `fs-ingester-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ─── ingestFile ──────────────────────────────────────────────────────────────

describe('ingestFile', () => {
  it('returns null when url is undefined', async () => {
    const result = await ingestFile({ name: 'test.txt' }, { uploadDir: tmpDir });
    expect(result).toBeNull();
  });

  it('returns null when url is empty string', async () => {
    const result = await ingestFile({ url: '', name: 'test.txt' }, { uploadDir: tmpDir });
    expect(result).toBeNull();
  });

  it('decodes a data URL and saves to disk', async () => {
    const content = 'Hello, World!';
    const base64 = Buffer.from(content).toString('base64');
    const dataUrl = `data:text/plain;base64,${base64}`;

    const result = await ingestFile(
      { url: dataUrl, name: 'hello.txt', mimeType: 'text/plain' },
      { uploadDir: tmpDir },
    );

    expect(result).not.toBeNull();
    expect(result!.originalName).toBe('hello.txt');
    expect(result!.mimeType).toBe('text/plain');
    expect(result!.size).toBe(content.length);
    expect(result!.savedPath).toContain(tmpDir);

    // Verify file was actually written to disk
    const onDisk = await readFile(result!.savedPath, 'utf-8');
    expect(onDisk).toBe(content);
  });

  it('infers name from data URL mime when no name given', async () => {
    const base64 = Buffer.from('PNG_DATA').toString('base64');
    const dataUrl = `data:image/png;base64,${base64}`;

    const result = await ingestFile(
      { url: dataUrl },
      { uploadDir: tmpDir },
    );

    expect(result).not.toBeNull();
    expect(result!.originalName).toBe('file.png');
    expect(result!.mimeType).toBe('image/png');
  });

  it('downloads an HTTP URL and saves to disk', async () => {
    const bodyContent = 'downloaded content';
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(bodyContent, {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await ingestFile(
      { url: 'https://example.com/file.txt', name: 'remote.txt' },
      { uploadDir: tmpDir },
    );

    expect(fetchMock).toHaveBeenCalledWith('https://example.com/file.txt', expect.objectContaining({
      signal: expect.any(AbortSignal),
    }));
    expect(result).not.toBeNull();
    expect(result!.originalName).toBe('remote.txt');
    expect(result!.mimeType).toBe('text/plain');
    expect(result!.size).toBe(bodyContent.length);

    const onDisk = await readFile(result!.savedPath, 'utf-8');
    expect(onDisk).toBe(bodyContent);

    vi.unstubAllGlobals();
  });

  it('returns null for unknown scheme (ftp://)', async () => {
    const result = await ingestFile(
      { url: 'ftp://example.com/file.txt', name: 'test.txt' },
      { uploadDir: tmpDir },
    );
    expect(result).toBeNull();
  });

  it('returns null on download failure (non-200)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('Not Found', { status: 404, statusText: 'Not Found' }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await ingestFile(
      { url: 'https://example.com/missing.txt', name: 'missing.txt' },
      { uploadDir: tmpDir },
    );

    expect(result).toBeNull();

    vi.unstubAllGlobals();
  });

  it('returns null on fetch network error', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network error'));
    vi.stubGlobal('fetch', fetchMock);

    const result = await ingestFile(
      { url: 'https://example.com/fail.txt', name: 'fail.txt' },
      { uploadDir: tmpDir },
    );

    expect(result).toBeNull();

    vi.unstubAllGlobals();
  });

  it('uses custom uploadDir', async () => {
    const customDir = join(tmpDir, 'custom-uploads');

    const base64 = Buffer.from('data').toString('base64');
    const dataUrl = `data:text/plain;base64,${base64}`;

    const result = await ingestFile(
      { url: dataUrl, name: 'test.txt' },
      { uploadDir: customDir },
    );

    expect(result).not.toBeNull();
    expect(result!.savedPath).toContain(customDir);
  });

  it('infers filename from HTTP URL path when no name given', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('body', {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await ingestFile(
      { url: 'https://example.com/docs/report.pdf' },
      { uploadDir: tmpDir },
    );

    expect(result).not.toBeNull();
    expect(result!.originalName).toBe('report.pdf');

    vi.unstubAllGlobals();
  });
});

// ─── ingestFiles ─────────────────────────────────────────────────────────────

describe('ingestFiles', () => {
  it('returns empty array for empty input', async () => {
    const results = await ingestFiles([], { uploadDir: tmpDir });
    expect(results).toEqual([]);
  });

  it('returns only successful ingestions (mixed success/failure)', async () => {
    // First call (data URL) succeeds, second (bad scheme) returns null
    const base64 = Buffer.from('ok').toString('base64');
    const dataUrl = `data:text/plain;base64,${base64}`;

    const results = await ingestFiles(
      [
        { url: dataUrl, name: 'good.txt' },
        { url: 'ftp://bad.com/file', name: 'bad.txt' },
        { url: undefined, name: 'no-url.txt' },
      ],
      { uploadDir: tmpDir },
    );

    expect(results).toHaveLength(1);
    expect(results[0].originalName).toBe('good.txt');
  });

  it('processes multiple valid files', async () => {
    const b1 = Buffer.from('file1').toString('base64');
    const b2 = Buffer.from('file2').toString('base64');

    const results = await ingestFiles(
      [
        { url: `data:text/plain;base64,${b1}`, name: 'one.txt' },
        { url: `data:text/plain;base64,${b2}`, name: 'two.txt' },
      ],
      { uploadDir: tmpDir },
    );

    expect(results).toHaveLength(2);
    expect(results[0].originalName).toBe('one.txt');
    expect(results[1].originalName).toBe('two.txt');
  });
});

// ─── buildFileParts ──────────────────────────────────────────────────────────

describe('buildFileParts', () => {
  it('maps files to correct format', () => {
    const files: IngestedFile[] = [
      { originalName: 'test.png', savedPath: '/tmp/uploads/123-test.png', mimeType: 'image/png', size: 1024 },
      { originalName: 'data.json', savedPath: '/tmp/uploads/456-data.json', mimeType: 'application/json', size: 512 },
    ];

    const parts = buildFileParts(files);

    expect(parts).toHaveLength(2);

    expect(parts[0]).toEqual({
      type: 'file',
      mime: 'image/png',
      url: 'file:///tmp/uploads/123-test.png',
      filename: 'test.png',
    });

    expect(parts[1]).toEqual({
      type: 'file',
      mime: 'application/json',
      url: 'file:///tmp/uploads/456-data.json',
      filename: 'data.json',
    });
  });

  it('uses "application/octet-stream" when mimeType is missing', () => {
    const files: IngestedFile[] = [
      { originalName: 'mystery.bin', savedPath: '/tmp/uploads/mystery.bin', mimeType: undefined, size: 256 },
    ];

    const parts = buildFileParts(files);

    expect(parts[0].mime).toBe('application/octet-stream');
  });

  it('returns empty array for empty input', () => {
    const parts = buildFileParts([]);
    expect(parts).toEqual([]);
  });
});

// ─── buildFilePartsBase64 ────────────────────────────────────────────────────

describe('buildFilePartsBase64', () => {
  it('reads file from disk and encodes as base64 data URL', async () => {
    const content = 'Hello Base64!';
    const filePath = join(tmpDir, 'test-base64.txt');
    await writeFile(filePath, content);

    const files: IngestedFile[] = [
      { originalName: 'test.txt', savedPath: filePath, mimeType: 'text/plain', size: content.length },
    ];

    const parts = await buildFilePartsBase64(files);

    expect(parts).toHaveLength(1);
    expect(parts[0].type).toBe('file');
    expect(parts[0].mime).toBe('text/plain');
    expect(parts[0].filename).toBe('test.txt');

    // Verify the data URL contains correct base64
    const expectedBase64 = Buffer.from(content).toString('base64');
    expect(parts[0].url).toBe(`data:text/plain;base64,${expectedBase64}`);
  });

  it('uses "application/octet-stream" for missing mimeType', async () => {
    const filePath = join(tmpDir, 'no-mime.bin');
    await writeFile(filePath, 'binary data');

    const files: IngestedFile[] = [
      { originalName: 'no-mime.bin', savedPath: filePath, mimeType: undefined, size: 11 },
    ];

    const parts = await buildFilePartsBase64(files);

    expect(parts).toHaveLength(1);
    expect(parts[0].mime).toBe('application/octet-stream');
    expect(parts[0].url).toContain('data:application/octet-stream;base64,');
  });

  it('skips files that cannot be read', async () => {
    const files: IngestedFile[] = [
      { originalName: 'missing.txt', savedPath: join(tmpDir, 'nonexistent.txt'), mimeType: 'text/plain', size: 100 },
    ];

    const parts = await buildFilePartsBase64(files);

    expect(parts).toEqual([]);
  });

  it('returns empty array for empty input', async () => {
    const parts = await buildFilePartsBase64([]);
    expect(parts).toEqual([]);
  });

  it('skips unreadable files but includes readable ones', async () => {
    const filePath = join(tmpDir, 'readable.txt');
    await writeFile(filePath, 'I exist');

    const files: IngestedFile[] = [
      { originalName: 'readable.txt', savedPath: filePath, mimeType: 'text/plain', size: 7 },
      { originalName: 'missing.txt', savedPath: join(tmpDir, 'ghost.txt'), mimeType: 'text/plain', size: 5 },
    ];

    const parts = await buildFilePartsBase64(files);

    expect(parts).toHaveLength(1);
    expect(parts[0].filename).toBe('readable.txt');
  });
});
