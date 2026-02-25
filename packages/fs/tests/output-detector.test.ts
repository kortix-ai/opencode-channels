import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { StreamEvent } from '@opencode-channels/core';
import {
  collectFilesFromEvents,
  detectNewFiles,
  downloadDetectedFile,
  downloadDetectedFiles,
  snapshotModifiedFiles,
} from '../src/output-detector.js';
import type { DetectedFile } from '../src/output-detector.js';

// ─── Mock client ─────────────────────────────────────────────────────────────

function createMockClient() {
  return {
    getModifiedFiles: vi.fn<[], Promise<Array<{ name: string; path: string }>>>(),
    downloadFile: vi.fn<[string], Promise<Buffer | null>>(),
    downloadFileByPath: vi.fn<[string], Promise<Buffer | null>>(),
  };
}

type MockClient = ReturnType<typeof createMockClient>;

let mockClient: MockClient;

beforeEach(() => {
  mockClient = createMockClient();
});

// ─── collectFilesFromEvents ──────────────────────────────────────────────────

describe('collectFilesFromEvents', () => {
  it('returns empty array for empty events', () => {
    expect(collectFilesFromEvents([])).toEqual([]);
  });

  it('returns empty array for non-file events', () => {
    const events: StreamEvent[] = [
      { type: 'text', data: 'hello' },
      { type: 'busy' },
      { type: 'done' },
      { type: 'error', data: 'oops' },
    ];
    expect(collectFilesFromEvents(events)).toEqual([]);
  });

  it('collects file events with url', () => {
    const events: StreamEvent[] = [
      {
        type: 'file',
        file: { name: 'output.png', url: 'https://example.com/output.png', mimeType: 'image/png' },
      },
    ];

    const result = collectFilesFromEvents(events);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      name: 'output.png',
      path: 'https://example.com/output.png',
      url: 'https://example.com/output.png',
      mimeType: 'image/png',
      source: 'sse',
    });
  });

  it('collects file events with name only (no url)', () => {
    const events: StreamEvent[] = [
      {
        type: 'file',
        file: { name: 'local-file.txt', url: '', mimeType: 'text/plain' },
      },
    ];

    const result = collectFilesFromEvents(events);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('local-file.txt');
    // When url is falsy, path/url fall back to name
    expect(result[0].url).toBe('local-file.txt');
  });

  it('deduplicates by url', () => {
    const events: StreamEvent[] = [
      {
        type: 'file',
        file: { name: 'file.png', url: 'https://example.com/file.png' },
      },
      {
        type: 'file',
        file: { name: 'file.png', url: 'https://example.com/file.png' },
      },
    ];

    const result = collectFilesFromEvents(events);
    expect(result).toHaveLength(1);
  });

  it('skips file events with no url and no name', () => {
    const events: StreamEvent[] = [
      {
        type: 'file',
        file: { name: '', url: '' },
      },
    ];

    const result = collectFilesFromEvents(events);
    expect(result).toEqual([]);
  });

  it('skips file events with no file property', () => {
    const events: StreamEvent[] = [
      { type: 'file' } as StreamEvent,
    ];

    const result = collectFilesFromEvents(events);
    expect(result).toEqual([]);
  });

  it('deduplicates by name when url and name differ', () => {
    const events: StreamEvent[] = [
      {
        type: 'file',
        file: { name: 'report.pdf', url: '/workspace/report.pdf' },
      },
      {
        type: 'file',
        file: { name: 'report.pdf', url: 'https://cdn.example.com/report.pdf' },
      },
    ];

    const result = collectFilesFromEvents(events);
    // First event is collected; second is skipped because "report.pdf" name was already seen
    expect(result).toHaveLength(1);
    expect(result[0].url).toBe('/workspace/report.pdf');
  });

  it('collects multiple distinct files', () => {
    const events: StreamEvent[] = [
      { type: 'text', data: 'Working...' },
      {
        type: 'file',
        file: { name: 'a.png', url: '/a.png', mimeType: 'image/png' },
      },
      { type: 'busy' },
      {
        type: 'file',
        file: { name: 'b.json', url: '/b.json', mimeType: 'application/json' },
      },
      { type: 'done' },
    ];

    const result = collectFilesFromEvents(events);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('a.png');
    expect(result[1].name).toBe('b.json');
  });
});

// ─── detectNewFiles ──────────────────────────────────────────────────────────

describe('detectNewFiles', () => {
  it('returns empty array when client errors', async () => {
    mockClient.getModifiedFiles.mockRejectedValue(new Error('connection refused'));

    const result = await detectNewFiles(mockClient as any, []);

    expect(result).toEqual([]);
  });

  it('returns all files as new when beforeFiles is empty', async () => {
    mockClient.getModifiedFiles.mockResolvedValue([
      { name: 'new1.txt', path: '/workspace/new1.txt' },
      { name: 'new2.png', path: '/workspace/new2.png' },
    ]);

    const result = await detectNewFiles(mockClient as any, []);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      name: 'new1.txt',
      path: '/workspace/new1.txt',
      url: '/workspace/new1.txt',
      mimeType: 'text/plain',
      source: 'git-status',
    });
    expect(result[1].name).toBe('new2.png');
    expect(result[1].mimeType).toBe('image/png');
  });

  it('excludes files that existed in beforeFiles (by path)', async () => {
    const beforeFiles = [
      { name: 'existing.txt', path: '/workspace/existing.txt' },
    ];

    mockClient.getModifiedFiles.mockResolvedValue([
      { name: 'existing.txt', path: '/workspace/existing.txt' },
      { name: 'brand-new.txt', path: '/workspace/brand-new.txt' },
    ]);

    const result = await detectNewFiles(mockClient as any, beforeFiles);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('brand-new.txt');
  });

  it('excludes files that match beforeFiles by name', async () => {
    const beforeFiles = [
      { name: 'readme.md', path: '/old-path/readme.md' },
    ];

    mockClient.getModifiedFiles.mockResolvedValue([
      { name: 'readme.md', path: '/workspace/readme.md' },
    ]);

    const result = await detectNewFiles(mockClient as any, beforeFiles);

    // Matched by name even though path differs
    expect(result).toEqual([]);
  });

  it('guesses mimeType from file extension', async () => {
    mockClient.getModifiedFiles.mockResolvedValue([
      { name: 'report.pdf', path: '/workspace/report.pdf' },
      { name: 'photo.jpg', path: '/workspace/photo.jpg' },
      { name: 'data.csv', path: '/workspace/data.csv' },
      { name: 'noext', path: '/workspace/noext' },
    ]);

    const result = await detectNewFiles(mockClient as any, []);

    expect(result[0].mimeType).toBe('application/pdf');
    expect(result[1].mimeType).toBe('image/jpeg');
    expect(result[2].mimeType).toBe('text/csv');
    expect(result[3].mimeType).toBeUndefined();
  });
});

// ─── downloadDetectedFile ────────────────────────────────────────────────────

describe('downloadDetectedFile', () => {
  const file: DetectedFile = {
    name: 'output.png',
    path: '/workspace/output.png',
    url: 'https://example.com/output.png',
    mimeType: 'image/png',
    source: 'sse',
  };

  it('returns result when first download (downloadFile) succeeds', async () => {
    const content = Buffer.from('PNG_DATA');
    mockClient.downloadFile.mockResolvedValue(content);

    const result = await downloadDetectedFile(mockClient as any, file);

    expect(result).not.toBeNull();
    expect(result!.name).toBe('output.png');
    expect(result!.content).toBe(content);
    expect(result!.mimeType).toBe('image/png');
    expect(mockClient.downloadFile).toHaveBeenCalledWith('https://example.com/output.png');
    // Should not have called fallbacks
    expect(mockClient.downloadFileByPath).not.toHaveBeenCalled();
  });

  it('falls back to downloadFileByPath(path) when downloadFile returns null', async () => {
    const content = Buffer.from('FALLBACK_DATA');
    mockClient.downloadFile.mockResolvedValue(null);
    mockClient.downloadFileByPath.mockResolvedValueOnce(content);

    const result = await downloadDetectedFile(mockClient as any, file);

    expect(result).not.toBeNull();
    expect(result!.content).toBe(content);
    expect(mockClient.downloadFile).toHaveBeenCalledWith('https://example.com/output.png');
    expect(mockClient.downloadFileByPath).toHaveBeenCalledWith('/workspace/output.png');
  });

  it('falls back to downloadFileByPath(name) as last resort', async () => {
    const content = Buffer.from('LAST_RESORT');
    mockClient.downloadFile.mockResolvedValue(null);
    // First call with path returns null, second call with name returns content
    mockClient.downloadFileByPath
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(content);

    const result = await downloadDetectedFile(mockClient as any, file);

    expect(result).not.toBeNull();
    expect(result!.content).toBe(content);
    expect(mockClient.downloadFileByPath).toHaveBeenCalledWith('/workspace/output.png');
    expect(mockClient.downloadFileByPath).toHaveBeenCalledWith('output.png');
  });

  it('returns null when all download attempts fail', async () => {
    mockClient.downloadFile.mockResolvedValue(null);
    mockClient.downloadFileByPath.mockResolvedValue(null);

    const result = await downloadDetectedFile(mockClient as any, file);

    expect(result).toBeNull();
  });

  it('returns null on exception from downloadFile', async () => {
    mockClient.downloadFile.mockRejectedValue(new Error('network error'));

    const result = await downloadDetectedFile(mockClient as any, file);

    expect(result).toBeNull();
  });

  it('skips path fallback when path === url', async () => {
    const samePathFile: DetectedFile = {
      name: 'output.txt',
      path: '/workspace/output.txt',
      url: '/workspace/output.txt',
      source: 'git-status',
    };

    const content = Buffer.from('OK');
    mockClient.downloadFile.mockResolvedValue(null);
    // Since path === url, it should skip the first downloadFileByPath(path)
    // and go directly to downloadFileByPath(name)
    mockClient.downloadFileByPath.mockResolvedValueOnce(content);

    const result = await downloadDetectedFile(mockClient as any, samePathFile);

    expect(result).not.toBeNull();
    // Should only have called downloadFileByPath once (with name), not twice
    expect(mockClient.downloadFileByPath).toHaveBeenCalledTimes(1);
    expect(mockClient.downloadFileByPath).toHaveBeenCalledWith('output.txt');
  });
});

// ─── downloadDetectedFiles ───────────────────────────────────────────────────

describe('downloadDetectedFiles', () => {
  it('returns empty array for empty input', async () => {
    const results = await downloadDetectedFiles(mockClient as any, []);
    expect(results).toEqual([]);
  });

  it('returns only successful downloads', async () => {
    const files: DetectedFile[] = [
      { name: 'a.txt', path: '/a.txt', url: '/a.txt', source: 'sse' },
      { name: 'b.txt', path: '/b.txt', url: '/b.txt', source: 'sse' },
      { name: 'c.txt', path: '/c.txt', url: '/c.txt', source: 'sse' },
    ];

    // a succeeds, b fails, c succeeds
    mockClient.downloadFile
      .mockResolvedValueOnce(Buffer.from('A'))
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(Buffer.from('C'));

    // b will try fallbacks too — make them fail
    mockClient.downloadFileByPath.mockResolvedValue(null);

    const results = await downloadDetectedFiles(mockClient as any, files);

    expect(results).toHaveLength(2);
    expect(results[0].name).toBe('a.txt');
    expect(results[1].name).toBe('c.txt');
  });
});

// ─── snapshotModifiedFiles ───────────────────────────────────────────────────

describe('snapshotModifiedFiles', () => {
  it('returns client.getModifiedFiles() result', async () => {
    const files = [
      { name: 'modified.ts', path: '/workspace/modified.ts' },
    ];
    mockClient.getModifiedFiles.mockResolvedValue(files);

    const result = await snapshotModifiedFiles(mockClient as any);

    expect(result).toEqual(files);
    expect(mockClient.getModifiedFiles).toHaveBeenCalledOnce();
  });

  it('returns empty array on error', async () => {
    mockClient.getModifiedFiles.mockRejectedValue(new Error('connection refused'));

    const result = await snapshotModifiedFiles(mockClient as any);

    expect(result).toEqual([]);
  });
});
