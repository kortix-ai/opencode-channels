/**
 * Split a long message into chunks that respect a platform's maximum message
 * length, breaking at natural boundaries (paragraphs, sentences, words) and
 * avoiding splitting inside code blocks.
 */
export function splitMessage(text: string, maxLength: number): string[] {
  if (!text) {
    return [];
  }

  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    const splitAt = findSplitPoint(remaining, maxLength);
    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }

  return chunks.filter((c) => c.length > 0);
}

function findSplitPoint(text: string, maxLength: number): number {
  const segment = text.slice(0, maxLength);

  // Avoid splitting inside a code block
  const codeBlockCount = (segment.match(/```/g) || []).length;
  const insideCodeBlock = codeBlockCount % 2 !== 0;

  if (insideCodeBlock) {
    const lastCodeBlockStart = segment.lastIndexOf('```');
    if (lastCodeBlockStart > maxLength * 0.3) {
      return lastCodeBlockStart;
    }
  }

  // Prefer splitting at paragraph break
  const doubleNewline = segment.lastIndexOf('\n\n');
  if (doubleNewline > maxLength * 0.5) {
    return doubleNewline + 2;
  }

  // Then single newline
  const singleNewline = segment.lastIndexOf('\n');
  if (singleNewline > maxLength * 0.5) {
    return singleNewline + 1;
  }

  // Then sentence end
  const sentenceEnd = findLastSentenceEnd(segment);
  if (sentenceEnd > maxLength * 0.5) {
    return sentenceEnd;
  }

  // Then word boundary
  const lastSpace = segment.lastIndexOf(' ');
  if (lastSpace > maxLength * 0.5) {
    return lastSpace + 1;
  }

  // Hard split as a last resort
  return maxLength;
}

function findLastSentenceEnd(text: string): number {
  const sentencePattern = /[.!?]\s/g;
  let lastMatch = -1;
  let match: RegExpExecArray | null;

  while ((match = sentencePattern.exec(text)) !== null) {
    lastMatch = match.index + match[0].length;
  }

  return lastMatch;
}
