import { createBot, type BotConfig } from './bot.js';
import { createServer, type ServerConfig } from './server.js';
import { ChannelsService, type ChannelsServiceConfig } from './service.js';

export { createBot, type BotConfig } from './bot.js';
export { createChatInstance, readAdaptersFromEnv, type ChatInstanceDeps } from './bot.js';
export { createServer, type ServerConfig } from './server.js';
export { ChannelsService, type ChannelsServiceConfig } from './service.js';
export { OpenCodeClient, type OpenCodeClientConfig, type FileOutput, type StreamEvent } from './opencode.js';
export { SessionManager, type SessionStrategy } from './sessions.js';
export type { AdapterCredentials, AdapterModule, ReloadRequest, ReloadResult } from './types.js';

export async function start(
  botConfig?: BotConfig,
  serverConfig?: ServerConfig,
) {
  const service = new ChannelsService({
    opencodeUrl: botConfig?.opencodeUrl,
    botName: botConfig?.botName,
    agentName: botConfig?.agentName,
    systemPrompt: botConfig?.systemPrompt,
    model: botConfig?.model,
  });

  await service.init();

  const ready = await service.client.isReady();
  if (ready) {
    console.log(`[opencode-channels] OpenCode server is ready`);
  } else {
    console.warn(`[opencode-channels] OpenCode server not reachable — will retry on first message`);
  }

  const server = createServer(service, serverConfig);

  const cleanupInterval = setInterval(() => {
    service.sessions.cleanup();
  }, 5 * 60 * 1000);
  cleanupInterval.unref?.();

  return { bot: service.bot, client: service.client, server, service };
}

const entryFile = process.argv[1] ?? '';
const isDirectRun = entryFile.includes('opencode-channels') && (entryFile.endsWith('index.ts') || entryFile.endsWith('index.js'));
if (isDirectRun) {
  start().catch((err) => {
    console.error('[opencode-channels] Fatal:', err);
    process.exit(1);
  });
}
