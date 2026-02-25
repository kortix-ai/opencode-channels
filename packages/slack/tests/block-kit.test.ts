import { describe, it, expect } from 'vitest';
import { buildBlockKitMessage, type UsageMetadata } from '../src/block-kit.js';

// ─── buildBlockKitMessage ───────────────────────────────────────────────────

describe('buildBlockKitMessage', () => {
  // ── Simple text ─────────────────────────────────────────────────────────

  describe('simple text', () => {
    it('produces a section block for simple text', () => {
      const blocks = buildBlockKitMessage('Hello, world!');
      const sectionBlocks = blocks.filter((b) => b.type === 'section');
      expect(sectionBlocks.length).toBeGreaterThanOrEqual(1);
      expect(sectionBlocks[0].text?.type).toBe('mrkdwn');
      expect(sectionBlocks[0].text?.text).toContain('Hello, world!');
    });

    it('converts markdown bold to Slack bold', () => {
      const blocks = buildBlockKitMessage('This is **bold** text');
      const sectionBlocks = blocks.filter((b) => b.type === 'section');
      expect(sectionBlocks.length).toBeGreaterThanOrEqual(1);
      // markdownToSlack converts **bold** -> *bold*
      expect(sectionBlocks[0].text?.text).toContain('*bold*');
    });
  });

  // ── Code blocks ─────────────────────────────────────────────────────────

  describe('code blocks', () => {
    it('wraps code blocks in section blocks with code formatting', () => {
      const markdown = '```\nconsole.log("hello");\n```';
      const blocks = buildBlockKitMessage(markdown);
      const sectionBlocks = blocks.filter((b) => b.type === 'section');
      expect(sectionBlocks.length).toBeGreaterThanOrEqual(1);
      expect(sectionBlocks[0].text?.text).toContain('```');
      expect(sectionBlocks[0].text?.text).toContain('console.log("hello");');
    });

    it('handles code block with language specifier', () => {
      const markdown = '```typescript\nconst x: number = 1;\n```';
      const blocks = buildBlockKitMessage(markdown);
      const sectionBlocks = blocks.filter((b) => b.type === 'section');
      expect(sectionBlocks.length).toBeGreaterThanOrEqual(1);
      expect(sectionBlocks[0].text?.text).toContain('const x: number = 1;');
    });
  });

  // ── Mixed content ─────────────────────────────────────────────────────

  describe('mixed content', () => {
    it('creates separate blocks for text and code', () => {
      const markdown = 'Here is some text\n\n```\ncode here\n```\n\nMore text after';
      const blocks = buildBlockKitMessage(markdown);
      const sectionBlocks = blocks.filter((b) => b.type === 'section');
      expect(sectionBlocks.length).toBeGreaterThanOrEqual(2);
    });

    it('handles horizontal rules as divider blocks', () => {
      const markdown = 'Before\n\n---\n\nAfter';
      const blocks = buildBlockKitMessage(markdown);
      const dividerBlocks = blocks.filter((b) => b.type === 'divider');
      // At least the content divider (the --- in markdown), plus the footer divider
      expect(dividerBlocks.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── Footer (session URL) ──────────────────────────────────────────────

  describe('session URL in footer', () => {
    it('includes a session URL in footer context block', () => {
      const blocks = buildBlockKitMessage('Hello', 'https://example.com/session/123');
      const contextBlocks = blocks.filter((b) => b.type === 'context');
      expect(contextBlocks.length).toBe(1);

      const elements = contextBlocks[0].elements as Array<{ type: string; text: string }>;
      const linkElement = elements.find((e) => e.text.includes('View full session'));
      expect(linkElement).toBeDefined();
      expect(linkElement?.text).toContain('https://example.com/session/123');
    });

    it('does not include a context block with session URL when none is provided', () => {
      const blocks = buildBlockKitMessage('Hello');
      const contextBlocks = blocks.filter((b) => b.type === 'context');
      expect(contextBlocks.length).toBe(0);
    });
  });

  // ── Footer (usage metadata) ───────────────────────────────────────────

  describe('usage metadata in footer', () => {
    it('includes modelName in footer', () => {
      const usageMeta: UsageMetadata = { modelName: 'claude-3-sonnet' };
      const blocks = buildBlockKitMessage('Hello', undefined, usageMeta);
      const contextBlocks = blocks.filter((b) => b.type === 'context');
      expect(contextBlocks.length).toBe(1);

      const elements = contextBlocks[0].elements as Array<{ type: string; text: string }>;
      const metaElement = elements.find((e) => e.text.includes('claude-3-sonnet'));
      expect(metaElement).toBeDefined();
    });

    it('includes durationMs formatted as seconds in footer', () => {
      const usageMeta: UsageMetadata = { durationMs: 2500 };
      const blocks = buildBlockKitMessage('Hello', undefined, usageMeta);
      const contextBlocks = blocks.filter((b) => b.type === 'context');
      expect(contextBlocks.length).toBe(1);

      const elements = contextBlocks[0].elements as Array<{ type: string; text: string }>;
      const metaElement = elements.find((e) => e.text.includes('2.5s'));
      expect(metaElement).toBeDefined();
    });

    it('includes both modelName and durationMs separated by dot', () => {
      const usageMeta: UsageMetadata = { modelName: 'gpt-4o', durationMs: 1000 };
      const blocks = buildBlockKitMessage('Hello', undefined, usageMeta);
      const contextBlocks = blocks.filter((b) => b.type === 'context');
      expect(contextBlocks.length).toBe(1);

      const elements = contextBlocks[0].elements as Array<{ type: string; text: string }>;
      const metaElement = elements.find((e) => e.text.includes('gpt-4o') && e.text.includes('1.0s'));
      expect(metaElement).toBeDefined();
      // Middle dot separator
      expect(metaElement?.text).toContain('\u00b7');
    });

    it('includes both session URL and usage metadata', () => {
      const usageMeta: UsageMetadata = { modelName: 'gpt-4o', durationMs: 3000 };
      const blocks = buildBlockKitMessage('Hello', 'https://example.com/s/1', usageMeta);
      const contextBlocks = blocks.filter((b) => b.type === 'context');
      expect(contextBlocks.length).toBe(1);

      const elements = contextBlocks[0].elements as Array<{ type: string; text: string }>;
      expect(elements.length).toBe(2);
      expect(elements[0].text).toContain('gpt-4o');
      expect(elements[1].text).toContain('View full session');
    });

    it('no footer when no sessionUrl and no usageMeta', () => {
      const blocks = buildBlockKitMessage('Hello');
      const contextBlocks = blocks.filter((b) => b.type === 'context');
      expect(contextBlocks.length).toBe(0);
      const dividerBlocks = blocks.filter((b) => b.type === 'divider');
      expect(dividerBlocks.length).toBe(0);
    });

    it('no footer when usageMeta is empty object', () => {
      const blocks = buildBlockKitMessage('Hello', undefined, {});
      const contextBlocks = blocks.filter((b) => b.type === 'context');
      expect(contextBlocks.length).toBe(0);
    });
  });

  // ── MAX_BLOCKS limit ──────────────────────────────────────────────────

  describe('MAX_BLOCKS limit', () => {
    it('caps content blocks at 48 (MAX_BLOCKS - 2)', () => {
      // Generate many paragraphs to exceed the block limit
      const paragraphs = Array.from({ length: 60 }, (_, i) => `Paragraph ${i + 1}`).join('\n\n');
      const blocks = buildBlockKitMessage(paragraphs, 'https://example.com/s');

      // Total blocks should be at most 50 (48 content + divider + context)
      expect(blocks.length).toBeLessThanOrEqual(50);
    });

    it('still includes footer even when content is at the limit', () => {
      const paragraphs = Array.from({ length: 60 }, (_, i) => `Paragraph ${i + 1}`).join('\n\n');
      const blocks = buildBlockKitMessage(paragraphs, 'https://example.com/s');

      const contextBlocks = blocks.filter((b) => b.type === 'context');
      expect(contextBlocks.length).toBe(1);
    });
  });

  // ── Empty / edge cases ────────────────────────────────────────────────

  describe('empty and edge cases', () => {
    it('handles empty markdown with no footer', () => {
      const blocks = buildBlockKitMessage('');
      // Should produce at least a fallback section
      expect(blocks.length).toBeGreaterThanOrEqual(1);
      const sectionBlocks = blocks.filter((b) => b.type === 'section');
      expect(sectionBlocks.length).toBeGreaterThanOrEqual(1);
    });

    it('handles empty markdown with session URL', () => {
      const blocks = buildBlockKitMessage('', 'https://example.com/session/1');
      const sectionBlocks = blocks.filter((b) => b.type === 'section');
      expect(sectionBlocks.length).toBeGreaterThanOrEqual(1);
      const contextBlocks = blocks.filter((b) => b.type === 'context');
      expect(contextBlocks.length).toBe(1);
    });

    it('handles whitespace-only markdown', () => {
      const blocks = buildBlockKitMessage('   \n\n   ');
      // Should produce a fallback section block
      expect(blocks.length).toBeGreaterThanOrEqual(1);
    });

    it('all blocks have a type property', () => {
      const blocks = buildBlockKitMessage(
        '# Title\n\nSome text\n\n```\ncode\n```',
        'https://example.com',
        { modelName: 'test', durationMs: 100 },
      );
      for (const block of blocks) {
        expect(block).toHaveProperty('type');
        expect(typeof block.type).toBe('string');
      }
    });

    it('section blocks use mrkdwn text type', () => {
      const blocks = buildBlockKitMessage('Hello');
      const sectionBlocks = blocks.filter((b) => b.type === 'section');
      for (const block of sectionBlocks) {
        expect(block.text?.type).toBe('mrkdwn');
      }
    });

    it('truncates very long text in a single block', () => {
      // Create text longer than MAX_TEXT_LENGTH (3000)
      const longText = 'a'.repeat(4000);
      const blocks = buildBlockKitMessage(longText);
      const sectionBlocks = blocks.filter((b) => b.type === 'section');
      expect(sectionBlocks.length).toBeGreaterThanOrEqual(1);
      // The text should be truncated to MAX_TEXT_LENGTH
      expect(sectionBlocks[0].text!.text.length).toBeLessThanOrEqual(3000);
      expect(sectionBlocks[0].text!.text.endsWith('...')).toBe(true);
    });
  });
});
