/**
 * OpenCode plugin that registers optional file management tools.
 *
 * This is NOT needed for the basic channel flow (the engine handles files
 * directly). Register this plugin for enhanced file management capabilities
 * within the agent itself (listing uploads, cleaning up temp files, etc.).
 */

import type { Plugin, Hooks } from '@opencode-ai/plugin';
import { tool } from '@opencode-ai/plugin/tool';
import { readdir, stat, rm, mkdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

const DEFAULT_UPLOAD_DIR = '/tmp/channel-uploads';

/**
 * Recursively list files in a directory, up to maxDepth.
 */
async function listDir(
  dir: string,
  maxDepth: number = 3,
  depth: number = 0,
): Promise<Array<{ name: string; path: string; size: number }>> {
  if (depth >= maxDepth) return [];
  const results: Array<{ name: string; path: string; size: number }> = [];

  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        const sub = await listDir(fullPath, maxDepth, depth + 1);
        results.push(...sub);
      } else if (entry.isFile()) {
        try {
          const s = await stat(fullPath);
          results.push({ name: entry.name, path: fullPath, size: s.size });
        } catch {
          // skip unreadable files
        }
      }
    }
  } catch {
    // directory doesn't exist or not readable
  }

  return results;
}

/**
 * Format byte size to human-readable string.
 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

const filePlugin: Plugin = async (input) => {
  const uploadDir = process.env.CHANNEL_UPLOAD_DIR || DEFAULT_UPLOAD_DIR;

  const hooks: Hooks = {
    tool: {
      /**
       * List files in the channel upload directory.
       */
      channel_file_list: tool({
        description:
          'List files in the channel upload directory. Shows files that were uploaded by users through chat channels (Slack, Discord, Telegram, etc.).',
        args: {
          directory: tool.schema
            .string()
            .optional()
            .describe(
              'Directory to list files from. Defaults to the channel upload directory.',
            ),
        },
        async execute(args, _context) {
          const dir = args.directory || uploadDir;
          const files = await listDir(dir);

          if (files.length === 0) {
            return `No files found in ${dir}`;
          }

          const lines = files.map(
            (f) => `- ${f.name} (${formatSize(f.size)}) → ${f.path}`,
          );

          return `Files in ${dir} (${files.length} total):\n${lines.join('\n')}`;
        },
      }),

      /**
       * Clean up temporary files from the upload directory.
       */
      channel_file_cleanup: tool({
        description:
          'Clean up temporary files from the channel upload directory. Removes files older than a specified age to free up disk space.',
        args: {
          maxAgeMinutes: tool.schema
            .number()
            .optional()
            .describe(
              'Maximum file age in minutes. Files older than this will be deleted. Defaults to 60.',
            ),
          directory: tool.schema
            .string()
            .optional()
            .describe(
              'Directory to clean up. Defaults to the channel upload directory.',
            ),
        },
        async execute(args, _context) {
          const dir = args.directory || uploadDir;
          const maxAge = (args.maxAgeMinutes ?? 60) * 60 * 1000; // to ms
          const cutoff = Date.now() - maxAge;

          const files = await listDir(dir, 1);
          let removed = 0;
          let freedBytes = 0;

          for (const file of files) {
            try {
              const s = await stat(file.path);
              if (s.mtimeMs < cutoff) {
                await rm(file.path);
                removed++;
                freedBytes += s.size;
              }
            } catch {
              // skip files that can't be accessed
            }
          }

          return `Cleanup complete: removed ${removed} file(s), freed ${formatSize(freedBytes)}`;
        },
      }),
    },
  };

  return hooks;
};

export default filePlugin;
