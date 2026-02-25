# opencode-channels

Connect [OpenCode](https://github.com/anomalyco/opencode) to **Slack** as a chatbot. Built on the [Vercel Chat SDK](https://github.com/nichochar/chat) for native streaming, reactions, and slash commands.

```
Slack @mention --> ngrok --> Chat SDK Webhook --> OpenCode (SSE) --> Streamed Response --> Slack
```

## Quick Start

```bash
# 1. Clone and install
git clone https://github.com/kortix-ai/opencode-channels.git
cd opencode-channels && pnpm install

# 2. Start OpenCode (in your project directory)
opencode serve --port 1707

# 3. Run the setup wizard
npx tsx scripts/e2e-slack.ts
```

The wizard walks you through everything: env vars, ngrok tunnel, Slack app manifest, and boots the bot with a smoke test.

## How It Works

When someone @mentions the bot in Slack:

1. Slack sends a webhook to the Chat SDK handler
2. Bot posts a `_Thinking..._` placeholder with an hourglass reaction
3. Creates/reuses an OpenCode session for that thread
4. Streams the response via SSE, editing the placeholder every 600ms
5. Final edit removes the trailing indicator, swaps hourglass for checkmark
6. If new files were created, uploads them to the thread

Multi-turn conversations work automatically -- replies in a thread reuse the same OpenCode session.

## Commands

### Slash Commands

| Command | Description |
|---------|-------------|
| `/oc help` | Show all commands |
| `/oc models` | List available models |
| `/oc model <name>` | Switch model |
| `/oc agents` | List available agents |
| `/oc agent <name>` | Switch agent |
| `/oc status` | Connection status |
| `/oc reset` | Reset all sessions |
| `/oc diff` | Show recent file changes |
| `/oc link` | Share session link |
| `/oc <question>` | Ask the agent directly |

### In-Thread Commands

| Command | Description |
|---------|-------------|
| `!reset` | Reset this thread's session |
| `!model <name>` | Switch model |
| `!agent <name>` | Switch agent |
| `!help` | Show help |

### Reactions

| Reaction | Action |
|----------|--------|
| :arrows_counterclockwise: | Retry the message |

## Setup

### Prerequisites

- **Node.js** >= 18
- **OpenCode** server running (`opencode serve --port 1707`)
- **ngrok** or another tunnel for public webhooks
- A **Slack app** with a Bot Token and Signing Secret

### Environment Variables

Create a `.env.test` file (or copy `.env.example`):

```bash
# Required
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_SIGNING_SECRET=your-signing-secret

# Optional
OPENCODE_URL=http://localhost:1707    # Default OpenCode server
PORT=3456                              # Webhook server port

# Optional — enables auto-manifest config
SLACK_APP_ID=A0YOUR_APP_ID
SLACK_CONFIG_REFRESH_TOKEN=xoxe-1-your-refresh-token
```

### Slack App Configuration

**Automatic** (recommended): Set `SLACK_APP_ID` and `SLACK_CONFIG_REFRESH_TOKEN`. The setup wizard and bot auto-configure all URLs via the Slack Manifest API. The refresh token is single-use and auto-rotated.

**Manual**: Set these URLs in your [Slack app dashboard](https://api.slack.com/apps):

- **Event Subscriptions**: `https://<tunnel>/api/webhooks/slack`
- **Slash Commands**: `/oc` and `/opencode` pointing to `https://<tunnel>/api/webhooks/slack`
- **Interactivity**: `https://<tunnel>/api/webhooks/slack`

All routes point to the same endpoint -- the Chat SDK handles routing internally.

**Required Bot Token Scopes**: `app_mentions:read`, `channels:history`, `channels:read`, `chat:write`, `chat:write.public`, `commands`, `files:read`, `files:write`, `groups:history`, `groups:read`, `im:history`, `im:read`, `im:write`, `mpim:history`, `mpim:read`, `reactions:read`, `reactions:write`, `users:read`

**Required Event Subscriptions**: `app_mention`, `message.channels`, `message.groups`, `message.im`, `message.mpim`, `reaction_added`

## Setup Wizard

The interactive wizard handles the full setup:

```bash
npx tsx scripts/e2e-slack.ts [options]
```

| Option | Description |
|--------|-------------|
| `--url <url>` | Use a specific public URL (skip ngrok detection) |
| `--port <port>` | Use a specific port (default: 3456) |
| `--skip-ngrok` | Don't auto-detect ngrok, prompt for URL |
| `--skip-manifest` | Don't auto-update the Slack app manifest |
| `--help` | Show help |

The wizard:
1. Checks prerequisites (Node.js, tsx)
2. Loads/prompts for environment variables
3. Verifies OpenCode server connectivity
4. Detects or starts ngrok (or accepts a manual URL)
5. Auto-configures the Slack app manifest
6. Boots the Chat SDK bot
7. Runs a smoke test (health + webhook verification)
8. Shows a status dashboard

## Development

```bash
pnpm typecheck       # TypeScript type checking
pnpm dev             # Dev server with watch mode
pnpm start           # Production start

# E2E testing
pnpm e2e:test        # 28 automated tests (webhook, security, sessions)
pnpm e2e:setup       # 38 full lifecycle tests (boot, shutdown, reboot)
pnpm e2e:slack       # Interactive setup wizard + live Slack testing
```

## Architecture

```
opencode-channels/
  src/
    bot.ts          # Chat SDK bot — handlers, UX, commands (~465 lines)
    opencode.ts     # OpenCode HTTP/SSE client, promptStream() (~370 lines)
    sessions.ts     # Thread→Session mapping, per-thread/per-message (~83 lines)
    server.ts       # Hono webhook server + legacy routes (~88 lines)
    index.ts        # Entry point, start() + CLI auto-start (~58 lines)
  scripts/
    e2e-slack.ts    # Interactive setup wizard
    e2e-test.ts     # Automated E2E test suite (28 tests)
    e2e-setup.ts    # Full lifecycle test suite (38 tests)
    fixtures/       # Slack webhook payload generators
```

### Key Design Decisions

- **Chat SDK as foundation**: Uses `chat` + `@chat-adapter/slack` + `@chat-adapter/state-memory` for all Slack integration. Single webhook endpoint handles events, commands, and interactivity.
- **ESM only**: The Chat SDK only exports ESM, so the project uses `"type": "module"`.
- **Edit-based streaming**: Posts a placeholder message and edits it with accumulated text every 600ms. The Chat SDK also supports native `thread.post(asyncIterable)` but the edit approach gives us control over the thinking indicator UX.
- **Reaction lifecycle**: Hourglass while processing, checkmark on success, X on error.
- **Per-thread sessions**: Each Slack thread maps to one OpenCode session for multi-turn context.
- **5 flat files**: No monorepo, no packages directory, no build step for development (tsx runs TypeScript directly).

## Programmatic Usage

```typescript
import { createBot, createServer } from 'opencode-channels';

const { bot, client, sessions } = createBot({
  opencodeUrl: 'http://localhost:1707',
  botName: 'my-bot',
  agentName: 'coder',
});

const server = createServer(bot, { port: 3456 });
```

## License

MIT
