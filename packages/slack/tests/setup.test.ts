/**
 * Tests for packages/slack/src/setup.ts — Slack Manifest API auto-configuration.
 *
 * All Slack API calls are mocked via vi.stubGlobal('fetch').
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setupSlackApp, detectNgrokUrl } from '../src/setup.js';
import type { SlackManifest, SetupOptions, SetupResult } from '../src/setup.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function mockFetch(handler: (url: string, init?: RequestInit) => unknown) {
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
    const result = handler(urlStr, init);
    return {
      ok: true,
      json: async () => result,
    } as Response;
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

function mockFetchSequence(responses: Array<{ ok?: boolean; json: unknown }>) {
  let callIndex = 0;
  const fn = vi.fn(async () => {
    const resp = responses[callIndex] ?? responses[responses.length - 1];
    callIndex++;
    return {
      ok: resp.ok ?? true,
      json: async () => resp.json,
    } as Response;
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

const BASE_OPTIONS: SetupOptions = {
  appId: 'A_TEST_APP',
  refreshToken: 'xoxe-old-refresh-token',
  baseUrl: 'https://test.ngrok.app',
};

const MOCK_MANIFEST: SlackManifest = {
  _metadata: { major_version: 1, minor_version: 1 },
  display_information: { name: 'TestBot' },
  settings: {
    event_subscriptions: {
      request_url: 'https://old.example.com/slack/events',
      bot_events: ['app_mention'],
    },
    interactivity: {
      is_enabled: true,
      request_url: 'https://old.example.com/slack/interactivity',
    },
  },
  features: {
    bot_user: { display_name: 'TestBot', always_online: true },
    slash_commands: [
      {
        command: '/oc',
        description: 'Old command',
        url: 'https://old.example.com/slack/commands',
      },
    ],
  },
  oauth_config: {
    scopes: {
      bot: ['chat:write', 'commands'],
    },
  },
};

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('setup.ts', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
  });

  // ── setupSlackApp ─────────────────────────────────────────────────────

  describe('setupSlackApp', () => {
    it('should complete full setup flow successfully', async () => {
      const fetchFn = mockFetch((url, init) => {
        if (url.includes('tooling.tokens.rotate')) {
          return {
            ok: true,
            token: 'xoxe-access-token-123',
            refresh_token: 'xoxe-new-refresh-token',
          };
        }
        if (url.includes('apps.manifest.export')) {
          return { ok: true, manifest: MOCK_MANIFEST };
        }
        if (url.includes('apps.manifest.update')) {
          return { ok: true };
        }
        return { ok: false, error: 'unknown_method' };
      });

      const result = await setupSlackApp(BASE_OPTIONS);

      expect(result.ok).toBe(true);
      expect(result.newRefreshToken).toBe('xoxe-new-refresh-token');
      expect(result.manifest).toBeDefined();
      expect(result.error).toBeUndefined();

      // Verify 3 API calls were made
      expect(fetchFn).toHaveBeenCalledTimes(3);
    });

    it('should patch event subscription URL', async () => {
      let updatedManifest: SlackManifest | null = null;

      mockFetch((url) => {
        if (url.includes('tooling.tokens.rotate')) {
          return { ok: true, token: 'tok', refresh_token: 'new-rt' };
        }
        if (url.includes('apps.manifest.export')) {
          return { ok: true, manifest: MOCK_MANIFEST };
        }
        if (url.includes('apps.manifest.update')) {
          return { ok: true };
        }
        return { ok: false };
      });

      // Intercept the update call to capture the manifest
      const origFetch = globalThis.fetch;
      const wrappedFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
        if (urlStr.includes('apps.manifest.update') && init?.body) {
          const body = JSON.parse(init.body as string);
          updatedManifest = body.manifest;
        }
        return (origFetch as Function)(url, init);
      });
      vi.stubGlobal('fetch', wrappedFetch);

      const result = await setupSlackApp(BASE_OPTIONS);
      expect(result.ok).toBe(true);

      expect(updatedManifest).not.toBeNull();
      expect(updatedManifest!.settings?.event_subscriptions?.request_url).toBe(
        'https://test.ngrok.app/slack/events',
      );
    });

    it('should patch interactivity URL', async () => {
      let updatedManifest: SlackManifest | null = null;

      const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
        if (urlStr.includes('tooling.tokens.rotate')) {
          return { ok: true, json: async () => ({ ok: true, token: 'tok', refresh_token: 'rt' }) } as Response;
        }
        if (urlStr.includes('apps.manifest.export')) {
          return { ok: true, json: async () => ({ ok: true, manifest: MOCK_MANIFEST }) } as Response;
        }
        if (urlStr.includes('apps.manifest.update')) {
          if (init?.body) {
            const body = JSON.parse(init.body as string);
            updatedManifest = body.manifest;
          }
          return { ok: true, json: async () => ({ ok: true }) } as Response;
        }
        return { ok: true, json: async () => ({ ok: false }) } as Response;
      });
      vi.stubGlobal('fetch', fetchFn);

      await setupSlackApp(BASE_OPTIONS);

      expect(updatedManifest).not.toBeNull();
      expect(updatedManifest!.settings?.interactivity?.request_url).toBe(
        'https://test.ngrok.app/slack/interactivity',
      );
      expect(updatedManifest!.settings?.interactivity?.is_enabled).toBe(true);
    });

    it('should patch slash command URLs', async () => {
      let updatedManifest: SlackManifest | null = null;

      const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
        if (urlStr.includes('tooling.tokens.rotate')) {
          return { ok: true, json: async () => ({ ok: true, token: 'tok', refresh_token: 'rt' }) } as Response;
        }
        if (urlStr.includes('apps.manifest.export')) {
          return { ok: true, json: async () => ({ ok: true, manifest: MOCK_MANIFEST }) } as Response;
        }
        if (urlStr.includes('apps.manifest.update')) {
          if (init?.body) updatedManifest = JSON.parse(init.body as string).manifest;
          return { ok: true, json: async () => ({ ok: true }) } as Response;
        }
        return { ok: true, json: async () => ({ ok: false }) } as Response;
      });
      vi.stubGlobal('fetch', fetchFn);

      await setupSlackApp(BASE_OPTIONS);

      expect(updatedManifest!.features?.slash_commands).toBeDefined();
      expect(updatedManifest!.features?.slash_commands![0].url).toBe(
        'https://test.ngrok.app/slack/commands',
      );
      expect(updatedManifest!.features?.slash_commands![0].command).toBe('/oc');
    });

    it('should disable socket mode', async () => {
      let updatedManifest: SlackManifest | null = null;

      const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
        if (urlStr.includes('tooling.tokens.rotate')) {
          return { ok: true, json: async () => ({ ok: true, token: 'tok', refresh_token: 'rt' }) } as Response;
        }
        if (urlStr.includes('apps.manifest.export')) {
          return { ok: true, json: async () => ({ ok: true, manifest: MOCK_MANIFEST }) } as Response;
        }
        if (urlStr.includes('apps.manifest.update')) {
          if (init?.body) updatedManifest = JSON.parse(init.body as string).manifest;
          return { ok: true, json: async () => ({ ok: true }) } as Response;
        }
        return { ok: true, json: async () => ({ ok: false }) } as Response;
      });
      vi.stubGlobal('fetch', fetchFn);

      await setupSlackApp(BASE_OPTIONS);

      expect(updatedManifest!.settings?.socket_mode_enabled).toBe(false);
    });

    it('should add required bot scopes to oauth_config', async () => {
      let updatedManifest: SlackManifest | null = null;

      const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
        if (urlStr.includes('tooling.tokens.rotate')) {
          return { ok: true, json: async () => ({ ok: true, token: 'tok', refresh_token: 'rt' }) } as Response;
        }
        if (urlStr.includes('apps.manifest.export')) {
          return { ok: true, json: async () => ({ ok: true, manifest: MOCK_MANIFEST }) } as Response;
        }
        if (urlStr.includes('apps.manifest.update')) {
          if (init?.body) updatedManifest = JSON.parse(init.body as string).manifest;
          return { ok: true, json: async () => ({ ok: true }) } as Response;
        }
        return { ok: true, json: async () => ({ ok: false }) } as Response;
      });
      vi.stubGlobal('fetch', fetchFn);

      await setupSlackApp(BASE_OPTIONS);

      const scopes = (updatedManifest!.oauth_config?.scopes as { bot: string[] })?.bot;
      expect(scopes).toBeDefined();
      expect(scopes).toContain('chat:write');
      expect(scopes).toContain('commands');
      expect(scopes).toContain('app_mentions:read');
      expect(scopes).toContain('reactions:write');
      expect(scopes).toContain('files:read');
      expect(scopes).toContain('users:read');
    });

    it('should ensure bot_user exists even when manifest has none', async () => {
      const manifestWithoutBot: SlackManifest = {
        settings: {},
        features: {},
      };

      let updatedManifest: SlackManifest | null = null;

      const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
        if (urlStr.includes('tooling.tokens.rotate')) {
          return { ok: true, json: async () => ({ ok: true, token: 'tok', refresh_token: 'rt' }) } as Response;
        }
        if (urlStr.includes('apps.manifest.export')) {
          return { ok: true, json: async () => ({ ok: true, manifest: manifestWithoutBot }) } as Response;
        }
        if (urlStr.includes('apps.manifest.update')) {
          if (init?.body) updatedManifest = JSON.parse(init.body as string).manifest;
          return { ok: true, json: async () => ({ ok: true }) } as Response;
        }
        return { ok: true, json: async () => ({ ok: false }) } as Response;
      });
      vi.stubGlobal('fetch', fetchFn);

      await setupSlackApp(BASE_OPTIONS);

      expect(updatedManifest!.features?.bot_user).toBeDefined();
      expect(updatedManifest!.features?.bot_user?.display_name).toBe('OpenCode');
      expect(updatedManifest!.features?.bot_user?.always_online).toBe(true);
    });

    it('should support custom slash commands', async () => {
      let updatedManifest: SlackManifest | null = null;

      const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
        if (urlStr.includes('tooling.tokens.rotate')) {
          return { ok: true, json: async () => ({ ok: true, token: 'tok', refresh_token: 'rt' }) } as Response;
        }
        if (urlStr.includes('apps.manifest.export')) {
          return { ok: true, json: async () => ({ ok: true, manifest: MOCK_MANIFEST }) } as Response;
        }
        if (urlStr.includes('apps.manifest.update')) {
          if (init?.body) updatedManifest = JSON.parse(init.body as string).manifest;
          return { ok: true, json: async () => ({ ok: true }) } as Response;
        }
        return { ok: true, json: async () => ({ ok: false }) } as Response;
      });
      vi.stubGlobal('fetch', fetchFn);

      await setupSlackApp({
        ...BASE_OPTIONS,
        slashCommands: [
          { command: '/ai', description: 'AI helper', usageHint: '/ai [prompt]' },
          { command: '/ask', description: 'Ask a question' },
        ],
      });

      const cmds = updatedManifest!.features?.slash_commands;
      expect(cmds).toHaveLength(2);
      expect(cmds![0].command).toBe('/ai');
      expect(cmds![0].url).toBe('https://test.ngrok.app/slack/commands');
      expect(cmds![0].usage_hint).toBe('/ai [prompt]');
      expect(cmds![1].command).toBe('/ask');
      expect(cmds![1].usage_hint).toBe(''); // default empty
    });

    it('should support custom bot events', async () => {
      let updatedManifest: SlackManifest | null = null;

      const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
        if (urlStr.includes('tooling.tokens.rotate')) {
          return { ok: true, json: async () => ({ ok: true, token: 'tok', refresh_token: 'rt' }) } as Response;
        }
        if (urlStr.includes('apps.manifest.export')) {
          return { ok: true, json: async () => ({ ok: true, manifest: MOCK_MANIFEST }) } as Response;
        }
        if (urlStr.includes('apps.manifest.update')) {
          if (init?.body) updatedManifest = JSON.parse(init.body as string).manifest;
          return { ok: true, json: async () => ({ ok: true }) } as Response;
        }
        return { ok: true, json: async () => ({ ok: false }) } as Response;
      });
      vi.stubGlobal('fetch', fetchFn);

      await setupSlackApp({
        ...BASE_OPTIONS,
        botEvents: ['app_mention', 'message.im'],
      });

      expect(updatedManifest!.settings?.event_subscriptions?.bot_events).toEqual([
        'app_mention',
        'message.im',
      ]);
    });

    it('should return error when token rotation fails', async () => {
      mockFetch((url) => {
        if (url.includes('tooling.tokens.rotate')) {
          return { ok: false, error: 'invalid_refresh_token' };
        }
        return { ok: false };
      });

      const result = await setupSlackApp(BASE_OPTIONS);

      expect(result.ok).toBe(false);
      expect(result.error).toContain('Token rotation failed');
      expect(result.error).toContain('invalid_refresh_token');
      expect(result.newRefreshToken).toBeUndefined();
    });

    it('should return error but still include new refresh token when manifest export fails', async () => {
      mockFetch((url) => {
        if (url.includes('tooling.tokens.rotate')) {
          return { ok: true, token: 'tok', refresh_token: 'new-rt' };
        }
        if (url.includes('apps.manifest.export')) {
          return { ok: false, error: 'app_not_found' };
        }
        return { ok: false };
      });

      const result = await setupSlackApp(BASE_OPTIONS);

      expect(result.ok).toBe(false);
      expect(result.error).toContain('Manifest export failed');
      // CRITICAL: new refresh token must still be returned for persistence
      expect(result.newRefreshToken).toBe('new-rt');
    });

    it('should return error but still include new refresh token when manifest update fails', async () => {
      mockFetch((url) => {
        if (url.includes('tooling.tokens.rotate')) {
          return { ok: true, token: 'tok', refresh_token: 'new-rt' };
        }
        if (url.includes('apps.manifest.export')) {
          return { ok: true, manifest: MOCK_MANIFEST };
        }
        if (url.includes('apps.manifest.update')) {
          return {
            ok: false,
            errors: [{ message: 'invalid_url', pointer: '/settings/event_subscriptions/request_url' }],
          };
        }
        return { ok: false };
      });

      const result = await setupSlackApp(BASE_OPTIONS);

      expect(result.ok).toBe(false);
      expect(result.error).toContain('Manifest update failed');
      // CRITICAL: new refresh token must still be returned
      expect(result.newRefreshToken).toBe('new-rt');
    });

    it('should use Authorization header for manifest API calls', async () => {
      const headers: Record<string, string>[] = [];

      const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;

        if (init?.headers) {
          const h: Record<string, string> = {};
          if (init.headers instanceof Headers) {
            init.headers.forEach((v, k) => { h[k] = v; });
          } else if (typeof init.headers === 'object') {
            Object.assign(h, init.headers);
          }
          h._url = urlStr;
          headers.push(h);
        }

        if (urlStr.includes('tooling.tokens.rotate')) {
          return { ok: true, json: async () => ({ ok: true, token: 'access-token-xyz', refresh_token: 'rt' }) } as Response;
        }
        if (urlStr.includes('apps.manifest.export')) {
          return { ok: true, json: async () => ({ ok: true, manifest: MOCK_MANIFEST }) } as Response;
        }
        if (urlStr.includes('apps.manifest.update')) {
          return { ok: true, json: async () => ({ ok: true }) } as Response;
        }
        return { ok: true, json: async () => ({ ok: false }) } as Response;
      });
      vi.stubGlobal('fetch', fetchFn);

      await setupSlackApp(BASE_OPTIONS);

      // Token rotation should use form-urlencoded, NOT Bearer auth
      const rotateCall = headers.find((h) => h._url?.includes('tooling.tokens.rotate'));
      expect(rotateCall?.['Content-Type']).toBe('application/x-www-form-urlencoded');
      expect(rotateCall?.Authorization).toBeUndefined();

      // Manifest export should use Bearer auth
      const exportCall = headers.find((h) => h._url?.includes('apps.manifest.export'));
      expect(exportCall?.Authorization).toBe('Bearer access-token-xyz');

      // Manifest update should use Bearer auth
      const updateCall = headers.find((h) => h._url?.includes('apps.manifest.update'));
      expect(updateCall?.Authorization).toBe('Bearer access-token-xyz');
    });

    it('should send refresh_token in form body for rotation', async () => {
      let rotateBody: string | null = null;

      const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
        if (urlStr.includes('tooling.tokens.rotate')) {
          rotateBody = init?.body as string;
          return { ok: true, json: async () => ({ ok: true, token: 'tok', refresh_token: 'rt' }) } as Response;
        }
        if (urlStr.includes('apps.manifest.export')) {
          return { ok: true, json: async () => ({ ok: true, manifest: MOCK_MANIFEST }) } as Response;
        }
        if (urlStr.includes('apps.manifest.update')) {
          return { ok: true, json: async () => ({ ok: true }) } as Response;
        }
        return { ok: true, json: async () => ({ ok: false }) } as Response;
      });
      vi.stubGlobal('fetch', fetchFn);

      await setupSlackApp(BASE_OPTIONS);

      expect(rotateBody).not.toBeNull();
      const params = new URLSearchParams(rotateBody!);
      expect(params.get('refresh_token')).toBe('xoxe-old-refresh-token');
    });

    it('should send app_id in manifest export body', async () => {
      let exportBody: Record<string, unknown> | null = null;

      const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
        if (urlStr.includes('tooling.tokens.rotate')) {
          return { ok: true, json: async () => ({ ok: true, token: 'tok', refresh_token: 'rt' }) } as Response;
        }
        if (urlStr.includes('apps.manifest.export')) {
          if (init?.body) exportBody = JSON.parse(init.body as string);
          return { ok: true, json: async () => ({ ok: true, manifest: MOCK_MANIFEST }) } as Response;
        }
        if (urlStr.includes('apps.manifest.update')) {
          return { ok: true, json: async () => ({ ok: true }) } as Response;
        }
        return { ok: true, json: async () => ({ ok: false }) } as Response;
      });
      vi.stubGlobal('fetch', fetchFn);

      await setupSlackApp(BASE_OPTIONS);

      expect(exportBody).not.toBeNull();
      expect(exportBody!.app_id).toBe('A_TEST_APP');
    });

    it('should not mutate the original manifest', async () => {
      const originalManifest = JSON.parse(JSON.stringify(MOCK_MANIFEST));

      mockFetch((url) => {
        if (url.includes('tooling.tokens.rotate')) {
          return { ok: true, token: 'tok', refresh_token: 'rt' };
        }
        if (url.includes('apps.manifest.export')) {
          return { ok: true, manifest: MOCK_MANIFEST };
        }
        if (url.includes('apps.manifest.update')) {
          return { ok: true };
        }
        return { ok: false };
      });

      await setupSlackApp(BASE_OPTIONS);

      // The original MOCK_MANIFEST object should not have been mutated
      expect(MOCK_MANIFEST.settings?.event_subscriptions?.request_url).toBe(
        originalManifest.settings.event_subscriptions.request_url,
      );
    });

    it('should handle manifest with no existing settings/features/oauth', async () => {
      const bareManifest: SlackManifest = {};

      let updatedManifest: SlackManifest | null = null;

      const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
        if (urlStr.includes('tooling.tokens.rotate')) {
          return { ok: true, json: async () => ({ ok: true, token: 'tok', refresh_token: 'rt' }) } as Response;
        }
        if (urlStr.includes('apps.manifest.export')) {
          return { ok: true, json: async () => ({ ok: true, manifest: bareManifest }) } as Response;
        }
        if (urlStr.includes('apps.manifest.update')) {
          if (init?.body) updatedManifest = JSON.parse(init.body as string).manifest;
          return { ok: true, json: async () => ({ ok: true }) } as Response;
        }
        return { ok: true, json: async () => ({ ok: false }) } as Response;
      });
      vi.stubGlobal('fetch', fetchFn);

      const result = await setupSlackApp(BASE_OPTIONS);

      expect(result.ok).toBe(true);
      expect(updatedManifest).not.toBeNull();
      expect(updatedManifest!.settings?.event_subscriptions?.request_url).toBe(
        'https://test.ngrok.app/slack/events',
      );
      expect(updatedManifest!.settings?.interactivity?.request_url).toBe(
        'https://test.ngrok.app/slack/interactivity',
      );
      expect(updatedManifest!.features?.slash_commands).toHaveLength(1);
      expect(updatedManifest!.features?.bot_user?.display_name).toBe('OpenCode');
      expect(updatedManifest!.oauth_config?.scopes).toBeDefined();
    });

    it('should merge existing bot scopes with required ones', async () => {
      const manifestWithExtraScopes: SlackManifest = {
        ...MOCK_MANIFEST,
        oauth_config: {
          scopes: {
            bot: ['chat:write', 'custom:scope', 'another:scope'],
          },
        },
      };

      let updatedManifest: SlackManifest | null = null;

      const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
        if (urlStr.includes('tooling.tokens.rotate')) {
          return { ok: true, json: async () => ({ ok: true, token: 'tok', refresh_token: 'rt' }) } as Response;
        }
        if (urlStr.includes('apps.manifest.export')) {
          return { ok: true, json: async () => ({ ok: true, manifest: manifestWithExtraScopes }) } as Response;
        }
        if (urlStr.includes('apps.manifest.update')) {
          if (init?.body) updatedManifest = JSON.parse(init.body as string).manifest;
          return { ok: true, json: async () => ({ ok: true }) } as Response;
        }
        return { ok: true, json: async () => ({ ok: false }) } as Response;
      });
      vi.stubGlobal('fetch', fetchFn);

      await setupSlackApp(BASE_OPTIONS);

      const scopes = (updatedManifest!.oauth_config?.scopes as { bot: string[] })?.bot;
      // Should preserve existing custom scopes
      expect(scopes).toContain('custom:scope');
      expect(scopes).toContain('another:scope');
      // And also have required scopes
      expect(scopes).toContain('app_mentions:read');
      expect(scopes).toContain('reactions:write');
      // No duplicates
      const chatWriteCount = scopes!.filter((s: string) => s === 'chat:write').length;
      expect(chatWriteCount).toBe(1);
    });

    it('should include default bot events when none specified', async () => {
      let updatedManifest: SlackManifest | null = null;

      const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
        if (urlStr.includes('tooling.tokens.rotate')) {
          return { ok: true, json: async () => ({ ok: true, token: 'tok', refresh_token: 'rt' }) } as Response;
        }
        if (urlStr.includes('apps.manifest.export')) {
          return { ok: true, json: async () => ({ ok: true, manifest: MOCK_MANIFEST }) } as Response;
        }
        if (urlStr.includes('apps.manifest.update')) {
          if (init?.body) updatedManifest = JSON.parse(init.body as string).manifest;
          return { ok: true, json: async () => ({ ok: true }) } as Response;
        }
        return { ok: true, json: async () => ({ ok: false }) } as Response;
      });
      vi.stubGlobal('fetch', fetchFn);

      await setupSlackApp(BASE_OPTIONS);

      const events = updatedManifest!.settings?.event_subscriptions?.bot_events;
      expect(events).toContain('app_mention');
      expect(events).toContain('message.channels');
      expect(events).toContain('message.im');
      expect(events).toContain('reaction_added');
      expect(events!.length).toBeGreaterThanOrEqual(5);
    });

    it('should format update error with errors array', async () => {
      mockFetch((url) => {
        if (url.includes('tooling.tokens.rotate')) {
          return { ok: true, token: 'tok', refresh_token: 'rt' };
        }
        if (url.includes('apps.manifest.export')) {
          return { ok: true, manifest: MOCK_MANIFEST };
        }
        if (url.includes('apps.manifest.update')) {
          return {
            ok: false,
            errors: [
              { message: 'invalid_url', pointer: '/settings/event_subscriptions/request_url' },
              { message: 'missing_scope', pointer: '/oauth_config/scopes/bot' },
            ],
          };
        }
        return { ok: false };
      });

      const result = await setupSlackApp(BASE_OPTIONS);

      expect(result.ok).toBe(false);
      expect(result.error).toContain('invalid_url');
      expect(result.error).toContain('missing_scope');
    });

    it('should format update error with string error', async () => {
      mockFetch((url) => {
        if (url.includes('tooling.tokens.rotate')) {
          return { ok: true, token: 'tok', refresh_token: 'rt' };
        }
        if (url.includes('apps.manifest.export')) {
          return { ok: true, manifest: MOCK_MANIFEST };
        }
        if (url.includes('apps.manifest.update')) {
          return { ok: false, error: 'invalid_manifest' };
        }
        return { ok: false };
      });

      const result = await setupSlackApp(BASE_OPTIONS);

      expect(result.ok).toBe(false);
      expect(result.error).toContain('invalid_manifest');
    });

    it('should preserve existing bot_user display_name', async () => {
      const manifestWithCustomBot: SlackManifest = {
        ...MOCK_MANIFEST,
        features: {
          ...MOCK_MANIFEST.features,
          bot_user: { display_name: 'MyCustomBot', always_online: false },
        },
      };

      let updatedManifest: SlackManifest | null = null;

      const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
        if (urlStr.includes('tooling.tokens.rotate')) {
          return { ok: true, json: async () => ({ ok: true, token: 'tok', refresh_token: 'rt' }) } as Response;
        }
        if (urlStr.includes('apps.manifest.export')) {
          return { ok: true, json: async () => ({ ok: true, manifest: manifestWithCustomBot }) } as Response;
        }
        if (urlStr.includes('apps.manifest.update')) {
          if (init?.body) updatedManifest = JSON.parse(init.body as string).manifest;
          return { ok: true, json: async () => ({ ok: true }) } as Response;
        }
        return { ok: true, json: async () => ({ ok: false }) } as Response;
      });
      vi.stubGlobal('fetch', fetchFn);

      await setupSlackApp(BASE_OPTIONS);

      // Existing bot_user should be preserved (patchManifestUrls only sets it if missing)
      expect(updatedManifest!.features?.bot_user?.display_name).toBe('MyCustomBot');
    });
  });

  // ── detectNgrokUrl ────────────────────────────────────────────────────

  describe('detectNgrokUrl', () => {
    it('should return HTTPS tunnel URL when available', async () => {
      mockFetch(() => ({
        tunnels: [
          { public_url: 'http://abc.ngrok.app', proto: 'http' },
          { public_url: 'https://abc.ngrok.app', proto: 'https' },
        ],
      }));

      const url = await detectNgrokUrl();
      expect(url).toBe('https://abc.ngrok.app');
    });

    it('should fall back to first tunnel if no HTTPS', async () => {
      mockFetch(() => ({
        tunnels: [
          { public_url: 'http://abc.ngrok.app', proto: 'http' },
        ],
      }));

      const url = await detectNgrokUrl();
      expect(url).toBe('http://abc.ngrok.app');
    });

    it('should return null when no tunnels exist', async () => {
      mockFetch(() => ({ tunnels: [] }));

      const url = await detectNgrokUrl();
      expect(url).toBeNull();
    });

    it('should return null when ngrok API is not reachable', async () => {
      const fn = vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      });
      vi.stubGlobal('fetch', fn);

      const url = await detectNgrokUrl();
      expect(url).toBeNull();
    });

    it('should return null when ngrok API returns non-OK response', async () => {
      const fn = vi.fn(async () => ({
        ok: false,
        json: async () => ({}),
      }));
      vi.stubGlobal('fetch', fn);

      const url = await detectNgrokUrl();
      expect(url).toBeNull();
    });

    it('should use custom ngrok API URL', async () => {
      let calledUrl = '';
      const fn = vi.fn(async (url: string | URL | Request) => {
        calledUrl = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
        return {
          ok: true,
          json: async () => ({
            tunnels: [{ public_url: 'https://custom.ngrok.app', proto: 'https' }],
          }),
        } as Response;
      });
      vi.stubGlobal('fetch', fn);

      const url = await detectNgrokUrl('http://localhost:5555');
      expect(url).toBe('https://custom.ngrok.app');
      expect(calledUrl).toBe('http://localhost:5555/api/tunnels');
    });

    it('should use timeout signal', async () => {
      let signalUsed = false;
      const fn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.signal) signalUsed = true;
        return {
          ok: true,
          json: async () => ({
            tunnels: [{ public_url: 'https://test.ngrok.app', proto: 'https' }],
          }),
        } as Response;
      });
      vi.stubGlobal('fetch', fn);

      await detectNgrokUrl();
      expect(signalUsed).toBe(true);
    });
  });
});
