/**
 * Convert standard Markdown to Slack's mrkdwn format.
 *
 * Preserves code blocks and inline code, converts headings to bold,
 * maps bold/italic/strikethrough/links to Slack equivalents.
 */
export function markdownToSlack(md: string): string {
  if (!md) return md;

  // Preserve code blocks
  const codeBlocks: string[] = [];
  let text = md.replace(/```[\s\S]*?```/g, (match) => {
    codeBlocks.push(match);
    return `\x00CODEBLOCK_${codeBlocks.length - 1}\x00`;
  });

  // Preserve inline code
  const inlineCode: string[] = [];
  text = text.replace(/`[^`]+`/g, (match) => {
    inlineCode.push(match);
    return `\x00INLINE_${inlineCode.length - 1}\x00`;
  });

  // Headings → bold
  text = text.replace(/^#{1,6}\s+(.+)$/gm, '*$1*');

  // Bold (** and __)
  text = text.replace(/\*\*(.+?)\*\*/g, '*$1*');
  text = text.replace(/__(.+?)__/g, '*$1*');

  // Strikethrough
  text = text.replace(/~~(.+?)~~/g, '~$1~');

  // Links
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>');

  // Horizontal rules
  text = text.replace(/^[-*_]{3,}$/gm, '───');

  // Restore inline code
  text = text.replace(/\x00INLINE_(\d+)\x00/g, (_, idx) => inlineCode[Number(idx)]);

  // Restore code blocks
  text = text.replace(/\x00CODEBLOCK_(\d+)\x00/g, (_, idx) => codeBlocks[Number(idx)]);

  return text;
}
