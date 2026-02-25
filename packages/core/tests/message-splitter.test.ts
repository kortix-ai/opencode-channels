import { describe, it, expect } from 'vitest';
import { splitMessage } from '../src/lib/message-splitter.js';

describe('splitMessage', () => {
  // ── Empty / short inputs ──────────────────────────────────────────────

  it('returns [] for empty string', () => {
    expect(splitMessage('', 100)).toEqual([]);
  });

  it('returns [] for undefined input', () => {
    expect(splitMessage(undefined as unknown as string, 100)).toEqual([]);
  });

  it('returns [text] when shorter than maxLength', () => {
    expect(splitMessage('hello', 100)).toEqual(['hello']);
  });

  it('returns [text] when exactly maxLength', () => {
    const text = 'a'.repeat(100);
    expect(splitMessage(text, 100)).toEqual([text]);
  });

  // ── Paragraph boundary split ──────────────────────────────────────────

  it('splits at paragraph boundary (\\n\\n)', () => {
    // Build text with a \n\n in the second half of the first maxLength chars
    const para1 = 'A'.repeat(60);
    const para2 = 'B'.repeat(60);
    const text = `${para1}\n\n${para2}`;
    const maxLength = 100;

    const chunks = splitMessage(text, maxLength);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // First chunk should end at or before the paragraph break
    expect(chunks[0]).not.toContain('B');
  });

  // ── Single newline split ──────────────────────────────────────────────

  it('splits at single newline when no \\n\\n available', () => {
    // No double newlines, but a single newline in the second half
    const line1 = 'A'.repeat(60);
    const line2 = 'B'.repeat(60);
    const text = `${line1}\n${line2}`;
    const maxLength = 100;

    const chunks = splitMessage(text, maxLength);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // The split should happen at or near the newline
    expect(chunks[0].endsWith('A'.repeat(60))).toBe(true);
  });

  // ── Sentence boundary split ───────────────────────────────────────────

  it('splits at sentence end (. followed by space)', () => {
    // 60 chars of sentence + ". " + another sentence, no newlines
    const sentence1 = 'A'.repeat(58) + '. ';
    const sentence2 = 'B'.repeat(60);
    const text = sentence1 + sentence2;
    const maxLength = 80;

    const chunks = splitMessage(text, maxLength);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // First chunk should contain the sentence ending
    expect(chunks[0]).toContain('.');
  });

  it('splits at sentence end (! followed by space)', () => {
    const text = 'A'.repeat(58) + '! ' + 'B'.repeat(60);
    const chunks = splitMessage(text, 80);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0]).toContain('!');
  });

  it('splits at sentence end (? followed by space)', () => {
    const text = 'A'.repeat(58) + '? ' + 'B'.repeat(60);
    const chunks = splitMessage(text, 80);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0]).toContain('?');
  });

  // ── Word boundary split ───────────────────────────────────────────────

  it('splits at word boundary (space) when no better option', () => {
    // Long text with spaces but no newlines or sentence ends in range
    const words = Array(30).fill('word').join(' '); // "word word word..." 
    const maxLength = 50;

    const chunks = splitMessage(words, maxLength);
    expect(chunks.length).toBeGreaterThan(1);
    // Each chunk should end on a word boundary (no partial words at end)
    for (const chunk of chunks) {
      expect(chunk).not.toMatch(/\s$/); // trimEnd in implementation
    }
  });

  // ── Hard split ────────────────────────────────────────────────────────

  it('hard-splits a very long word with no spaces at maxLength', () => {
    const longWord = 'x'.repeat(200);
    const maxLength = 80;

    const chunks = splitMessage(longWord, maxLength);
    expect(chunks.length).toBeGreaterThan(1);
    // First chunk should be exactly maxLength (hard split)
    expect(chunks[0].length).toBe(maxLength);
    // Rejoined should equal original
    expect(chunks.join('')).toBe(longWord);
  });

  // ── Code block protection ─────────────────────────────────────────────

  it('does NOT split inside a code block', () => {
    // Build text where the maxLength boundary would land inside a code block.
    // The code block starts at position 40 and extends well past maxLength.
    const before = 'A'.repeat(40);
    const codeBlock = '```\n' + 'x'.repeat(80) + '\n```';
    const text = before + codeBlock;
    // maxLength (60) would land inside the code block
    const maxLength = 60;

    const chunks = splitMessage(text, maxLength);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // The first chunk should split BEFORE the code block starts (at the ```)
    // so it should not contain any part of the code block content
    expect(chunks[0]).not.toContain('xxx');
  });

  // ── Text that is entirely a code block ────────────────────────────────

  it('handles text that is all one code block', () => {
    const text = '```\n' + 'A'.repeat(200) + '\n```';
    const maxLength = 100;

    const chunks = splitMessage(text, maxLength);
    expect(chunks.length).toBeGreaterThan(1);
    // All content should be preserved
    expect(chunks.join(' ').replace(/\s+/g, '')).toContain('A'.repeat(200));
  });

  // ── Multiple splits ───────────────────────────────────────────────────

  it('multiple splits produce correct number of chunks covering full text', () => {
    const text = Array(10)
      .fill('This is a paragraph of reasonable length that should be split.')
      .join('\n\n');
    const maxLength = 100;

    const chunks = splitMessage(text, maxLength);
    expect(chunks.length).toBeGreaterThan(2);
    // Every chunk respects the limit
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(maxLength);
    }
  });

  // ── No data loss ──────────────────────────────────────────────────────

  it('all chunks concatenated cover the full original text (no data loss)', () => {
    const text = 'Hello world. This is a test. Foo bar baz.\n\nAnother paragraph here with more words.\n\nAnd a third one.';
    const maxLength = 50;

    const chunks = splitMessage(text, maxLength);

    // Rejoin with a space (since trimStart/trimEnd may drop whitespace at boundaries)
    // and compare normalized whitespace
    const originalNormalized = text.replace(/\s+/g, ' ').trim();
    const chunksNormalized = chunks.join(' ').replace(/\s+/g, ' ').trim();
    expect(chunksNormalized).toBe(originalNormalized);
  });

  it('preserves all content characters across splits (no-loss check)', () => {
    // Use a known text without tricky whitespace
    const text = 'abcdefghij'.repeat(15); // 150 chars, no spaces
    const maxLength = 40;

    const chunks = splitMessage(text, maxLength);
    expect(chunks.join('')).toBe(text);
  });

  // ── Edge cases ────────────────────────────────────────────────────────

  it('handles single character text', () => {
    expect(splitMessage('x', 100)).toEqual(['x']);
  });

  it('handles text of exactly 1 char with maxLength 1', () => {
    expect(splitMessage('x', 1)).toEqual(['x']);
  });
});
