import { createDiscordAdapter, type DiscordAdapter } from '@chat-adapter/discord';
import type { AdapterModule, DiscordCredentials } from '../types.js';

const discordModule: AdapterModule<DiscordCredentials> = {
  name: 'discord',

  readCredentialsFromEnv() {
    const botToken = process.env.DISCORD_BOT_TOKEN;
    const publicKey = process.env.DISCORD_PUBLIC_KEY;
    const applicationId = process.env.DISCORD_APPLICATION_ID;
    if (botToken && publicKey && applicationId) {
      const mentionRoleIds = process.env.DISCORD_MENTION_ROLE_IDS
        ?.split(',')
        .map((id) => id.trim())
        .filter(Boolean);
      return { botToken, publicKey, applicationId, mentionRoleIds };
    }
    return undefined;
  },

  createAdapter(credentials: DiscordCredentials) {
    const adapter = createDiscordAdapter({
      botToken: credentials.botToken,
      publicKey: credentials.publicKey,
      applicationId: credentials.applicationId,
      mentionRoleIds: credentials.mentionRoleIds,
    });

    startGateway(adapter);

    return adapter;
  },
};

function startGateway(adapter: DiscordAdapter): void {
  const controller = new AbortController();

  const options = {
    waitUntil: (task: Promise<unknown>) => {
      task.catch((err: unknown) => {
        console.error('[opencode-channels] Discord Gateway task failed:', err);
      });
    },
  };

  const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;

  adapter
    .startGatewayListener(options, TWENTY_FOUR_HOURS, controller.signal)
    .then(() => {
      console.log('[opencode-channels] Discord Gateway listener started');
    })
    .catch((err: unknown) => {
      console.error('[opencode-channels] Discord Gateway listener failed:', err);
    });

  const cleanup = () => controller.abort();
  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);
}

export default discordModule;
