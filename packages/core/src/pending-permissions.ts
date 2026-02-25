/**
 * Promise-based store for pending permission requests.
 *
 * When the agent asks for permission (e.g. to run a bash command),
 * we store a pending promise here. The interactivity handler resolves
 * or rejects it when the user clicks Approve / Reject in the channel UI.
 *
 * Each request has a 5-minute timeout to prevent memory leaks.
 */

const PERMISSION_TIMEOUT_MS = 5 * 60 * 1000;

interface PendingEntry {
  resolve: (approved: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, PendingEntry>();

/**
 * Create a pending permission request.
 * Returns a promise that resolves to `true` (approved) or `false` (rejected / timed-out).
 */
export function createPermissionRequest(requestId: string): Promise<boolean> {
  // If there's already one pending for this ID, reject the old one
  const existing = pending.get(requestId);
  if (existing) {
    existing.resolve(false);
    clearTimeout(existing.timer);
    pending.delete(requestId);
  }

  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      resolve(false); // Auto-reject on timeout
    }, PERMISSION_TIMEOUT_MS);

    pending.set(requestId, { resolve, timer });
  });
}

/**
 * Reply to a pending permission request.
 * Returns `true` if the request was found and resolved, `false` if not found
 * (expired or already handled).
 */
export function replyPermissionRequest(requestId: string, approved: boolean): boolean {
  const entry = pending.get(requestId);
  if (!entry) return false;

  clearTimeout(entry.timer);
  pending.delete(requestId);
  entry.resolve(approved);
  return true;
}

/**
 * Check if a permission request is still pending.
 */
export function isPermissionPending(requestId: string): boolean {
  return pending.has(requestId);
}

/**
 * Get the number of pending permission requests (useful for debugging).
 */
export function pendingCount(): number {
  return pending.size;
}
