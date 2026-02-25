# opencode-channels

Connect [OpenCode](https://github.com/anomalyco/opencode) to **Slack** as a chatbot. Built on the [Vercel Chat SDK](https://github.com/nichochar/chat) for native streaming, reactions, and slash commands.

```
Slack @mention --> Public URL --> Chat SDK Webhook --> OpenCode (SSE) --> Streamed Response --> Slack
```

## Quick Start

```bash
# 1. Clone and install
git clone https://github.com/kortix-ai/opencode-channels.git
cd opencode-channels && pnpm install

# 2. Create your Slack app (one-time, ~1 minute)
#    → https://api.slack.com/apps → "Create New App" → "From a manifest"
#    → Select your workspace, paste the contents of slack-manifest.yml
#    → Click "Create" → "Install to Workspace" → "Allow"

# 3. Copy tokens into .env.test
cp .env.example .env.test
#    → Bot Token (xoxb-...):  OAuth & Permissions page
#    → Signing Secret:        Basic Information page

# 4. Start OpenCode (in your project directory)
opencode serve --port 1707

# 5. Run the setup wizard
pnpm e2e:slack
```

The wizard detects ngrok (or accepts `--url`), auto-updates the Slack app webhook URLs, boots the bot, and runs a smoke test. Then just `@mention` the bot in Slack.

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

### Step 1: Create the Slack App

We ship a [`slack-manifest.yml`](slack-manifest.yml) that pre-configures everything — scopes, events, slash commands, bot name. No manual checkbox clicking.

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **"Create New App"** → **"From a manifest"**
2. Select your workspace
3. Switch to the **YAML** tab, paste the contents of `slack-manifest.yml`
4. Click **"Create"** → **"Install to Workspace"** → **"Allow"**

### Step 2: Copy Tokens

From your [Slack app dashboard](https://api.slack.com/apps):

| Token | Where to find it | Looks like |
|-------|-------------------|------------|
| **Bot Token** | OAuth & Permissions → Bot User OAuth Token | `xoxb-...` |
| **Signing Secret** | Basic Information → App Credentials → Signing Secret | hex string |

Put them in `.env.test`:

```bash
cp .env.example .env.test
# Edit .env.test with your two tokens
```

### Step 3: Run

```bash
# Terminal 1 — OpenCode server
opencode serve --port 1707

# Terminal 2 — Bot (the wizard handles the rest)
pnpm e2e:slack
```

The wizard will:
- Detect ngrok or prompt for your public URL (`--url https://your-server.com`)
- Auto-update the Slack app webhook URLs via the Manifest API (if `SLACK_APP_ID` + `SLACK_CONFIG_REFRESH_TOKEN` are set)
- Boot the Chat SDK bot
- Run a smoke test
- Show a status dashboard

**No ngrok?** Use `--url` to pass any publicly reachable URL:

```bash
pnpm e2e:slack --url https://bot.example.com
```

### Step 4 (optional): Auto-manifest for URL updates

If you want the wizard to automatically update webhook URLs when your tunnel URL changes, add these to `.env.test`:

| Token | Where to find it |
|-------|-------------------|
| `SLACK_APP_ID` | Basic Information → App ID (starts with `A0...`) |
| `SLACK_CONFIG_REFRESH_TOKEN` | [api.slack.com/authentication/config-tokens](https://api.slack.com/authentication/config-tokens) → Generate Token |

Without these, you'll need to manually update the Event Subscriptions URL in the Slack dashboard when your URL changes.

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
