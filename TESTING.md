# Testing Guide — opencode-channels

Fully isolated, agentic-friendly test suite for the OpenCode → Slack bridge. Every test runs without external dependencies — no real Slack tokens, no live OpenCode server, no network access required.

## Quick Start

```bash
# Run everything locally
pnpm test

# Run specific suites
pnpm test:unit          # 17 unit tests — modules in isolation
pnpm test:e2e           # 27 E2E tests — full bot lifecycle with mocks

# Run in Docker (CI-ready, fully hermetic)
pnpm docker:all         # build + run all tests
pnpm docker:unit        # unit tests only
pnpm docker:e2e         # E2E tests only
pnpm docker:typecheck   # TypeScript type check only
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Docker Container                         │
│                                                              │
│  ┌──────────────┐   ┌─────────────┐   ┌──────────────────┐  │
│  │ Mock OpenCode │   │  Real Bot   │   │   Mock Slack     │  │
│  │   Server      │◄──│  (Chat SDK  │──►│   API Server     │  │
│  │               │   │  + Hono)    │   │                  │  │
│  │ SSE streaming │   │             │   │ Records all API  │  │
│  │ Sessions      │   │ Webhooks    │   │ calls for assert │  │
│  │ Health check  │   │ Commands    │   │                  │  │
│  └──────────────┘   └─────────────┘   └──────────────────┘  │
│         ▲                  ▲                   ▲             │
│         │                  │                   │             │
│  ┌──────┴──────────────────┴───────────────────┴──────────┐  │
│  │                    Test Runner                          │  │
│  │  - Spawns all servers on random ports                  │  │
│  │  - Sends signed Slack webhook payloads                 │  │
│  │  - Asserts on mock Slack API call recordings           │  │
│  │  - Tears down everything after each test group         │  │
│  └────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

## Test Files

| File | Tests | What it covers |
|------|-------|----------------|
| `test/unit.test.ts` | 17 | `OpenCodeClient` (health, sessions, providers, agents, streaming), `SessionManager`, `MockSlack` verification |
| `test/e2e.test.ts` | 27 | Full bot lifecycle: boot, webhooks, security, slash commands, sessions, OpenCode integration, streaming, reactions, error handling, multi-turn, legacy routes, shutdown |
| `test/all.test.ts` | — | Sequential runner — runs unit then E2E |
| `test/mock-opencode.ts` | — | Mock OpenCode server (HTTP + SSE) |
| `test/mock-slack.ts` | — | Mock Slack API with call recording |

## Mock Servers

### Mock OpenCode (`test/mock-opencode.ts`)

Implements the minimum OpenCode API surface:

| Endpoint | Behavior |
|----------|----------|
| `GET /global/health` | `{ healthy: true }` |
| `POST /session` | Creates session `ses_mock_N`, returns `{ id }` |
| `POST /session/:id/prompt_async` | Returns 204, fires SSE events |
| `GET /event` | SSE stream: `session.status` → `message.part.delta` (char by char) → `session.idle` |
| `GET /config/providers` | Mock providers list |
| `GET /agent` | Mock agents list with `default` agent |
| `GET /file/status` | `[]` |
| `POST /session/:id/share` | Mock share URL |
| `POST /session/:id/abort` | 200 |

**Configurable behavior:**
```typescript
const mock = await createMockOpenCode({
  port: 0,                           // random port
  response: 'Custom response text',  // what the mock says
  chunkDelayMs: 10,                  // SSE streaming speed
  errorResponse: 'Fail!',            // make prompts fail
});
```

Runtime control:
```typescript
mock.setResponse('New response');     // change response text
mock.setError('Something broke');     // make next prompt fail
mock.clearError();                    // stop failing
```

### Mock Slack (`test/mock-slack.ts`)

Records every Slack Web API call the bot makes:

| Endpoint | Response |
|----------|----------|
| `POST /api/auth.test` | Bot identity (`botUserId`, `botId`, `teamId`) |
| `POST /api/chat.postMessage` | Returns `{ ok: true, ts, channel }` |
| `POST /api/chat.update` | Returns `{ ok: true }` |
| `POST /api/reactions.add` | Returns `{ ok: true }` |
| `POST /api/reactions.remove` | Returns `{ ok: true }` |
| `POST /api/conversations.info` | Returns channel info |
| `POST /api/users.info` | Returns user info |

**Call recording for assertions:**
```typescript
const calls = mock.getCalls();                           // all calls
const posts = mock.getCalls('chat.postMessage');          // filtered
const lastPost = mock.getLastCall('chat.postMessage');    // most recent
mock.clearCalls();                                       // reset
```

## E2E Test Phases

The E2E suite runs 7 phases in order:

### Phase 1: Boot
- Bot starts and connects to mock Slack
- Health check endpoint works

### Phase 2: Webhook Acceptance
- URL verification challenge-response
- `app_mention` events accepted with 200
- Direct messages accepted
- Unknown event types handled gracefully

### Phase 3: Security
- Missing/invalid Slack signatures rejected with 401
- Timestamp replay attacks blocked

### Phase 4: Slash Commands
- `/oc help` returns help text
- `/oc status` returns connection status
- `/oc models` returns model list
- `/oc agents` returns agent list

### Phase 5: Session Management
- Same thread reuses same OpenCode session
- Different threads get different sessions

### Phase 6: Mock OpenCode Integration
- Full flow: mention → thinking placeholder → streamed edits → final response
- Hourglass reaction added during processing, checkmark after
- Error handling: OpenCode errors show error message + X reaction

### Phase 7: Legacy Routes
- `GET /health` returns 200
- `GET /` returns welcome page

## How to Add a New Test

### Adding a unit test

1. Open `test/unit.test.ts`
2. Add your test using the `runTest()` helper:

```typescript
await runTest('MyModule: does something', async () => {
  // arrange
  const client = new OpenCodeClient('http://localhost:' + port);

  // act
  const result = await client.someMethod();

  // assert
  assert(result === expected, `Expected ${expected}, got ${result}`);
});
```

### Adding an E2E test

1. Open `test/e2e.test.ts`
2. Find the appropriate phase or create a new one
3. Use the existing helpers:

```typescript
await runTest('Phase N: my new test', async () => {
  // Clear previous API call recordings
  mockSlack.clearCalls();

  // Send a webhook payload to the bot
  const payload = makeAppMention({ text: '<@BOT> do something' });
  const res = await sendWebhook(payload);
  assert(res.status === 200, 'Webhook accepted');

  // Wait for async processing
  await sleep(1500);

  // Assert on Slack API calls the bot made
  const posts = mockSlack.getCalls('chat.postMessage');
  assert(posts.length >= 1, 'Bot posted a response');
});
```

### Adding a new mock endpoint

For Mock OpenCode — add a route handler in `test/mock-opencode.ts`:

```typescript
// In the request handler switch
if (method === 'GET' && url === '/my/new/endpoint') {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ data: 'mock response' }));
  return;
}
```

For Mock Slack — add a handler in `test/mock-slack.ts`:

```typescript
// In the slack method handler
case 'my.newMethod':
  responseData = { ok: true, result: 'mock' };
  break;
```

## Test Infrastructure

### No test framework needed

Tests use a minimal custom runner (`runTest` + `assert`) — zero dependencies beyond Node.js built-ins. This keeps Docker images small and avoids framework version conflicts.

### Port allocation

All servers use random ports (`port: 0`) to avoid conflicts. The test runner discovers assigned ports after bind.

### Webhook signing

E2E tests sign payloads using the same HMAC-SHA256 algorithm Slack uses:

```typescript
function signPayload(body: string, timestamp: number): string {
  const sig = createHmac('sha256', SIGNING_SECRET)
    .update(`v0:${timestamp}:${body}`)
    .digest('hex');
  return `v0=${sig}`;
}
```

### Cleanup

Every test group tears down all servers (mock OpenCode, mock Slack, real bot) after completion, even on failure.

## Docker

### How it works

1. `Dockerfile` builds a Node 22 slim image with pnpm, installs deps, copies source + tests
2. `docker-compose.test.yml` defines 4 services sharing the same image but running different commands
3. Each service gets mock env vars (`SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN`, `OPENCODE_URL`) — no real credentials
4. `tmpfs` mounts at `/tmp` for ephemeral storage

### Services

| Service | Command | Purpose |
|---------|---------|---------|
| `unit-tests` | `npx tsx test/unit.test.ts` | Unit tests only |
| `e2e-tests` | `npx tsx test/e2e.test.ts` | E2E tests only |
| `all-tests` | `npx tsx test/all.test.ts` | All suites sequentially |
| `typecheck` | `npx tsc --noEmit` | TypeScript type checking |

### CI Integration

```yaml
# GitHub Actions example
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: docker compose -f docker-compose.test.yml run --rm all-tests
```

## Agentic Testing Philosophy

This test suite is designed to be run by AI agents in CI/CD pipelines:

1. **Zero configuration** — No env files, API keys, or external services needed
2. **Self-contained** — Mock servers simulate every external dependency
3. **Deterministic** — Same input always produces same output (no flaky tests)
4. **Fast** — Full suite runs in <5 seconds locally, <60 seconds in Docker
5. **Clear output** — PASS/FAIL per test with assertion messages, exit code 0/1
6. **Hermetic** — Docker ensures identical behavior across machines
7. **No cleanup needed** — Ephemeral containers, tmpfs mounts, random ports

When an agent runs the tests and sees a failure, the error message tells it exactly what went wrong and where to look.

## Live E2E Testing (optional)

For testing against real Slack + real OpenCode (not in Docker):

```bash
# 1. Set up .env.test with real credentials
cp .env.example .env.test
# Edit .env.test with SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET

# 2. Start OpenCode server
opencode serve --port 1707

# 3. Run the interactive setup wizard
pnpm e2e:slack --port 1707

# 4. Or run the automated E2E tests against live services
OPENCODE_URL=http://localhost:1707 pnpm e2e:test
```

See `scripts/e2e-slack.ts` for the full interactive wizard.
