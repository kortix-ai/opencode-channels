# opencode-channels

Connect [OpenCode](https://github.com/anomalyco/opencode) to **Slack** as a chatbot. Built on the [Vercel Chat SDK](https://github.com/nichochar/chat) for native streaming, reactions, and slash commands.

```
Slack @mention --> Public URL --> Chat SDK Webhook --> OpenCode (SSE) --> Streamed Response --> Slack
```

## Setup in Under 5 Minutes

[![Setup Video](https://img.shields.io/badge/Watch-Setup_Video-red?style=for-the-badge&logo=youtube)](https://screen.studio/share/EkoOaqBz)

> **[Watch the full setup walkthrough](https://screen.studio/share/EkoOaqBz)** — from `git clone` to a working Slack bot in under 5 minutes.

## Quick Start

```bash
# 1. Clone and install
git clone https://github.com/kortix-ai/opencode-channels.git
cd opencode-channels && pnpm install

# 2. Start OpenCode (in your project directory)
opencode serve --port 1707

# 3. Start ngrok (or have any public URL ready)
ngrok http 3456

# 4. Run the setup wizard — it handles everything
pnpm e2e:slack
```

The wizard will:
1. Detect your ngrok URL (or ask for any public URL)
2. Ask for a bot name, generate a personalized Slack app manifest
3. Walk you through creating the app and copying 2 tokens
4. Boot the bot, run a smoke test, show a dashboard

No manual Slack dashboard configuration needed — everything is in the generated manifest.

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

The setup wizard (`pnpm e2e:slack`) handles everything interactively:

1. Detects your public URL (ngrok, or `--url https://your-server.com`)
2. Asks for a bot name (or `--name "My Bot"`)
3. Generates a Slack app manifest JSON with your URL + name baked in
4. Tells you exactly where to paste it to create the Slack app
5. Collects your Bot Token + Signing Secret (saves to `.env.test`)
6. Verifies OpenCode server connectivity
7. Boots the bot, Slack auto-verifies the webhook URL
8. Runs a smoke test, shows a dashboard

**Prerequisites**: Node.js >= 18, OpenCode server running, a public URL (ngrok/Cloudflare Tunnel/server IP).

**Returning users**: Just run `pnpm e2e:slack` again — tokens load from `.env.test`, URLs auto-update if you saved your App ID.

### CLI Options

| Option | Description |
|--------|-------------|
| `--url <url>` | Public URL (skip ngrok detection) |
| `--name <name>` | Bot display name (default: OpenCode) |
| `--port <port>` | Webhook server port (default: 3456) |
| `--skip-ngrok` | Don't auto-detect ngrok |
| `--skip-manifest` | Don't auto-update manifest |

### Production Deployment

Skip the wizard entirely:

```bash
# Set env vars
export SLACK_BOT_TOKEN=xoxb-...
export SLACK_SIGNING_SECRET=...
export OPENCODE_URL=http://localhost:1707

# Update webhook URL in Slack dashboard to https://your-server.com/api/webhooks/slack
# (Event Subscriptions, Slash Commands, and Interactivity all point to the same URL)

# Start
pnpm start
```

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SLACK_BOT_TOKEN` | Yes | — | Bot User OAuth Token (`xoxb-...`) |
| `SLACK_SIGNING_SECRET` | Yes | — | Slack app signing secret |
| `OPENCODE_URL` | No | `http://localhost:1707` | OpenCode server URL |
| `PORT` | No | `3456` | Webhook server port |
| `SLACK_APP_ID` | No | — | Enables auto-manifest URL updates |
| `SLACK_CONFIG_REFRESH_TOKEN` | No | — | Enables auto-manifest URL updates |

## Development

```bash
pnpm typecheck       # TypeScript type checking
pnpm dev             # Dev server with watch mode
pnpm start           # Production start

# Tests (fully isolated, no credentials needed)
pnpm test            # All tests (unit + E2E)
pnpm test:unit       # 17 unit tests
pnpm test:e2e        # 27 E2E tests (mock OpenCode + mock Slack + real bot)

# Docker (CI-ready, hermetic)
pnpm docker:all      # Build + run all tests in Docker
pnpm docker:typecheck # TypeScript check in Docker

# Live Slack testing (requires credentials + public URL)
pnpm e2e:slack       # Interactive setup wizard for live Slack testing
pnpm e2e:test        # Automated live E2E tests
```

## Architecture

```
opencode-channels/
  src/
    bot.ts          # Chat SDK bot — handlers, UX, commands
    opencode.ts     # OpenCode HTTP/SSE client, promptStream()
    sessions.ts     # Thread→Session mapping, per-thread/per-message
    server.ts       # Hono webhook server + legacy routes
    index.ts        # Entry point, start() + CLI auto-start
  test/
    e2e.test.ts     # 27 isolated E2E tests (mock servers + real bot)
    unit.test.ts    # 17 unit tests (modules in isolation)
    mock-opencode.ts # Mock OpenCode server (HTTP + SSE)
    mock-slack.ts   # Mock Slack API with call recording
    all.test.ts     # Sequential runner for all suites
  scripts/
    e2e-slack.ts    # Interactive setup wizard for live Slack testing
    e2e-test.ts     # Automated live E2E tests
    fixtures/       # Slack webhook payload generators
```

### Key Design Decisions

- **Chat SDK as foundation**: Uses `chat` + `@chat-adapter/slack` + `@chat-adapter/state-memory` for all Slack integration. Single webhook endpoint handles events, commands, and interactivity.
- **ESM only**: The Chat SDK only exports ESM, so the project uses `"type": "module"`.
- **Edit-based streaming**: Posts a placeholder message and edits it with accumulated text every 600ms. The Chat SDK also supports native `thread.post(asyncIterable)` but the edit approach gives us control over the thinking indicator UX.
- **Reaction lifecycle**: Hourglass while processing, checkmark on success, X on error.
- **Per-thread sessions**: Each Slack thread maps to one OpenCode session for multi-turn context.
- **5 source files**: No monorepo, no packages directory, no build step for development (tsx runs TypeScript directly).

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
