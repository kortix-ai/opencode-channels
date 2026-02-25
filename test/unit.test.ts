/**
 * Unit tests for opencode-channels.
 *
 * Tests individual modules in isolation with mock OpenCode server.
 * No Slack credentials needed — no network calls to Slack.
 *
 * Usage:
 *   npx tsx test/unit.test.ts                   # local
 *   docker compose -f docker-compose.test.yml run --rm unit-tests  # Docker
 */

import * as net from 'node:net';
import { createMockOpenCode } from './mock-opencode.js';
import { createMockSlack } from './mock-slack.js';
import { OpenCodeClient } from '../src/opencode.js';
import { SessionManager } from '../src/sessions.js';

// ─── Test infrastructure ────────────────────────────────────────────────────

interface TestResult { name: string; passed: boolean; error?: string; durationMs: number }
const results: TestResult[] = [];

async function runTest(name: string, fn: () => Promise<void>): Promise<void> {
  const start = Date.now();
  try {
    await fn();
    results.push({ name, passed: true, durationMs: Date.now() - start });
    console.log(`  \x1b[32m PASS \x1b[0m ${name} (${Date.now() - start}ms)`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    results.push({ name, passed: false, error: msg, durationMs: Date.now() - start });
    console.log(`  \x1b[31m FAIL \x1b[0m ${name}: ${msg}`);
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function getRandomPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        srv.close(() => resolve(addr.port));
      } else {
        srv.close(() => reject(new Error('Could not get port')));
      }
    });
  });
}

// ─── Shared state ───────────────────────────────────────────────────────────

let mockOC: ReturnType<typeof createMockOpenCode>;
let ocPort: number;

// ─── OpenCodeClient tests ───────────────────────────────────────────────────

async function testClientHealth(): Promise<void> {
  const client = new OpenCodeClient({ baseUrl: `http://localhost:${ocPort}` });
  assert(await client.isReady(), 'Health check failed');
}

async function testClientHealthDown(): Promise<void> {
  const client = new OpenCodeClient({ baseUrl: 'http://localhost:1' });
  assert(!(await client.isReady()), 'Should return false for dead server');
}

async function testClientCreateSession(): Promise<void> {
  const client = new OpenCodeClient({ baseUrl: `http://localhost:${ocPort}` });
  const id = await client.createSession();
  assert(id.startsWith('ses_mock_'), `Bad session ID: ${id}`);
}

async function testClientCreateSessionWithAgent(): Promise<void> {
  const client = new OpenCodeClient({ baseUrl: `http://localhost:${ocPort}` });
  const id = await client.createSession('coder');
  assert(id.startsWith('ses_mock_'), `Bad session ID: ${id}`);
}

async function testClientListProviders(): Promise<void> {
  const client = new OpenCodeClient({ baseUrl: `http://localhost:${ocPort}` });
  const providers = await client.listProviders();
  assert(providers.length === 1, `Expected 1 provider, got ${providers.length}`);
  assert(providers[0].id === 'mock-provider', 'Wrong provider ID');
  assert(providers[0].models.length === 2, 'Wrong model count');
}

async function testClientListAgents(): Promise<void> {
  const client = new OpenCodeClient({ baseUrl: `http://localhost:${ocPort}` });
  const agents = await client.listAgents();
  assert(agents.length === 2, `Expected 2 agents, got ${agents.length}`);
  assert(agents[0].name === 'coder', `Wrong agent name: ${agents[0].name}`);
}

async function testClientPromptStream(): Promise<void> {
  const client = new OpenCodeClient({ baseUrl: `http://localhost:${ocPort}` });
  const sessionId = await client.createSession();
  mockOC.setResponse('Test response 123');

  let fullText = '';
  for await (const delta of client.promptStream(sessionId, 'hello')) {
    fullText += delta;
  }
  assert(fullText === 'Test response 123', `Wrong response: "${fullText}"`);
}

async function testClientPromptStreamLong(): Promise<void> {
  const client = new OpenCodeClient({ baseUrl: `http://localhost:${ocPort}` });
  const sessionId = await client.createSession();
  const longText = 'A'.repeat(500);
  mockOC.setResponse(longText);

  let fullText = '';
  for await (const delta of client.promptStream(sessionId, 'hello')) {
    fullText += delta;
  }
  assert(fullText === longText, `Wrong length: ${fullText.length} vs ${longText.length}`);
}

// ─── SessionManager tests ───────────────────────────────────────────────────

async function testSessionPerThread(): Promise<void> {
  const mgr = new SessionManager('per-thread');
  const client = new OpenCodeClient({ baseUrl: `http://localhost:${ocPort}` });

  const s1 = await mgr.resolve('t1', client);
  const s2 = await mgr.resolve('t1', client);
  assert(s1 === s2, 'Same thread should reuse');

  const s3 = await mgr.resolve('t2', client);
  assert(s3 !== s1, 'Different thread should differ');
}

async function testSessionPerMessage(): Promise<void> {
  const mgr = new SessionManager('per-message');
  const client = new OpenCodeClient({ baseUrl: `http://localhost:${ocPort}` });

  const s1 = await mgr.resolve('t1', client);
  const s2 = await mgr.resolve('t1', client);
  assert(s1 !== s2, 'Should create fresh every time');
}

async function testSessionInvalidation(): Promise<void> {
  const mgr = new SessionManager('per-thread');
  const client = new OpenCodeClient({ baseUrl: `http://localhost:${ocPort}` });

  const s1 = await mgr.resolve('ti', client);
  mgr.invalidate('ti');
  const s2 = await mgr.resolve('ti', client);
  assert(s1 !== s2, 'Invalidated should get new session');
}

async function testSessionGet(): Promise<void> {
  const mgr = new SessionManager('per-thread');
  const client = new OpenCodeClient({ baseUrl: `http://localhost:${ocPort}` });

  assert(mgr.get('x') === undefined, 'Should be undefined before resolve');
  await mgr.resolve('x', client);
  assert(mgr.get('x') !== undefined, 'Should exist after resolve');
}

async function testSessionCleanup(): Promise<void> {
  const mgr = new SessionManager('per-thread');
  const client = new OpenCodeClient({ baseUrl: `http://localhost:${ocPort}` });

  await mgr.resolve('tc', client);
  mgr.cleanup();
  assert(mgr.get('tc') !== undefined, 'Fresh session should survive cleanup');
}

async function testSessionStrategySwitch(): Promise<void> {
  const mgr = new SessionManager('per-thread');
  mgr.setStrategy('per-message');
  const client = new OpenCodeClient({ baseUrl: `http://localhost:${ocPort}` });

  const s1 = await mgr.resolve('ts', client);
  const s2 = await mgr.resolve('ts', client);
  assert(s1 !== s2, 'After switch to per-message, should create new');
}

async function testSessionAgentSwitch(): Promise<void> {
  const mgr = new SessionManager('per-thread', 'agent-a');
  mgr.setAgent('agent-b');
  assert(true, 'Agent switch should not throw');
}

// ─── MockSlack tests ────────────────────────────────────────────────────────

async function testMockSlackCallRecording(): Promise<void> {
  const port = await getRandomPort();
  const mock = createMockSlack({ port });
  await mock.start();

  // Make a call
  await fetch(`http://localhost:${port}/api/auth.test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });

  assert(mock.callCount('auth.test') === 1, `Expected 1 call, got ${mock.callCount('auth.test')}`);

  const last = mock.lastCallTo('auth.test');
  assert(last !== undefined, 'Should have recorded the call');
  assert(last!.path === '/api/auth.test', 'Wrong path recorded');

  mock.clearCalls();
  assert(mock.calls.length === 0, 'Should be empty after clear');

  await mock.stop();
}

async function testMockSlackPostMessage(): Promise<void> {
  const port = await getRandomPort();
  const mock = createMockSlack({ port });
  await mock.start();

  const res = await fetch(`http://localhost:${port}/api/chat.postMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: 'C_TEST', text: 'hello' }),
  });
  const data = (await res.json()) as { ok: boolean; ts: string };
  assert(data.ok === true, 'Should return ok');
  assert(typeof data.ts === 'string', 'Should return ts');

  await mock.stop();
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('');
  console.log('opencode-channels Unit Tests');
  console.log('════════════════════════════════════════════════════════');
  console.log('');

  // Boot mock OpenCode
  ocPort = await getRandomPort();
  mockOC = createMockOpenCode({ port: ocPort, response: 'unit test response', chunkDelayMs: 5 });
  await mockOC.start();

  console.log('── OpenCodeClient ──');
  await runTest('Health check (live)', testClientHealth);
  await runTest('Health check (dead server)', testClientHealthDown);
  await runTest('Create session', testClientCreateSession);
  await runTest('Create session with agent', testClientCreateSessionWithAgent);
  await runTest('List providers', testClientListProviders);
  await runTest('List agents', testClientListAgents);
  await runTest('Prompt stream', testClientPromptStream);
  await runTest('Prompt stream (long)', testClientPromptStreamLong);

  console.log('');
  console.log('── SessionManager ──');
  await runTest('Per-thread reuse', testSessionPerThread);
  await runTest('Per-message fresh', testSessionPerMessage);
  await runTest('Invalidation', testSessionInvalidation);
  await runTest('Get', testSessionGet);
  await runTest('Cleanup', testSessionCleanup);
  await runTest('Strategy switch', testSessionStrategySwitch);
  await runTest('Agent switch', testSessionAgentSwitch);

  console.log('');
  console.log('── MockSlack ──');
  await runTest('Call recording', testMockSlackCallRecording);
  await runTest('PostMessage response', testMockSlackPostMessage);

  // Cleanup
  await mockOC.stop();

  // Report
  console.log('');
  console.log('════════════════════════════════════════════════════════');

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  const totalMs = results.reduce((sum, r) => sum + r.durationMs, 0);

  if (failed === 0) {
    console.log(`\x1b[32m  All ${passed} tests passed (${totalMs}ms)\x1b[0m`);
  } else {
    console.log(`\x1b[31m  ${failed} of ${passed + failed} tests failed\x1b[0m`);
    for (const r of results.filter((r) => !r.passed)) {
      console.log(`  \x1b[31m  ${r.name}: ${r.error}\x1b[0m`);
    }
  }
  console.log('════════════════════════════════════════════════════════');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('[FATAL]', err);
  process.exit(1);
});
