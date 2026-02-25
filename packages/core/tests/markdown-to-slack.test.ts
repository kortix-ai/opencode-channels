import { describe, it, expect } from 'vitest';
import { markdownToSlack } from '../src/lib/markdown-to-slack.js';

describe('markdownToSlack', () => {
  // ── Falsy inputs ──────────────────────────────────────────────────────

  it('returns empty string for empty input', () => {
    expect(markdownToSlack('')).toBe('');
  });

  it('returns undefined for undefined input', () => {
    // The function signature accepts string, but the guard `if (!md) return md`
    // will return undefined when called with undefined at runtime.
    expect(markdownToSlack(undefined as unknown as string)).toBeUndefined();
  });

  it('returns null for null input', () => {
    expect(markdownToSlack(null as unknown as string)).toBeNull();
  });

  // ── Code preservation ─────────────────────────────────────────────────

  it('preserves code blocks unchanged', () => {
    const input = '```\nconst x = **bold**;\n```';
    expect(markdownToSlack(input)).toBe(input);
  });

  it('preserves fenced code blocks with language tag', () => {
    const input = '```ts\nconst x = 1;\n```';
    expect(markdownToSlack(input)).toBe(input);
  });

  it('preserves inline code unchanged', () => {
    const input = 'Use `**not bold**` here';
    expect(markdownToSlack(input)).toBe('Use `**not bold**` here');
  });

  // ── Headings ──────────────────────────────────────────────────────────

  it('converts h1 heading to bold', () => {
    expect(markdownToSlack('# Title')).toBe('*Title*');
  });

  it('converts h2 heading to bold', () => {
    expect(markdownToSlack('## Subtitle')).toBe('*Subtitle*');
  });

  it('converts h3 heading to bold', () => {
    expect(markdownToSlack('### Section')).toBe('*Section*');
  });

  it('converts h4 heading to bold', () => {
    expect(markdownToSlack('#### Deep')).toBe('*Deep*');
  });

  it('converts h5 heading to bold', () => {
    expect(markdownToSlack('##### Deeper')).toBe('*Deeper*');
  });

  it('converts h6 heading to bold', () => {
    expect(markdownToSlack('###### Deepest')).toBe('*Deepest*');
  });

  // ── Bold ──────────────────────────────────────────────────────────────

  it('converts **bold** to *bold*', () => {
    expect(markdownToSlack('This is **bold** text')).toBe('This is *bold* text');
  });

  it('converts __bold__ to *bold*', () => {
    expect(markdownToSlack('This is __bold__ text')).toBe('This is *bold* text');
  });

  // ── Strikethrough ─────────────────────────────────────────────────────

  it('converts ~~strike~~ to ~strike~', () => {
    expect(markdownToSlack('This is ~~deleted~~ text')).toBe('This is ~deleted~ text');
  });

  // ── Links ─────────────────────────────────────────────────────────────

  it('converts [text](url) to <url|text>', () => {
    expect(markdownToSlack('[Google](https://google.com)')).toBe(
      '<https://google.com|Google>',
    );
  });

  it('converts link with complex text', () => {
    expect(markdownToSlack('[click here](https://example.com/path?q=1)')).toBe(
      '<https://example.com/path?q=1|click here>',
    );
  });

  // ── Horizontal rules ─────────────────────────────────────────────────

  it('converts --- to ───', () => {
    expect(markdownToSlack('---')).toBe('───');
  });

  it('converts *** to ───', () => {
    expect(markdownToSlack('***')).toBe('───');
  });

  it('converts ___ to ───', () => {
    expect(markdownToSlack('___')).toBe('───');
  });

  it('converts long horizontal rules', () => {
    expect(markdownToSlack('-----')).toBe('───');
    expect(markdownToSlack('*****')).toBe('───');
    expect(markdownToSlack('_____')).toBe('───');
  });

  // ── Code block protection ─────────────────────────────────────────────

  it('does NOT convert bold/italic inside code blocks', () => {
    const input = '```\n**bold** and __underline__ and ~~strike~~\n```';
    expect(markdownToSlack(input)).toBe(input);
  });

  it('does NOT convert headings inside code blocks', () => {
    const input = '```\n# Heading\n## Heading 2\n```';
    expect(markdownToSlack(input)).toBe(input);
  });

  it('does NOT convert links inside inline code', () => {
    const input = 'See `[link](http://example.com)` for info';
    expect(markdownToSlack(input)).toBe('See `[link](http://example.com)` for info');
  });

  // ── Mixed markdown ────────────────────────────────────────────────────

  it('handles mixed markdown: heading + bold + link + code in one string', () => {
    const input =
      '# Welcome\n\nThis is **important** and [click here](https://example.com).\n\nUse `npm install` to get started.';
    const expected =
      '*Welcome*\n\nThis is *important* and <https://example.com|click here>.\n\nUse `npm install` to get started.';
    expect(markdownToSlack(input)).toBe(expected);
  });

  // ── Multi-line with code blocks ───────────────────────────────────────

  it('handles multi-line markdown with code blocks and surrounding text', () => {
    const input = [
      '## Setup',
      '',
      'Run the following:',
      '',
      '```bash',
      'npm install **glob**',
      '```',
      '',
      'Then configure your [settings](https://example.com/settings).',
      '',
      '---',
      '',
      'That is ~~all~~ everything.',
    ].join('\n');

    const expected = [
      '*Setup*',
      '',
      'Run the following:',
      '',
      '```bash',
      'npm install **glob**',
      '```',
      '',
      'Then configure your <https://example.com/settings|settings>.',
      '',
      '───',
      '',
      'That is ~all~ everything.',
    ].join('\n');

    expect(markdownToSlack(input)).toBe(expected);
  });

  // ── Edge cases ────────────────────────────────────────────────────────

  it('leaves plain text untouched', () => {
    const input = 'Just some plain text with no markdown.';
    expect(markdownToSlack(input)).toBe(input);
  });

  it('handles multiple code blocks in same text', () => {
    const input = '```\nfirst\n```\nSome **bold**\n```\nsecond\n```';
    const expected = '```\nfirst\n```\nSome *bold*\n```\nsecond\n```';
    expect(markdownToSlack(input)).toBe(expected);
  });

  it('handles multiple inline code spans', () => {
    const input = 'Use `a` and `b` and **bold**';
    const expected = 'Use `a` and `b` and *bold*';
    expect(markdownToSlack(input)).toBe(expected);
  });
});
