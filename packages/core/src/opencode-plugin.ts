/**
 * OpenCode Plugin entry point.
 *
 * This file exports a Plugin function compatible with OpenCode's plugin system.
 * Add "@opencode-channels/core" to the `"plugin"` array in opencode.json(c)
 * to auto-boot the channels system alongside OpenCode.
 *
 * The plugin:
 *   1. Starts the webhook server with all configured adapters.
 *   2. Listens for `session.idle` events to keep session bookkeeping fresh.
 *
 * Configuration is read from environment variables (see .env.example).
 *
 * Usage in opencode.jsonc:
 *   {
 *     "plugin": ["@opencode-channels/core"]
 *   }
 *
 * Or from a local path:
 *   {
 *     "plugin": ["./path/to/opencode-channels/packages/core/src/opencode-plugin.ts"]
 *   }
 */

import type { ChannelsPluginResult } from './plugin.js';
import type { ChannelAdapter } from './adapter.js';
import type { ChannelConfig } from './types.js';

// ─── Plugin type ────────────────────────────────────────────────────────────
// We define the Plugin type inline to avoid a hard dependency on
// @opencode-ai/plugin at runtime. If the user has the package installed,
// TypeScript will validate compatibility.

type PluginContext = {
  project: unknown;
  client: unknown;
  $: (strings: TemplateStringsArray, ...values: unknown[]) => unknown;
  directory: string;
  worktree: boolean;
};

type PluginHooks = {
  event?: (ctx: { event: { type: string; properties?: Record<string, unknown> } }) => Promise<void>;
  tool?: Record<string, unknown>;
};

type Plugin = (ctx: PluginContext) => Promise<PluginHooks>;

// ─── State ──────────────────────────────────────────────────────────────────

let channelsInstance: ChannelsPluginResult | null = null;

// ─── Plugin export ──────────────────────────────────────────────────────────

export const OpenCodeChannelsPlugin: Plugin = async (ctx) => {
  const { directory } = ctx;

  // Lazy-import to avoid loading heavy deps until the plugin is actually used
  const { startChannels, listChannelConfigs } = await import('./plugin.js');
  const { OpenCodeClient } = await import('./opencode-client.js');

  // Determine config from env
  const port = Number(process.env.CHANNELS_PORT) || 3456;
  const dbPath = process.env.CHANNELS_DB_PATH || `${directory}/channels.db`;
  const opencodeUrl = process.env.OPENCODE_URL || 'http://localhost:4096';

  // ── Adapter discovery ─────────────────────────────────────────────────
  // Attempt to load platform adapters if their packages are installed.
  // Uses dynamic import with package names so TypeScript doesn't try to
  // resolve cross-package paths at build time.

  const adapterMap: Record<string, ChannelAdapter> = {};
  let slackConfigsByTeamId: Map<string, ChannelConfig> | undefined;

  // Slack adapter — only loaded if SLACK_BOT_TOKEN is set and the package is available
  if (process.env.SLACK_BOT_TOKEN) {
    try {
      // Dynamic import using package name — TypeScript won't resolve this at
      // build time, so it doesn't cross rootDir boundaries.
      const slackPkg = '@opencode-channels/slack';
      const slackModule = await import(/* @vite-ignore */ slackPkg) as {
        SlackAdapter: new (opts: {
          getConfigByTeamId: (teamId: string) => ChannelConfig | undefined;
          getClient: (config: ChannelConfig) => InstanceType<typeof OpenCodeClient>;
        }) => ChannelAdapter;
      };

      const client = new OpenCodeClient({ baseUrl: opencodeUrl });
      const configsByTeamId = new Map<string, ChannelConfig>();

      const slackAdapter = new slackModule.SlackAdapter({
        getConfigByTeamId: (teamId: string) => configsByTeamId.get(teamId),
        getClient: () => client,
      });

      adapterMap.slack = slackAdapter;
      slackConfigsByTeamId = configsByTeamId;
    } catch {
      console.warn('[opencode-channels] @opencode-channels/slack not available, skipping Slack adapter');
    }
  }

  // ── Start channels system ─────────────────────────────────────────────

  try {
    channelsInstance = await startChannels({
      adapters: adapterMap,
      port,
      dbPath,
      opencodeUrl,
    });

    console.log(`[opencode-channels] Plugin started — webhook server on port ${port}`);

    // ── Populate Slack team lookup ────────────────────────────────────
    if (slackConfigsByTeamId && channelsInstance) {
      const slackConfigs = listChannelConfigs(
        { channelType: 'slack', enabled: true },
        channelsInstance.db,
      );

      for (const cfg of slackConfigs) {
        const teamId = (cfg.credentials as Record<string, unknown>)?.teamId as string;
        if (teamId) {
          slackConfigsByTeamId.set(teamId, cfg);
        }
      }

      if (slackConfigs.length > 0) {
        console.log(`[opencode-channels] Loaded ${slackConfigs.length} Slack config(s)`);
      }
    }
  } catch (err) {
    console.error('[opencode-channels] Failed to start:', err);
  }

  // ── Return hooks ──────────────────────────────────────────────────────

  return {
    event: async ({ event }) => {
      // Track session completion for bookkeeping
      if (event.type === 'session.idle') {
        // Could be used for metrics, cleanup, etc.
      }
    },
  };
};

// Default export for OpenCode plugin system compatibility
export default OpenCodeChannelsPlugin;

// ─── Cleanup helper (for tests / manual shutdown) ───────────────────────────

export function stopChannelsPlugin(): void {
  if (channelsInstance) {
    channelsInstance.stop();
    channelsInstance = null;
  }
}
