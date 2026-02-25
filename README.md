# opencode-channels

Connect [OpenCode](https://github.com/anomalyco/opencode) to **Slack**, **Discord**, and **Telegram**. One command to set up, one command to run.

## Setup (30 seconds)

```bash
# 1. Clone and install
git clone https://github.com/kortix-ai/opencode-channels.git
cd opencode-channels && pnpm install

# 2. Make sure OpenCode is running
opencode serve

# 3. Start a tunnel
ngrok http 3456

# 4. Init (auto-detects OpenCode, asks for Slack creds, configures everything)
npx opencode-channels init

# 5. Run
npx opencode-channels start
```

That's it. @mention your bot in Slack and it responds via OpenCode.

## What it does

Your Slack messages hit a local webhook server, get routed to your OpenCode instance via SSE streaming, and responses come back as Block Kit messages. Everything stays local — SQLite for storage, no external databases.

```
Slack @mention → ngrok → Webhook Server → OpenCode (SSE) → Response → Slack
```

### Features

- 22+ slash commands (`/oc help`, `/oc models`, `/oc diff`, `/oc export`, etc.)
- Per-message model/agent switching (`!model anthropic/claude-sonnet-4-20250514`)
- Reaction triggers (retry, save, summarize)
- File upload/download, Block Kit formatting, threading
- Session strategies: `single`, `per-thread`, `per-user`, `per-message`
- Rate limiting, credential encryption (AES-256-GCM)
- Slack Manifest API auto-configuration (zero manual URL setup)

## CLI Commands

```bash
npx opencode-channels init       # One-time setup wizard
npx opencode-channels start      # Start the webhook server
npx opencode-channels status     # Check what's running
npx opencode-channels setup slack # Advanced Slack setup with more options
```

## OpenCode Plugin

You can also run it as an OpenCode plugin — it starts automatically with your server:

```jsonc
// opencode.jsonc
{
  "plugin": ["./path/to/opencode-channels/packages/core/src/opencode-plugin.ts"]
}
```

Set `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET` in your environment and it auto-discovers the Slack adapter.

## Programmatic Usage

```typescript
import { startChannels, createChannelConfig } from '@opencode-channels/core';
import { SlackAdapter } from '@opencode-channels/slack';

const channels = await startChannels({
  adapters: {
    slack: new SlackAdapter({
      getConfigByTeamId: (teamId) => configs.get(teamId),
      getClient: () => opencodeClient,
    }),
  },
  port: 3456,
});
```

## Slack Commands

| Command | What it does |
|---------|-------------|
| `/oc <question>` | Ask the AI |
| `/oc help` | Show all commands |
| `/oc models` | List available models |
| `/oc agents` | List available agents |
| `/oc status` | System status |
| `/oc diff` | Git diff for current session |
| `/oc share` | Share session link |
| `/oc export` | Export conversation as markdown |
| `/oc config set <prompt>` | Set channel system prompt |
| `/oc search <query>` | Search messages |
| `/oc find <query>` | Search files |
| `/oc dm <@user> <msg>` | DM someone via bot |
| `/oc pin` / `unpin` / `pins` | Pin management |
| `/oc channel create <name>` | Create channel |
| `/oc bookmark <url>` | Add bookmark |
| `/oc whois <@user>` | User lookup |
| `/oc team` | Workspace info |

**Inline:** `!model provider/model`, `!agent name`, `!reset`

**Reactions:** :arrows_counterclockwise: retry, :floppy_disk: save, :memo: summarize

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SLACK_BOT_TOKEN` | Yes | — | Bot OAuth token (`xoxb-...`) |
| `SLACK_SIGNING_SECRET` | Yes | — | App signing secret |
| `OPENCODE_URL` | No | `http://localhost:4096` | OpenCode server URL |
| `CHANNELS_PORT` | No | `3456` | Webhook server port |
| `SLACK_APP_ID` | No | — | For Manifest API auto-config |
| `SLACK_CONFIG_REFRESH_TOKEN` | No | — | For Manifest API auto-config |
| `CHANNELS_DB_PATH` | No | `./channels.db` | SQLite database path |
| `CHANNELS_CREDENTIAL_KEY` | No | — | AES-256-GCM encryption key (64 hex chars) |

## Development

```bash
pnpm test          # 619 tests across 28 files
pnpm test:watch    # Watch mode
pnpm lint          # Type check

# E2E testing
./scripts/setup-e2e.sh     # One-time env setup
pnpm e2e:test               # Automated E2E tests
pnpm e2e:slack              # Interactive E2E (boots system, waits for Slack events)
```

### Slack App Setup

**Automatic** (recommended): Set `SLACK_APP_ID` and `SLACK_CONFIG_REFRESH_TOKEN`, then `init` or `start` will auto-configure URLs via the Manifest API. The refresh token is single-use and auto-rotated.

**Manual**: Set these URLs in your [Slack app dashboard](https://api.slack.com/apps):
- Events: `https://<tunnel>/slack/events`
- Commands: `https://<tunnel>/slack/commands`
- Interactivity: `https://<tunnel>/slack/interactivity`

Required scopes: `app_mentions:read`, `channels:history`, `channels:read`, `channels:join`, `chat:write`, `commands`, `files:read`, `files:write`, `groups:history`, `groups:read`, `im:history`, `im:read`, `im:write`, `reactions:read`, `reactions:write`, `users:read`, `pins:read`, `pins:write`, `bookmarks:read`, `bookmarks:write`, `search:read`

## Packages

| Package | Description |
|---------|-------------|
| `@opencode-channels/core` | Engine, OpenCode SSE client, SQLite, plugin system |
| `@opencode-channels/slack` | Block Kit, 22+ commands, reactions, Manifest API |
| `@opencode-channels/discord` | Embeds, buttons, Ed25519 verification |
| `@opencode-channels/telegram` | Inline keyboards, Bot API |
| `@opencode-channels/fs` | File ingestion, output detection |
| `@opencode-channels/cli` | CLI: init, start, status |

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
    cli/          # CLI: init, start, status, setup
  scripts/
    e2e-slack.ts  # Interactive E2E test
    e2e-test.ts   # Automated E2E test suite
    setup-e2e.sh  # Dev environment setup
```

## License

MIT
