/**
 * Unit tests for the Telegram MarkdownV2 conversion utility.
 */
import { markdownToTelegramV2, escapeMarkdownV2 } from '../src/telegram-api.js';

interface Test {
  name: string;
  input: string;
  check: (result: string) => boolean;
}

const tests: Test[] = [
  {
    name: 'Bold **text** converts to *text*',
    input: 'This is **bold** text',
    check: (r) => r.includes('*bold*') && !r.includes('**'),
  },
  {
    name: 'Italic *text* converts to _text_',
    input: 'This is *italic* text',
    check: (r) => r.includes('_italic_'),
  },
  {
    name: 'Inline code preserved',
    input: 'Use `console.log()` for debugging',
    check: (r) => r.includes('`') && r.includes('console'),
  },
  {
    name: 'Code block preserved with fences',
    input: '```javascript\nconst x = 1;\nconsole.log(x);\n```',
    check: (r) => r.startsWith('```') && r.endsWith('```') && r.includes('const x'),
  },
  {
    name: 'Code block content has ` and \\ escaped',
    input: '```\nconst s = `hello`;\n```',
    check: (r) => r.includes('\\`hello\\`'),
  },
  {
    name: 'Link [text](url) preserved',
    input: 'Visit [Google](https://google.com) now',
    check: (r) => r.includes('[Google](https://google.com)'),
  },
  {
    name: 'Special chars in plain text escaped: . ! + = |',
    input: 'Price: 5.00! Total + tax = $5.50',
    check: (r) => r.includes('\\.') && r.includes('\\!') && r.includes('\\+') && r.includes('\\='),
  },
  {
    name: 'Bullet list dashes escaped',
    input: '- Item one\n- Item two',
    check: (r) => r.includes('\\- Item one') && r.includes('\\- Item two'),
  },
  {
    name: 'Hash headers escaped',
    input: '# Hello World',
    check: (r) => r.includes('\\#'),
  },
  {
    name: 'Strikethrough ~~text~~ converts to ~text~',
    input: 'This is ~~deleted~~ text',
    check: (r) => r.includes('~deleted~') && !r.includes('~~'),
  },
  {
    name: 'Empty input produces empty output',
    input: '',
    check: (r) => r === '',
  },
  {
    name: 'Plain text with no markdown just escapes specials',
    input: 'Hello world',
    check: (r) => r === 'Hello world',
  },
  {
    name: 'Parentheses in plain text escaped',
    input: 'function foo(bar)',
    check: (r) => r.includes('\\(') && r.includes('\\)'),
  },
  {
    name: 'Bold + italic ***text*** converts to *_text_*',
    input: 'This is ***bold italic*** text',
    check: (r) => r.includes('*_bold italic_*') || r.includes('*_bold\\ italic_*'),
  },
  {
    name: 'Unclosed code block gets auto-closed',
    input: '```\nsome code',
    check: (r) => {
      const fences = r.match(/```/g);
      return fences != null && fences.length === 2;
    },
  },
  {
    name: 'escapeMarkdownV2 escapes all special chars',
    input: '',
    check: () => {
      const escaped = escapeMarkdownV2('_*[]()~`>#+-=|{}.!\\');
      return escaped === '\\_\\*\\[\\]\\(\\)\\~\\`\\>\\#\\+\\-\\=\\|\\{\\}\\.\\!\\\\';
    },
  },
];

let passed = 0;
let failed = 0;

for (const t of tests) {
  const result = t.name === 'escapeMarkdownV2 escapes all special chars'
    ? '' // check doesn't need result
    : markdownToTelegramV2(t.input);
  const ok = t.check(result);
  if (ok) {
    console.log(`  \x1b[32mPASS\x1b[0m  ${t.name}`);
    passed++;
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m  ${t.name}`);
    console.log(`    Input:  ${JSON.stringify(t.input)}`);
    console.log(`    Output: ${JSON.stringify(result)}`);
    failed++;
  }
}

console.log(`\n${passed}/${tests.length} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
