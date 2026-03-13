import type { AdapterModule } from './types.js';
import slackModule from './slack/index.js';
import discordModule from './discord/index.js';
import telegramModule from './telegram/index.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const adapterModules: AdapterModule<any>[] = [slackModule, discordModule, telegramModule];
