/**
 * EventBridge — Bridges OpenCode permission/question events to
 * platform-specific UI via the ChannelAdapter pattern.
 *
 * When the agent requests permission (e.g. to run a bash command):
 *  1. The SSE stream yields a permission event
 *  2. EventBridge calls adapter.sendPermissionRequest() to render
 *     approve/reject buttons in the user's channel
 *  3. The user clicks a button → the adapter calls
 *     replyPermissionRequest() from pending-permissions
 *  4. EventBridge picks up the result and calls
 *     OpenCodeClient.replyPermission() to unblock the agent
 */

import type {
  ChannelConfig,
  NormalizedMessage,
  PermissionRequest,
} from './types.js';
import type { OpenCodeClient } from './opencode-client.js';
import { createPermissionRequest } from './pending-permissions.js';

// ─── Adapter interface (minimal contract for event bridging) ────────────────

/**
 * Minimal adapter surface that the EventBridge needs.
 * Platform adapter packages implement the full ChannelAdapter interface
 * which extends this.
 */
export interface EventBridgeAdapter {
  /**
   * Send an interactive permission request to the user's channel.
   * The adapter should render approve/reject buttons and, when clicked,
   * call `replyPermissionRequest(permissionId, approved)` from
   * `./pending-permissions.ts`.
   */
  sendPermissionRequest(
    config: ChannelConfig,
    message: NormalizedMessage,
    permission: PermissionRequest,
  ): Promise<void>;
}

// ─── EventBridge ────────────────────────────────────────────────────────────

export class EventBridge {
  /**
   * Handle a permission event from the SSE stream.
   *
   * Orchestrates the full flow:
   *  1. Show permission UI to the user via the adapter
   *  2. Wait for user response (with 5-min timeout)
   *  3. Relay approval/rejection to the OpenCode server
   *
   * @returns Whether the user approved the permission
   */
  async handlePermissionEvent(
    config: ChannelConfig,
    message: NormalizedMessage,
    permission: PermissionRequest,
    adapter: EventBridgeAdapter,
    client: OpenCodeClient,
  ): Promise<boolean> {
    // 1. Register a pending promise that will be resolved when the user
    //    clicks approve or reject in the channel UI.
    const approvalPromise = createPermissionRequest(permission.id);

    // 2. Send the interactive permission request to the user's channel.
    //    This is fire-and-forget from the bridge's perspective — the adapter
    //    is responsible for rendering buttons and calling
    //    replyPermissionRequest() when the user responds.
    try {
      await adapter.sendPermissionRequest(config, message, permission);
    } catch (err) {
      console.error(
        `[EventBridge] Failed to send permission request UI for ${permission.id}:`,
        err,
      );
      // If we can't even show the UI, auto-reject
      await client.replyPermission(permission.id, false);
      return false;
    }

    // 3. Wait for the user to respond (or timeout at 5 min)
    const approved = await approvalPromise;

    // 4. Relay the decision to the OpenCode server
    try {
      await client.replyPermission(permission.id, approved);
    } catch (err) {
      console.error(
        `[EventBridge] Failed to relay permission reply for ${permission.id}:`,
        err,
      );
    }

    return approved;
  }
}
