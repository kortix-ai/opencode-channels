/**
 * Comprehensive test suite for all Slack slash commands.
 *
 * Tests the full handler chain: Hono context → handleSlackCommand →
 * individual command handlers → Slack API calls via response_url / bot token.
 *
 * Every /oc subcommand is covered:
 *   help, models, agents, status, share, diff, link, export, config (show/set/clear),
 *   search, find, whois, channel (create/topic/archive), dm, pin, unpin, pins,
 *   team, bookmark, bookmarks, and free-form prompt.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { handleSlackCommand } from '../src/commands.js';
import type { ChannelConfig, ChannelEngine, NormalizedMessage, SessionStrategy } from '@opencode-channels/core';
import type { OpenCodeClient } from '@opencode-channels/core';

// ─── Test helpers ───────────────────────────────────────────────────────────

/** Captured response_url POST bodies */
let responseUrlCaptures: Array<{ url: string; body: Record<string, unknown> }> = [];

/** Captured Slack API calls */
let slackApiCaptures: Array<{ url: string; body?: Record<string, unknown>; method?: string }> = [];

function makeConfig(overrides: Partial<ChannelConfig> = {}): ChannelConfig {
  return {
    id: 'cfg-test-1',
    name: 'Test Slack',
    channelType: 'slack',
    enabled: true,
    credentials: {
      botToken: 'xoxb-test-bot-token',
      signingSecret: '', // empty = skip verification in tests
    },
    platformConfig: {},
    metadata: {},
    sessionStrategy: 'per-user' as SessionStrategy,
    systemPrompt: null,
    agentName: null,
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeEngine(): ChannelEngine {
  return {
    processMessage: vi.fn().mockResolvedValue(undefined),
    resetSession: vi.fn().mockResolvedValue(undefined),
    getAdapter: vi.fn().mockReturnValue(undefined),
    cleanup: vi.fn(),
  };
}

function makeClient(overrides: Partial<Record<string, unknown>> = {}): OpenCodeClient {
  return {
    isReady: vi.fn().mockResolvedValue(true),
    createSession: vi.fn().mockResolvedValue('session-123'),
    listProviders: vi.fn().mockResolvedValue([
      {
        id: 'anthropic',
        name: 'Anthropic',
        models: [
          { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4' },
          { id: 'claude-opus-4-20250514', name: 'Claude Opus 4' },
        ],
      },
      {
        id: 'openai',
        name: 'OpenAI',
        models: [
          { id: 'gpt-4o', name: 'GPT-4o' },
        ],
      },
    ]),
    listAgents: vi.fn().mockResolvedValue([
      { name: 'default', description: 'Default agent', mode: 'primary' },
      { name: 'coder', description: 'Coding agent', mode: 'primary' },
      { name: 'task-worker', description: 'Internal', mode: 'subagent' },
    ]),
    shareSession: vi.fn().mockResolvedValue({ shareUrl: 'https://share.example.com/session-123' }),
    getSessionDiff: vi.fn().mockResolvedValue('diff --git a/foo.ts\n+ added line'),
    getModifiedFiles: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as OpenCodeClient;
}

/**
 * Build a mock Hono context for a slash command request.
 */
function buildCommandBody(
  text: string,
  extra: Record<string, string> = {},
): string {
  const params = new URLSearchParams({
    command: '/oc',
    text,
    user_id: 'U_TESTER',
    user_name: 'tester',
    channel_id: 'C_CHAN',
    team_id: 'T_TEAM',
    trigger_id: 'trigger-123',
    response_url: 'https://hooks.slack.com/commands/response-url',
    ...extra,
  });
  return params.toString();
}

/**
 * Invoke handleSlackCommand via a Hono app.request() to get a real Response.
 */
async function invokeCommand(
  text: string,
  config?: ChannelConfig,
  client?: OpenCodeClient,
  engine?: ChannelEngine,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const app = new Hono();
  const cfg = config ?? makeConfig();
  const cli = client ?? makeClient();
  const eng = engine ?? makeEngine();
  const rawBody = buildCommandBody(text);

  app.post('/slack/commands', async (c) => {
    return handleSlackCommand(c, eng, cfg, cli, rawBody);
  });

  const res = await app.request('/slack/commands', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: rawBody,
  });

  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body };
}

// ─── Mock fetch to capture response_url & Slack API calls ───────────────────

const originalFetch = globalThis.fetch;

function installMockFetch() {
  responseUrlCaptures = [];
  slackApiCaptures = [];

  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();

    // Capture response_url POSTs
    if (url.includes('hooks.slack.com')) {
      let bodyObj = {};
      if (init?.body) {
        try {
          bodyObj = JSON.parse(init.body as string);
        } catch { /* ignore */ }
      }
      responseUrlCaptures.push({ url, body: bodyObj as Record<string, unknown> });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    // Capture Slack API calls
    if (url.includes('slack.com/api/')) {
      let bodyObj: Record<string, unknown> = {};
      if (init?.body) {
        try {
          bodyObj = JSON.parse(init.body as string);
        } catch { /* ignore */ }
      }
      slackApiCaptures.push({ url, body: bodyObj, method: init?.method || 'POST' });

      // Default successful responses for specific endpoints
      if (url.includes('conversations.join')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.includes('conversations.history')) {
        return new Response(JSON.stringify({
          ok: true,
          messages: [
            { ts: '111.222', text: 'hello world', user: 'U1' },
            { ts: '111.333', text: 'how are you', user: 'U2' },
          ],
        }), { status: 200 });
      }
      if (url.includes('conversations.replies')) {
        return new Response(JSON.stringify({
          ok: true,
          messages: [
            { ts: '111.222', text: 'thread message', user: 'U1' },
          ],
        }), { status: 200 });
      }
      if (url.includes('conversations.create')) {
        return new Response(JSON.stringify({
          ok: true,
          channel: { id: 'C_NEW', name: 'new-channel' },
        }), { status: 200 });
      }
      if (url.includes('conversations.setTopic')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.includes('conversations.archive')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.includes('conversations.open')) {
        return new Response(JSON.stringify({
          ok: true,
          channel: { id: 'D_DM' },
        }), { status: 200 });
      }
      if (url.includes('chat.postMessage')) {
        return new Response(JSON.stringify({ ok: true, ts: '999.000' }), { status: 200 });
      }
      if (url.includes('pins.add')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.includes('pins.remove')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.includes('pins.list')) {
        return new Response(JSON.stringify({
          ok: true,
          items: [
            { message: { text: 'pinned message', ts: '111.222', permalink: 'https://slack.com/p1' } },
          ],
        }), { status: 200 });
      }
      if (url.includes('search.messages')) {
        return new Response(JSON.stringify({
          ok: true,
          messages: {
            total: 2,
            matches: [
              { text: 'matching message 1', channel: { name: 'general' }, permalink: 'https://slack.com/m1' },
              { text: 'matching message 2', channel: { name: 'dev' }, permalink: 'https://slack.com/m2' },
            ],
          },
        }), { status: 200 });
      }
      if (url.includes('search.files')) {
        return new Response(JSON.stringify({
          ok: true,
          files: {
            total: 1,
            matches: [
              { name: 'design.pdf', filetype: 'pdf', permalink: 'https://slack.com/f1' },
            ],
          },
        }), { status: 200 });
      }
      if (url.includes('users.list')) {
        return new Response(JSON.stringify({
          ok: true,
          members: [
            { id: 'U_FOUND', name: 'john', real_name: 'John Doe', deleted: false, is_bot: false, profile: { display_name: 'johnd', email: 'john@test.com' } },
          ],
        }), { status: 200 });
      }
      // IMPORTANT: check usergroups.users.list BEFORE usergroups.list (substring match)
      if (url.includes('usergroups.users.list')) {
        return new Response(JSON.stringify({
          ok: true,
          users: ['U1', 'U2', 'U3'],
        }), { status: 200 });
      }
      if (url.includes('usergroups.list')) {
        return new Response(JSON.stringify({
          ok: true,
          usergroups: [
            { id: 'UG1', handle: 'devteam', name: 'Dev Team' },
          ],
        }), { status: 200 });
      }
      if (url.includes('bookmarks.add')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.includes('bookmarks.list')) {
        return new Response(JSON.stringify({
          ok: true,
          bookmarks: [
            { title: 'Docs', link: 'https://docs.example.com' },
            { title: 'CI', link: 'https://ci.example.com' },
          ],
        }), { status: 200 });
      }
      if (url.includes('files.getUploadURLExternal')) {
        return new Response(JSON.stringify({
          ok: true,
          upload_url: 'https://files.slack.com/upload/xxx',
          file_id: 'F_UPLOAD',
        }), { status: 200 });
      }
      if (url.includes('files.completeUploadExternal')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      // Upload URL
      if (url.includes('files.slack.com/upload')) {
        return new Response('OK', { status: 200 });
      }

      // Default: return ok
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    // Upload to files.slack.com
    if (url.includes('files.slack.com')) {
      return new Response('OK', { status: 200 });
    }

    // Fallback
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as unknown as typeof fetch;
}

// ─── Test suite ─────────────────────────────────────────────────────────────

describe('Slack Slash Commands — full handler chain', () => {
  beforeEach(() => {
    installMockFetch();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // ── /oc help ────────────────────────────────────────────────────────────

  describe('/oc help', () => {
    it('returns help text with all command descriptions', async () => {
      const { status, body } = await invokeCommand('help');
      expect(status).toBe(200);
      expect(body.response_type).toBe('ephemeral');
      expect(body.text).toContain('OpenCode Slash Commands');
      expect(body.text).toContain('/opencode');
    });

    it('returns help for empty text', async () => {
      const { status, body } = await invokeCommand('');
      expect(status).toBe(200);
      expect(body.response_type).toBe('ephemeral');
      expect(body.text).toContain('OpenCode Slash Commands');
    });

    it('includes all major command categories', async () => {
      const { body } = await invokeCommand('help');
      const text = body.text as string;
      expect(text).toContain('General');
      expect(text).toContain('Search');
      expect(text).toContain('Channels');
      expect(text).toContain('Pins');
      expect(text).toContain('Config');
      expect(text).toContain('Bookmarks');
    });
  });

  // ── /oc models ──────────────────────────────────────────────────────────

  describe('/oc models', () => {
    it('returns immediate acknowledgement', async () => {
      const { status, body } = await invokeCommand('models');
      expect(status).toBe(200);
      expect(body.response_type).toBe('ephemeral');
      expect(body.text).toContain('Fetching models');
    });

    it('calls listProviders and posts to response_url', async () => {
      const client = makeClient();
      await invokeCommand('models', undefined, client);

      // Wait for async handler
      await new Promise((r) => setTimeout(r, 50));

      expect(client.listProviders).toHaveBeenCalled();
      expect(responseUrlCaptures.length).toBeGreaterThanOrEqual(1);

      const capture = responseUrlCaptures[0];
      const text = capture.body.text as string;
      expect(text).toContain('Available Models');
      expect(text).toContain('claude-sonnet-4-20250514');
      expect(text).toContain('claude-opus-4-20250514');
      expect(text).toContain('gpt-4o');
      expect(text).toContain('Anthropic');
      expect(text).toContain('OpenAI');
    });

    it('marks current model with checkmark', async () => {
      const config = makeConfig({
        metadata: { model: { providerID: 'anthropic', modelID: 'claude-sonnet-4-20250514' } },
      });
      await invokeCommand('models', config);
      await new Promise((r) => setTimeout(r, 50));

      const text = responseUrlCaptures[0]?.body.text as string;
      expect(text).toContain('claude-sonnet-4-20250514');
      expect(text).toContain(':white_check_mark:');
    });

    it('handles empty providers', async () => {
      const client = makeClient({ listProviders: vi.fn().mockResolvedValue([]) });
      await invokeCommand('models', undefined, client);
      await new Promise((r) => setTimeout(r, 50));

      const text = responseUrlCaptures[0]?.body.text as string;
      expect(text).toContain('No providers available');
    });
  });

  // ── /oc agents ──────────────────────────────────────────────────────────

  describe('/oc agents', () => {
    it('returns immediate acknowledgement', async () => {
      const { body } = await invokeCommand('agents');
      expect(body.text).toContain('Fetching agents');
    });

    it('lists agents and filters out subagents', async () => {
      await invokeCommand('agents');
      await new Promise((r) => setTimeout(r, 50));

      const text = responseUrlCaptures[0]?.body.text as string;
      expect(text).toContain('Available Agents');
      expect(text).toContain('default');
      expect(text).toContain('coder');
      // subagent should NOT appear
      expect(text).not.toContain('task-worker');
    });

    it('marks current agent with checkmark', async () => {
      const config = makeConfig({ agentName: 'coder' });
      await invokeCommand('agents', config);
      await new Promise((r) => setTimeout(r, 50));

      const text = responseUrlCaptures[0]?.body.text as string;
      expect(text).toContain('coder');
      // "coder" should have the checkmark
      const lines = text.split('\n');
      const coderLine = lines.find((l: string) => l.includes('`coder`'));
      expect(coderLine).toContain(':white_check_mark:');
    });
  });

  // ── /oc status ──────────────────────────────────────────────────────────

  describe('/oc status', () => {
    it('returns immediate acknowledgement', async () => {
      const { body } = await invokeCommand('status');
      expect(body.text).toContain('Fetching status');
    });

    it('shows session status info', async () => {
      const config = makeConfig({
        metadata: { model: { providerID: 'anthropic', modelID: 'claude-sonnet-4-20250514' } },
        agentName: 'coder',
        sessionStrategy: 'per-thread' as SessionStrategy,
      });
      await invokeCommand('status', config);
      await new Promise((r) => setTimeout(r, 50));

      const text = responseUrlCaptures[0]?.body.text as string;
      expect(text).toContain('Session Status');
      expect(text).toContain('claude-sonnet-4-20250514');
      expect(text).toContain('coder');
      expect(text).toContain('per-thread');
    });
  });

  // ── /oc share ───────────────────────────────────────────────────────────

  describe('/oc share', () => {
    it('returns immediate acknowledgement', async () => {
      const { body } = await invokeCommand('share');
      expect(body.text).toContain('Generating share link');
    });

    it('reports no active session when none exists', async () => {
      await invokeCommand('share');
      await new Promise((r) => setTimeout(r, 50));

      const text = responseUrlCaptures[0]?.body.text as string;
      expect(text).toContain('No active session');
    });
  });

  // ── /oc diff ────────────────────────────────────────────────────────────

  describe('/oc diff', () => {
    it('returns immediate acknowledgement', async () => {
      const { body } = await invokeCommand('diff');
      expect(body.text).toContain('Fetching diff');
    });

    it('reports no active session when none exists', async () => {
      await invokeCommand('diff');
      await new Promise((r) => setTimeout(r, 50));

      const text = responseUrlCaptures[0]?.body.text as string;
      expect(text).toContain('No active session');
    });
  });

  // ── /oc link ────────────────────────────────────────────────────────────

  describe('/oc link', () => {
    it('returns immediate acknowledgement', async () => {
      const { body } = await invokeCommand('link');
      expect(body.text).toContain('Checking status');
    });

    it('shows connection status', async () => {
      const client = makeClient();
      await invokeCommand('link', undefined, client);
      await new Promise((r) => setTimeout(r, 50));

      expect(client.isReady).toHaveBeenCalled();
      const text = responseUrlCaptures[0]?.body.text as string;
      expect(text).toContain('Connection Status');
      expect(text).toContain('Connected');
    });

    it('shows disconnected when server is unreachable', async () => {
      const client = makeClient({ isReady: vi.fn().mockResolvedValue(false) });
      await invokeCommand('link', undefined, client);
      await new Promise((r) => setTimeout(r, 50));

      const text = responseUrlCaptures[0]?.body.text as string;
      expect(text).toContain('Unreachable');
    });
  });

  // ── /oc export ──────────────────────────────────────────────────────────

  describe('/oc export', () => {
    it('returns immediate acknowledgement', async () => {
      const { body } = await invokeCommand('export');
      expect(body.text).toContain('Exporting');
    });

    it('calls conversations.history and uploads file', async () => {
      await invokeCommand('export');
      await new Promise((r) => setTimeout(r, 100));

      // Should have called conversations.history
      const historyCall = slackApiCaptures.find((c) => c.url.includes('conversations.history'));
      expect(historyCall).toBeDefined();

      // Should have called files upload
      const uploadCall = slackApiCaptures.find((c) => c.url.includes('files.getUploadURLExternal'));
      expect(uploadCall).toBeDefined();
    });
  });

  // ── /oc config show ─────────────────────────────────────────────────────

  describe('/oc config show', () => {
    it('shows current configuration', async () => {
      const config = makeConfig({
        systemPrompt: 'Be helpful and concise',
        agentName: 'coder',
        sessionStrategy: 'per-thread' as SessionStrategy,
      });
      await invokeCommand('config show', config);
      await new Promise((r) => setTimeout(r, 50));

      const text = responseUrlCaptures[0]?.body.text as string;
      expect(text).toContain('Current Config');
      expect(text).toContain('Be helpful and concise');
      expect(text).toContain('per-thread');
      expect(text).toContain('coder');
    });

    it('shows "none" when no prompts configured', async () => {
      await invokeCommand('config show');
      await new Promise((r) => setTimeout(r, 50));

      const text = responseUrlCaptures[0]?.body.text as string;
      expect(text).toContain('_none_');
    });
  });

  // ── /oc config prompt set ───────────────────────────────────────────────

  describe('/oc config prompt set', () => {
    it('sets a channel prompt', async () => {
      await invokeCommand('config prompt You are a coding assistant');
      await new Promise((r) => setTimeout(r, 50));

      const text = responseUrlCaptures[0]?.body.text as string;
      expect(text).toContain('Channel prompt set to');
      expect(text).toContain('You are a coding assistant');
    });
  });

  // ── /oc config prompt clear ─────────────────────────────────────────────

  describe('/oc config prompt clear', () => {
    it('clears the channel prompt', async () => {
      await invokeCommand('config prompt clear');
      await new Promise((r) => setTimeout(r, 50));

      const text = responseUrlCaptures[0]?.body.text as string;
      expect(text).toContain('Channel prompt cleared');
    });
  });

  // ── /oc search ──────────────────────────────────────────────────────────

  describe('/oc search', () => {
    it('returns immediate acknowledgement', async () => {
      const { body } = await invokeCommand('search deployment issue');
      expect(body.text).toContain('Searching messages');
    });

    it('calls search.messages and returns results', async () => {
      await invokeCommand('search deployment issue');
      await new Promise((r) => setTimeout(r, 50));

      const searchCall = slackApiCaptures.find((c) => c.url.includes('search.messages'));
      expect(searchCall).toBeDefined();

      const text = responseUrlCaptures[0]?.body.text as string;
      expect(text).toContain('Search results');
      expect(text).toContain('deployment issue');
      expect(text).toContain('matching message');
    });

    it('treats bare "search" as a free-form prompt', async () => {
      const engine = makeEngine();
      const { body } = await invokeCommand('search', undefined, undefined, engine);
      // "search" without a trailing space doesn't match "search " prefix,
      // so it falls through to the free-form prompt handler
      expect(body.response_type).toBe('in_channel');
      expect(body.text).toContain('Working on it');
    });
  });

  // ── /oc find ────────────────────────────────────────────────────────────

  describe('/oc find', () => {
    it('returns immediate acknowledgement', async () => {
      const { body } = await invokeCommand('find design.pdf');
      expect(body.text).toContain('Searching files');
    });

    it('calls search.files and returns results', async () => {
      await invokeCommand('find design.pdf');
      await new Promise((r) => setTimeout(r, 50));

      const text = responseUrlCaptures[0]?.body.text as string;
      expect(text).toContain('File results');
      expect(text).toContain('design.pdf');
    });
  });

  // ── /oc whois ───────────────────────────────────────────────────────────

  describe('/oc whois', () => {
    it('returns immediate acknowledgement', async () => {
      const { body } = await invokeCommand('whois john');
      expect(body.text).toContain('Searching users');
    });

    it('calls users.list and returns matching users', async () => {
      await invokeCommand('whois john');
      await new Promise((r) => setTimeout(r, 50));

      const usersCall = slackApiCaptures.find((c) => c.url.includes('users.list'));
      expect(usersCall).toBeDefined();

      const text = responseUrlCaptures[0]?.body.text as string;
      expect(text).toContain('User results');
      expect(text).toContain('john');
    });
  });

  // ── /oc channel create ──────────────────────────────────────────────────

  describe('/oc channel create', () => {
    it('returns immediate acknowledgement', async () => {
      const { body } = await invokeCommand('channel create new-project');
      expect(body.text).toContain('Processing');
    });

    it('calls conversations.create', async () => {
      await invokeCommand('channel create new-project');
      await new Promise((r) => setTimeout(r, 50));

      const createCall = slackApiCaptures.find((c) => c.url.includes('conversations.create'));
      expect(createCall).toBeDefined();

      const text = responseUrlCaptures[0]?.body.text as string;
      expect(text).toContain('Channel');
      expect(text).toContain('created');
    });
  });

  // ── /oc channel topic ──────────────────────────────────────────────────

  describe('/oc channel topic', () => {
    it('calls conversations.setTopic', async () => {
      await invokeCommand('channel topic New project discussions');
      await new Promise((r) => setTimeout(r, 50));

      const topicCall = slackApiCaptures.find((c) => c.url.includes('conversations.setTopic'));
      expect(topicCall).toBeDefined();

      const text = responseUrlCaptures[0]?.body.text as string;
      expect(text).toContain('topic updated');
    });
  });

  // ── /oc channel archive ─────────────────────────────────────────────────

  describe('/oc channel archive', () => {
    it('calls conversations.archive', async () => {
      await invokeCommand('channel archive');
      await new Promise((r) => setTimeout(r, 50));

      const archiveCall = slackApiCaptures.find((c) => c.url.includes('conversations.archive'));
      expect(archiveCall).toBeDefined();

      const text = responseUrlCaptures[0]?.body.text as string;
      expect(text).toContain('archived');
    });
  });

  // ── /oc dm ──────────────────────────────────────────────────────────────

  describe('/oc dm', () => {
    it('returns immediate acknowledgement', async () => {
      const { body } = await invokeCommand('dm U_TARGET Hey there!');
      expect(body.text).toContain('Sending DM');
    });

    it('opens DM and sends message', async () => {
      await invokeCommand('dm U_TARGET Hey there!');
      await new Promise((r) => setTimeout(r, 50));

      const openCall = slackApiCaptures.find((c) => c.url.includes('conversations.open'));
      expect(openCall).toBeDefined();

      const postCall = slackApiCaptures.find((c) => c.url.includes('chat.postMessage'));
      expect(postCall).toBeDefined();

      const text = responseUrlCaptures[0]?.body.text as string;
      expect(text).toContain('DM sent');
    });

    it('handles @mention format for DM target', async () => {
      await invokeCommand('dm <@U_TARGET|user> Hello!');
      await new Promise((r) => setTimeout(r, 50));

      const text = responseUrlCaptures[0]?.body.text as string;
      expect(text).toContain('DM sent');
    });
  });

  // ── /oc pin ─────────────────────────────────────────────────────────────

  describe('/oc pin', () => {
    it('pins the most recent message', async () => {
      await invokeCommand('pin');
      await new Promise((r) => setTimeout(r, 50));

      const pinCall = slackApiCaptures.find((c) => c.url.includes('pins.add'));
      expect(pinCall).toBeDefined();

      const text = responseUrlCaptures[0]?.body.text as string;
      expect(text).toContain('pinned');
    });
  });

  // ── /oc unpin ───────────────────────────────────────────────────────────

  describe('/oc unpin', () => {
    it('unpins the most recent message', async () => {
      await invokeCommand('unpin');
      await new Promise((r) => setTimeout(r, 50));

      const unpinCall = slackApiCaptures.find((c) => c.url.includes('pins.remove'));
      expect(unpinCall).toBeDefined();

      const text = responseUrlCaptures[0]?.body.text as string;
      expect(text).toContain('unpinned');
    });
  });

  // ── /oc pins ────────────────────────────────────────────────────────────

  describe('/oc pins', () => {
    it('lists pinned items', async () => {
      await invokeCommand('pins');
      await new Promise((r) => setTimeout(r, 50));

      const pinsCall = slackApiCaptures.find((c) => c.url.includes('pins.list'));
      expect(pinsCall).toBeDefined();

      const text = responseUrlCaptures[0]?.body.text as string;
      expect(text).toContain('Pinned items');
      expect(text).toContain('pinned message');
    });
  });

  // ── /oc team ────────────────────────────────────────────────────────────

  describe('/oc team', () => {
    it('lists team members', async () => {
      await invokeCommand('team devteam');
      await new Promise((r) => setTimeout(r, 100));

      const groupsCall = slackApiCaptures.find((c) =>
        c.url.includes('usergroups.list') && !c.url.includes('usergroups.users.list'),
      );
      expect(groupsCall).toBeDefined();

      const usersCall = slackApiCaptures.find((c) => c.url.includes('usergroups.users.list'));
      expect(usersCall).toBeDefined();

      const text = responseUrlCaptures[0]?.body.text as string;
      expect(text).toContain('Dev Team');
      expect(text).toContain('devteam');
      expect(text).toContain('members');
    });
  });

  // ── /oc bookmark ────────────────────────────────────────────────────────

  describe('/oc bookmark', () => {
    it('adds a bookmark', async () => {
      await invokeCommand('bookmark https://docs.example.com Project Docs');
      await new Promise((r) => setTimeout(r, 50));

      const bmCall = slackApiCaptures.find((c) => c.url.includes('bookmarks.add'));
      expect(bmCall).toBeDefined();

      const text = responseUrlCaptures[0]?.body.text as string;
      expect(text).toContain('Bookmark added');
      expect(text).toContain('docs.example.com');
    });
  });

  // ── /oc bookmarks ──────────────────────────────────────────────────────

  describe('/oc bookmarks', () => {
    it('lists channel bookmarks', async () => {
      await invokeCommand('bookmarks');
      await new Promise((r) => setTimeout(r, 50));

      const bmCall = slackApiCaptures.find((c) => c.url.includes('bookmarks.list'));
      expect(bmCall).toBeDefined();

      const text = responseUrlCaptures[0]?.body.text as string;
      expect(text).toContain('Channel Bookmarks');
      expect(text).toContain('Docs');
      expect(text).toContain('CI');
    });
  });

  // ── /oc <free-form prompt> ──────────────────────────────────────────────

  describe('/oc <free-form prompt>', () => {
    it('returns working acknowledgement for a prompt', async () => {
      const engine = makeEngine();
      const { body } = await invokeCommand('What is the meaning of life?', undefined, undefined, engine);
      expect(body.response_type).toBe('in_channel');
      expect(body.text).toContain('Working on it');
    });

    it('calls engine.processMessage for free-form prompts', async () => {
      const engine = makeEngine();
      await invokeCommand('Explain how this codebase works', undefined, undefined, engine);
      await new Promise((r) => setTimeout(r, 50));

      expect(engine.processMessage).toHaveBeenCalledTimes(1);
      const msg = (engine.processMessage as ReturnType<typeof vi.fn>).mock.calls[0][0] as NormalizedMessage;
      expect(msg.content).toBe('Explain how this codebase works');
      expect(msg.channelType).toBe('slack');
      expect(msg.platformUser.id).toBe('U_TESTER');
    });
  });

  // ── Edge cases ──────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('returns help for unknown config subcommand', async () => {
      const { body } = await invokeCommand('config unknown');
      expect(body.text).toContain('OpenCode Slash Commands');
    });

    it('treats bare "channel" as a free-form prompt', async () => {
      const engine = makeEngine();
      const { body } = await invokeCommand('channel', undefined, undefined, engine);
      // "channel" without trailing space doesn't match "channel " prefix,
      // so it falls through to the free-form prompt handler
      expect(body.response_type).toBe('in_channel');
      expect(body.text).toContain('Working on it');
    });

    it('returns usage for empty prompt', async () => {
      // "help" is returned for empty text
      const { body } = await invokeCommand('');
      expect(body.text).toContain('OpenCode Slash Commands');
    });

    it('auto-joins channel when botToken is present', async () => {
      await invokeCommand('status');
      await new Promise((r) => setTimeout(r, 50));

      const joinCall = slackApiCaptures.find((c) => c.url.includes('conversations.join'));
      expect(joinCall).toBeDefined();
    });

    it('handles missing botToken gracefully in channel commands', async () => {
      const config = makeConfig({ credentials: { signingSecret: '' } });
      await invokeCommand('pin', config);
      await new Promise((r) => setTimeout(r, 50));

      const text = responseUrlCaptures[0]?.body.text as string;
      expect(text).toContain('Missing bot token');
    });
  });
});
