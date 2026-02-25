# opencode-channels

Standalone multi-platform channel adapters for [OpenCode](https://github.com/anomalyco/opencode). Turn any OpenCode instance into a chatbot for **Slack**, **Discord**, and **Telegram** with zero external dependencies.

## Features

- **Slack** adapter with full Block Kit, 22+ slash commands, reactions, file upload/download, threading, permissions UI
- **Discord** adapter with embeds, buttons, Ed25519 verification
- **Telegram** adapter with inline keyboards, markdown formatting
- **SQLite + Drizzle** for local storage (no Postgres/Supabase required)
- **SSE streaming** from OpenCode with real-time text deltas
- **Session management** with 4 strategies: `single`, `per-thread`, `per-user`, `per-message`
- **Rate limiting**, message queuing, and credential encryption (AES-256-GCM)
- **Slack Manifest API** auto-configuration (zero manual URL setup)
- **OpenCode plugin** format for seamless integration

## Architecture

```
opencode-channels/
  packages/
    core/         # Types, engine, OpenCode client, SQLite DB, plugin system
    slack/        # Slack adapter (Block Kit, commands, reactions, interactivity)
    discord/      # Discord adapter (embeds, buttons, Ed25519)
    telegram/     # Telegram adapter (inline keyboards, markdown)
    fs/           # File ingestion and output detection
  apps/
    cli/          # CLI tool (setup wizard, start server, status)
  scripts/
    e2e-slack.ts  # Interactive E2E test (boots full system)
    e2e-test.ts   # Automated E2E test suite
    setup-e2e.sh  # Environment setup script
```

### Message flow

```
Platform (Slack/Discord/Telegram)
  --> ngrok/tunnel
    --> Webhook Server (Hono)
      --> Signature Verification
        --> Adapter.normalize()
          --> Engine.processMessage()
            --> SessionManager.resolve() (SQLite cache)
              --> OpenCodeClient.promptStreaming() (SSE)
                --> Text delta accumulation
              <-- Response assembled
            --> Adapter.sendResponse() (Block Kit / embeds / markdown)
          <-- Done
```

## Quick Start

### 1. Install

```bash
git clone https://github.com/kortix-ai/opencode-channels.git
cd opencode-channels
pnpm install
```

### 2. Configure

```bash
cp .env.example .env.test
# Edit .env.test with your credentials
```

Required environment variables:

| Variable | Description |
|----------|-------------|
| `OPENCODE_URL` | URL of your OpenCode server (default: `http://localhost:1707`) |
| `SLACK_BOT_TOKEN` | Slack bot OAuth token (`xoxb-...`) |
| `SLACK_SIGNING_SECRET` | Slack app signing secret |

Optional:

| Variable | Description |
|----------|-------------|
| `SLACK_APP_ID` | For Manifest API auto-configuration |
| `SLACK_CONFIG_REFRESH_TOKEN` | Config token for Manifest API |
| `CHANNELS_PORT` | Webhook server port (default: `3456`) |
| `CHANNELS_DB_PATH` | SQLite database path |
| `CHANNELS_CREDENTIAL_KEY` | 64-char hex key for AES-256-GCM encryption |

### 3. Start OpenCode

```bash
opencode serve --port 1707
```

### 4. Start a tunnel

```bash
ngrok http 3456
```

### 5. Run

```bash
# Interactive mode (auto-configures Slack manifest)
pnpm e2e:slack

# Or use the CLI
npx tsx apps/cli/src/index.ts start
```

## OpenCode Plugin Integration

opencode-channels can run as an [OpenCode plugin](https://opencode.ai/docs/plugins), starting automatically alongside your OpenCode server.

### Option A: Add to `opencode.jsonc`

```jsonc
{
  "plugin": ["./path/to/opencode-channels/packages/core/src/opencode-plugin.ts"]
}
```

### Option B: Use as npm package

```jsonc
{
  "plugin": ["@opencode-channels/core"]
}
```

### Option C: Programmatic usage

```typescript
import { startChannels, createChannelConfig } from '@opencode-channels/core';
import { SlackAdapter } from '@opencode-channels/slack';

const slackAdapter = new SlackAdapter({
  getConfigByTeamId: (teamId) => configs.get(teamId),
  getClient: () => opencodeClient,
});

const channels = await startChannels({
  adapters: { slack: slackAdapter },
  port: 3456,
  dbPath: './channels.db',
});

// Create a channel config
await createChannelConfig({
  channelType: 'slack',
  name: 'My Workspace',
  enabled: true,
  credentials: {
    botToken: process.env.SLACK_BOT_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
  },
  platformConfig: { groups: { requireMention: true } },
  metadata: {},
  sessionStrategy: 'per-user',
  systemPrompt: null,
  agentName: null,
}, channels.db);
```

## Slack Commands Reference

All commands are available via `/oc` or `/opencode`:

| Command | Description |
|---------|-------------|
| `/oc help` | Show all available commands |
| `/oc <question>` | Ask the AI agent a question |
| `/oc models` | List all available AI models |
| `/oc agents` | List all available agents |
| `/oc status` | Show system status and session info |
| `/oc share` | Generate a shareable link for the current session |
| `/oc diff` | Show git diff for the current session |
| `/oc link` | Check workspace link status |
| `/oc config set <prompt>` | Set the system prompt for this channel |
| `/oc config clear` | Clear the system prompt |
| `/oc config show` | Show the current system prompt |
| `/oc export` | Export channel conversation as markdown |
| `/oc search <query>` | Search messages in the workspace |
| `/oc find <query>` | Search files in the workspace |
| `/oc whois <@user>` | Look up a Slack user's profile |
| `/oc channel create <name>` | Create a new Slack channel |
| `/oc channel topic <text>` | Set the channel topic |
| `/oc channel archive` | Archive the current channel |
| `/oc dm <@user> <message>` | Send a DM via the bot |
| `/oc pin` | Pin the last bot message |
| `/oc unpin` | Unpin the last bot message |
| `/oc pins` | List pinned messages |
| `/oc team` | Show team/workspace info |
| `/oc bookmark <url> [title]` | Add a channel bookmark |
| `/oc bookmarks` | List channel bookmarks |

### Inline commands (in messages)

Prefix your @mention with these to override per-message:

- `!model <provider>/<model>` — Use a specific model for this message
- `!agent <name>` — Route to a specific agent
- `!reset` — Reset (clear) the current session

### Reaction triggers

React to a bot message with:

- :arrows_counterclockwise: — Retry the last response
- :floppy_disk: — Save the response to memory
- :memo: — Summarize the thread

## Development

### Run tests

```bash
# Unit tests (619 tests across 28 files)
pnpm test

# Watch mode
pnpm test:watch

# Type checking
pnpm lint
```

### E2E testing

```bash
# One-time setup
./scripts/setup-e2e.sh

# Automated E2E tests (boots system, runs assertions, exits)
pnpm e2e:test

# Interactive E2E (boots system, waits for Slack events)
pnpm e2e:slack
```

### Slack App Setup

#### Automatic (recommended)

1. Create a Slack app at [api.slack.com/apps](https://api.slack.com/apps)
2. Get a [config token](https://api.slack.com/authentication/config-tokens)
3. Set `SLACK_APP_ID` and `SLACK_CONFIG_REFRESH_TOKEN` in `.env.test`
4. Run `pnpm e2e:slack` — URLs are auto-configured via Manifest API

The config refresh token is single-use and auto-rotated on each run. The new token is persisted back to `.env.test`.

#### Manual

Set your Slack app URLs to:

| Setting | URL |
|---------|-----|
| Events Request URL | `https://<ngrok-url>/slack/events` |
| Slash Commands | `https://<ngrok-url>/slack/commands` |
| Interactivity | `https://<ngrok-url>/slack/interactivity` |

Required bot scopes: `app_mentions:read`, `channels:history`, `channels:read`, `channels:join`, `chat:write`, `commands`, `files:read`, `files:write`, `groups:history`, `groups:read`, `im:history`, `im:read`, `im:write`, `reactions:read`, `reactions:write`, `users:read`, `pins:read`, `pins:write`, `bookmarks:read`, `bookmarks:write`, `search:read`

Required event subscriptions: `app_mention`, `message.channels`, `message.groups`, `message.im`, `reaction_added`

## Packages

| Package | Description |
|---------|-------------|
| `@opencode-channels/core` | Types, engine, OpenCode SSE client, SQLite DB, plugin system |
| `@opencode-channels/slack` | Slack adapter: Block Kit, 22+ commands, reactions, interactivity, Manifest API |
| `@opencode-channels/discord` | Discord adapter: embeds, buttons, Ed25519 verification |
| `@opencode-channels/telegram` | Telegram adapter: inline keyboards, Bot API |
| `@opencode-channels/fs` | File ingestion, output detection, file server |
| `@opencode-channels/cli` | CLI: setup wizard, start server, status |

## License

MIT
