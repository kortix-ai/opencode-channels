import { describe, it, expect, vi } from 'vitest';
import { EventBridge, type EventBridgeAdapter } from '../src/event-bridge.js';
import { replyPermissionRequest } from '../src/pending-permissions.js';
import type { ChannelConfig, NormalizedMessage, PermissionRequest } from '../src/types.js';
import type { OpenCodeClient } from '../src/opencode-client.js';

// ── Factories for mock objects ───────────────────────────────────────────────

function makeConfig(overrides: Partial<ChannelConfig> = {}): ChannelConfig {
  return {
    id: 'cfg-1',
    channelType: 'slack',
    name: 'Test Channel',
    enabled: true,
    credentials: {},
    platformConfig: {},
    metadata: {},
    sessionStrategy: 'per-user',
    systemPrompt: null,
    agentName: null,
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeMessage(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    externalId: 'ext-1',
    channelType: 'slack',
    channelConfigId: 'cfg-1',
    chatType: 'dm',
    content: 'test message',
    attachments: [],
    platformUser: { id: 'user-1', name: 'Test User' },
    ...overrides,
  };
}

function makePermission(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    id: `perm-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    tool: 'bash',
    description: 'Run command: ls -la',
    ...overrides,
  };
}

function makeMockClient() {
  return {
    replyPermission: vi.fn().mockResolvedValue(undefined),
    isReady: vi.fn().mockResolvedValue(true),
  } as unknown as OpenCodeClient & {
    replyPermission: ReturnType<typeof vi.fn>;
  };
}

function makeMockAdapter(overrides: Partial<EventBridgeAdapter> = {}): EventBridgeAdapter {
  return {
    sendPermissionRequest: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('EventBridge', () => {
  it('user approves → returns true, client.replyPermission called with true', async () => {
    const bridge = new EventBridge();
    const config = makeConfig();
    const message = makeMessage();
    const permission = makePermission();
    const client = makeMockClient();

    // Adapter: when sendPermissionRequest is called, simulate user clicking "approve"
    const adapter = makeMockAdapter({
      sendPermissionRequest: vi.fn().mockImplementation(async () => {
        // Simulate async user response (e.g. button click)
        setTimeout(() => replyPermissionRequest(permission.id, true), 10);
      }),
    });

    const result = await bridge.handlePermissionEvent(config, message, permission, adapter, client);

    expect(result).toBe(true);
    expect(adapter.sendPermissionRequest).toHaveBeenCalledWith(config, message, permission);
    expect(client.replyPermission).toHaveBeenCalledWith(permission.id, true);
  });

  it('user rejects → returns false, client.replyPermission called with false', async () => {
    const bridge = new EventBridge();
    const config = makeConfig();
    const message = makeMessage();
    const permission = makePermission();
    const client = makeMockClient();

    const adapter = makeMockAdapter({
      sendPermissionRequest: vi.fn().mockImplementation(async () => {
        setTimeout(() => replyPermissionRequest(permission.id, false), 10);
      }),
    });

    const result = await bridge.handlePermissionEvent(config, message, permission, adapter, client);

    expect(result).toBe(false);
    expect(client.replyPermission).toHaveBeenCalledWith(permission.id, false);
  });

  it('adapter throws error → auto-rejects, returns false', async () => {
    const bridge = new EventBridge();
    const config = makeConfig();
    const message = makeMessage();
    const permission = makePermission();
    const client = makeMockClient();

    const adapter = makeMockAdapter({
      sendPermissionRequest: vi.fn().mockRejectedValue(new Error('Slack API down')),
    });

    // Suppress expected console.error
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await bridge.handlePermissionEvent(config, message, permission, adapter, client);

    expect(result).toBe(false);
    // Auto-reject: replyPermission should be called with false
    expect(client.replyPermission).toHaveBeenCalledWith(permission.id, false);

    consoleSpy.mockRestore();
  });

  it('client relay failure → logs error but still returns the approval result', async () => {
    const bridge = new EventBridge();
    const config = makeConfig();
    const message = makeMessage();
    const permission = makePermission();

    const client = makeMockClient();
    // replyPermission will throw
    client.replyPermission.mockRejectedValue(new Error('Network error'));

    const adapter = makeMockAdapter({
      sendPermissionRequest: vi.fn().mockImplementation(async () => {
        setTimeout(() => replyPermissionRequest(permission.id, true), 10);
      }),
    });

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await bridge.handlePermissionEvent(config, message, permission, adapter, client);

    // The approval result should still be returned despite relay failure
    expect(result).toBe(true);
    expect(client.replyPermission).toHaveBeenCalledWith(permission.id, true);
    expect(consoleSpy).toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  it('adapter receives the correct config, message, and permission objects', async () => {
    const bridge = new EventBridge();
    const config = makeConfig({ id: 'custom-cfg', name: 'Custom' });
    const message = makeMessage({ externalId: 'ext-custom', content: 'custom text' });
    const permission = makePermission({ tool: 'write', description: 'Write file: foo.ts' });
    const client = makeMockClient();

    const adapter = makeMockAdapter({
      sendPermissionRequest: vi.fn().mockImplementation(async () => {
        setTimeout(() => replyPermissionRequest(permission.id, true), 10);
      }),
    });

    await bridge.handlePermissionEvent(config, message, permission, adapter, client);

    expect(adapter.sendPermissionRequest).toHaveBeenCalledWith(config, message, permission);
    const [calledConfig, calledMessage, calledPermission] = (
      adapter.sendPermissionRequest as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    expect(calledConfig.id).toBe('custom-cfg');
    expect(calledMessage.content).toBe('custom text');
    expect(calledPermission.tool).toBe('write');
  });
});
