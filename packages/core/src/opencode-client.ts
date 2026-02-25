/**
 * OpenCodeClient — HTTP/SSE client for a local OpenCode server.
 *
 * Ported from SandboxConnector with all Daytona/cloud-provider
 * dependencies removed. Connects directly to a baseUrl.
 */

import type { StreamEvent } from './types.js';

// ─── Tool / file extraction helpers ─────────────────────────────────────────

const FILE_PRODUCING_TOOLS = new Set(['show', 'show_user', 'show-user']);
const FILE_ITEM_TYPES = new Set(['file', 'image']);

function guessImageMime(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  const mimes: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    webp: 'image/webp',
  };
  return mimes[ext] || 'image/png';
}

function extractFileFromToolOutput(
  toolName: string,
  state: Record<string, unknown>,
): { name: string; url: string; mimeType?: string } | null {
  const input = state.input as Record<string, unknown> | undefined;
  const output = state.output as string | undefined;

  if (toolName === 'show' || toolName === 'show_user' || toolName === 'show-user') {
    const itemType = (input?.type as string) || '';
    let filePath: string | undefined;
    let publicUrl: string | undefined;

    if (output) {
      try {
        const parsed = JSON.parse(output);
        const entry = parsed.entry as Record<string, unknown> | undefined;
        if (entry) {
          publicUrl = entry.publicUrl as string | undefined;
          const entryType = (entry.type as string) || '';
          if (FILE_ITEM_TYPES.has(entryType) && entry.path) {
            filePath = entry.path as string;
          }
        }
      } catch {
        // ignore parse errors
      }
    }

    if (!filePath && FILE_ITEM_TYPES.has(itemType) && input?.path) {
      filePath = input.path as string;
    }

    if (publicUrl || filePath) {
      const name = (filePath || publicUrl || 'file').split('/').pop()?.split('?')[0] || 'file';
      const url = publicUrl || filePath!;
      const mimeType = itemType === 'image' ? guessImageMime(name) : undefined;
      return { name, url, mimeType };
    }
  }

  return null;
}

// ─── Client config ──────────────────────────────────────────────────────────

export interface OpenCodeClientConfig {
  baseUrl: string;
  headers?: Record<string, string>;
}

interface CreateSessionResponse {
  id: string;
  [key: string]: unknown;
}

// ─── OpenCodeClient ─────────────────────────────────────────────────────────

export class OpenCodeClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;

  constructor(config: OpenCodeClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.headers = {
      'Content-Type': 'application/json',
      ...config.headers,
    };
  }

  // ── Health ──────────────────────────────────────────────────────────────

  async isReady(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/global/health`, {
        method: 'GET',
        headers: this.headers,
        signal: AbortSignal.timeout(5000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  // ── Session management ─────────────────────────────────────────────────

  async createSession(agentName?: string): Promise<string> {
    const body: Record<string, unknown> = {};
    if (agentName) {
      body.agent = agentName;
    }

    const res = await fetch(`${this.baseUrl}/session`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Failed to create session: ${res.status} ${errText}`);
    }

    const session = (await res.json()) as CreateSessionResponse;
    return session.id;
  }

  // ── Non-streaming prompt ───────────────────────────────────────────────

  async prompt(
    sessionId: string,
    content: string,
    agentName?: string,
    model?: { providerID: string; modelID: string },
  ): Promise<string> {
    let fullText = '';

    for await (const event of this.promptStreaming(sessionId, content, agentName, model)) {
      if (event.type === 'text' && event.data) {
        fullText += event.data;
      }
      if (event.type === 'error') {
        throw new Error(`Agent error: ${event.data}`);
      }
    }

    return fullText;
  }

  // ── Streaming prompt (SSE) ─────────────────────────────────────────────

  async *promptStreaming(
    sessionId: string,
    content: string,
    agentName?: string,
    model?: { providerID: string; modelID: string },
    fileParts?: Array<{ type: 'file'; mime: string; url: string; filename?: string }>,
  ): AsyncGenerator<StreamEvent> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 300_000); // 5 min

    try {
      // 1. Connect to the SSE event stream
      const sseHeaders: Record<string, string> = { Accept: 'text/event-stream' };
      // Carry over auth headers but NOT Content-Type (this is a GET request)
      for (const [k, v] of Object.entries(this.headers)) {
        if (k.toLowerCase() !== 'content-type') sseHeaders[k] = v;
      }
      const sseRes = await fetch(`${this.baseUrl}/event`, {
        method: 'GET',
        headers: sseHeaders,
        signal: controller.signal,
      });

      if (!sseRes.ok || !sseRes.body) {
        throw new Error(`Failed to connect to SSE: ${sseRes.status}`);
      }

      // 2. Build prompt body
      const parts: Array<Record<string, unknown>> = [{ type: 'text', text: content }];
      if (fileParts && fileParts.length > 0) {
        for (const fp of fileParts) {
          parts.push({ type: 'file', mime: fp.mime, url: fp.url, filename: fp.filename });
        }
      }
      const promptBody: Record<string, unknown> = { parts };
      if (agentName) {
        promptBody.agent = agentName;
      }
      if (model) {
        promptBody.model = model;
      }

      // 3. Send prompt (async, don't block SSE reading)
      const promptPromise = fetch(`${this.baseUrl}/session/${sessionId}/prompt_async`, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(promptBody),
        signal: controller.signal,
      });

      // Tracking state
      const assistantMsgIds = new Set<string>();
      const processedToolCalls = new Set<string>();
      let sawBusy = false;
      let gotText = false;

      const reader = sseRes.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      // 4. Await prompt dispatch response
      const promptRes = await promptPromise;
      if (!promptRes.ok) {
        const errText = await promptRes.text();
        throw new Error(`Failed to send prompt: ${promptRes.status} ${errText}`);
      }

      // 5. Parse SSE stream
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        while (buffer.includes('\n')) {
          const newlineIdx = buffer.indexOf('\n');
          const line = buffer.slice(0, newlineIdx).trim();
          buffer = buffer.slice(newlineIdx + 1);

          if (!line.startsWith('data:')) continue;

          const dataStr = line.slice(5).trim();
          if (!dataStr) continue;

          let data: Record<string, unknown>;
          try {
            data = JSON.parse(dataStr);
          } catch {
            continue;
          }

          const evt = data.type as string;
          const props = (data.properties || {}) as Record<string, unknown>;

          // Extract session ID from various nested locations
          const sid =
            (props.sessionID as string) ||
            ((props.part as Record<string, unknown>)?.sessionID as string) ||
            ((props.info as Record<string, unknown>)?.sessionID as string);

          // Filter events to only our session
          if (sid && sid !== sessionId) continue;

          // ── message.updated → track assistant message IDs ──────────
          if (evt === 'message.updated') {
            const info = (props.info || {}) as Record<string, unknown>;
            if (info.role === 'assistant') {
              assistantMsgIds.add(info.id as string);
            }
          }

          // ── message.part.delta → text content deltas ─────────────
          if (evt === 'message.part.delta') {
            const field = props.field as string;
            const delta = props.delta as string;
            if (delta) {
              gotText = true;
              sawBusy = true;
              yield { type: 'text', data: delta };
            }
          }

          // ── message.part.updated → files, tool output ─────────────
          if (evt === 'message.part.updated') {
            const part = (props.part || {}) as Record<string, unknown>;
            const delta = props.delta as string;
            const msgId = part.messageID as string;

            // Only process parts from assistant messages
            if (msgId && !assistantMsgIds.has(msgId)) continue;

            // Text delta (fallback for older OpenCode versions)
            if (part.type === 'text' && delta) {
              gotText = true;
              sawBusy = true;
              yield { type: 'text', data: delta };
            }

            // File part
            if (part.type === 'file') {
              yield {
                type: 'file',
                file: {
                  name: (part.filename as string) || 'file',
                  url: (part.url as string) || '',
                  mimeType: part.mimeType as string | undefined,
                },
              };
            }

            // Tool output (file-producing tools)
            if (part.type === 'tool') {
              const toolName = part.tool as string;
              const callID = (part.callID || part.id) as string;
              const state = part.state as Record<string, unknown> | undefined;

              if (
                FILE_PRODUCING_TOOLS.has(toolName) &&
                state?.status === 'completed' &&
                callID &&
                !processedToolCalls.has(callID)
              ) {
                processedToolCalls.add(callID);
                const fileEvent = extractFileFromToolOutput(toolName, state);
                if (fileEvent) {
                  yield { type: 'file', file: fileEvent };
                }
              }
            }
          }

          // ── permission.asked / permission.requested ────────────────
          if (evt === 'permission.asked' || evt === 'permission.requested') {
            const permProps = props as Record<string, unknown>;
            yield {
              type: 'permission',
              permission: {
                id: (permProps.id as string) || (permProps.requestID as string) || '',
                tool: (permProps.tool as string) || (permProps.toolName as string) || 'unknown',
                description: (permProps.description as string) || (permProps.message as string) || '',
              },
            };
          }

          // ── session.status → busy indicator ────────────────────────
          if (evt === 'session.status') {
            const status = (props.status as Record<string, unknown>)?.type as string;
            if (status === 'busy') {
              sawBusy = true;
              yield { type: 'busy' };
            }
          }

          // ── session.idle → stream complete ─────────────────────────
          if (evt === 'session.idle') {
            if (sawBusy || gotText) {
              yield { type: 'done' };
              return;
            }
          }

          // ── session.error → stream error ───────────────────────────
          if (evt === 'session.error') {
            const err =
              ((props.error as Record<string, unknown>)?.data as Record<string, unknown>)
                ?.message as string;
            yield { type: 'error', data: err || 'unknown error' };
            return;
          }
        }
      }
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  }

  // ── Permission reply ───────────────────────────────────────────────────

  async replyPermission(permissionId: string, approved: boolean): Promise<void> {
    try {
      const res = await fetch(`${this.baseUrl}/permission/${permissionId}/reply`, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({ approved }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        const errText = await res.text();
        console.error(`[OpenCodeClient] Permission reply failed: ${res.status} ${errText}`);
      }
    } catch (err) {
      console.error('[OpenCodeClient] Permission reply error:', err);
    }
  }

  // ── File downloads ─────────────────────────────────────────────────────

  async downloadFile(fileUrl: string): Promise<Buffer | null> {
    try {
      if (!fileUrl.startsWith('http')) {
        let filePath = fileUrl;
        for (const prefix of ['/workspace/', '/home/daytona/', '/home/user/']) {
          if (filePath.startsWith(prefix)) {
            filePath = filePath.slice(prefix.length);
            break;
          }
        }
        if (filePath.startsWith('/')) {
          filePath = filePath.slice(1);
        }
        const result = await this.downloadFileByPath(filePath);
        if (result) return result;

        // Retry with filename only
        const fileName = fileUrl.split('/').pop();
        if (fileName && fileName !== filePath) {
          return await this.downloadFileByPath(fileName);
        }
        return null;
      }

      const res = await fetch(fileUrl, {
        headers: this.headers,
        signal: AbortSignal.timeout(30_000),
      });

      if (!res.ok) {
        console.warn(`[OpenCodeClient] File download failed: ${res.status} ${fileUrl}`);
        return null;
      }

      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      console.warn('[OpenCodeClient] File download error:', err);
      return null;
    }
  }

  async downloadFileByPath(filePath: string): Promise<Buffer | null> {
    try {
      const params = new URLSearchParams({ path: filePath });
      const res = await fetch(`${this.baseUrl}/file/content?${params}`, {
        headers: this.headers,
        signal: AbortSignal.timeout(30_000),
      });

      if (!res.ok) {
        console.warn(`[OpenCodeClient] File read failed: ${res.status} ${filePath}`);
        return null;
      }

      const data = (await res.json()) as { type: string; content: string; encoding?: string };

      if (data.encoding === 'base64') {
        return Buffer.from(data.content, 'base64');
      }

      return Buffer.from(data.content, 'utf-8');
    } catch (err) {
      console.warn('[OpenCodeClient] File read error:', err);
      return null;
    }
  }

  // ── Modified files ─────────────────────────────────────────────────────

  async getModifiedFiles(): Promise<Array<{ name: string; path: string }>> {
    try {
      const res = await fetch(`${this.baseUrl}/file/status`, {
        headers: this.headers,
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) {
        console.warn(`[OpenCodeClient] file/status failed: ${res.status}`);
        return [];
      }

      const data = await res.json();
      const files: Array<{ name: string; path: string }> = [];

      const entries = Array.isArray(data)
        ? data
        : Object.entries(data as Record<string, unknown>).map(([path, status]) => ({
            path,
            status,
          }));

      for (const entry of entries) {
        const entryPath = (
          typeof entry === 'string' ? entry : (entry as Record<string, unknown>).path || (entry as Record<string, unknown>).file
        ) as string | undefined;
        if (!entryPath) continue;
        // Skip hidden files and node_modules
        if (entryPath.startsWith('.') || entryPath.includes('node_modules') || entryPath.includes('/.'))
          continue;

        const ext = entryPath.split('.').pop()?.toLowerCase() || '';
        const isOutputFile =
          /^(md|txt|pdf|html|csv|json|xml|doc|docx|xlsx|pptx|png|jpg|jpeg|gif|svg|mp3|mp4|wav)$/.test(
            ext,
          );
        if (!isOutputFile) continue;

        const name = entryPath.split('/').pop() || entryPath;
        files.push({ name, path: entryPath });
      }

      return files;
    } catch (err) {
      console.warn('[OpenCodeClient] Failed to get modified files:', err);
      return [];
    }
  }

  // ── Session abort ──────────────────────────────────────────────────────

  async abort(sessionId: string): Promise<void> {
    try {
      await fetch(`${this.baseUrl}/session/${sessionId}/abort`, {
        method: 'POST',
        headers: this.headers,
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      // Swallow abort errors
    }
  }

  // ── Providers ──────────────────────────────────────────────────────────

  async listProviders(): Promise<
    Array<{ id: string; name: string; models: Array<{ id: string; name: string }> }>
  > {
    try {
      const res = await fetch(`${this.baseUrl}/config/providers`, {
        method: 'GET',
        headers: this.headers,
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) {
        console.warn(`[OpenCodeClient] listProviders failed: ${res.status}`);
        return [];
      }

      const data = await res.json();
      const rawProviders: unknown[] = Array.isArray(data)
        ? data
        : ((data as Record<string, unknown>).providers as unknown[]) || [];

      return rawProviders.map((p: unknown) => {
        const provider = p as Record<string, unknown>;
        const modelsMap = (provider.models || {}) as Record<string, unknown>;
        const models = Object.values(modelsMap).map((m: unknown) => {
          const model = m as Record<string, unknown>;
          return {
            id: (model.id as string) || '',
            name: (model.name as string) || (model.id as string) || '',
          };
        });
        return {
          id: (provider.id as string) || '',
          name: (provider.name as string) || (provider.id as string) || '',
          models,
        };
      });
    } catch (err) {
      console.warn('[OpenCodeClient] listProviders error:', err);
      return [];
    }
  }

  // ── Agents ─────────────────────────────────────────────────────────────

  async listAgents(): Promise<Array<{ name: string; description?: string; mode?: string }>> {
    try {
      const res = await fetch(`${this.baseUrl}/agent`, {
        method: 'GET',
        headers: this.headers,
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) {
        console.warn(`[OpenCodeClient] listAgents failed: ${res.status}`);
        return [];
      }

      const data = await res.json();
      const agents: unknown[] = Array.isArray(data)
        ? data
        : ((data as Record<string, unknown>).agents as unknown[]) ||
          Object.values(data as Record<string, unknown>);

      return agents.map((a: unknown) => {
        const agent = a as Record<string, unknown>;
        return {
          name: (agent.name as string) || '',
          description: agent.description as string | undefined,
          mode: agent.mode as string | undefined,
        };
      });
    } catch (err) {
      console.warn('[OpenCodeClient] listAgents error:', err);
      return [];
    }
  }

  // ── Session diff ───────────────────────────────────────────────────────

  async getSessionDiff(sessionId: string): Promise<string> {
    try {
      const res = await fetch(`${this.baseUrl}/session/${sessionId}/diff`, {
        method: 'GET',
        headers: this.headers,
        signal: AbortSignal.timeout(15_000),
      });

      if (!res.ok) {
        console.warn(`[OpenCodeClient] getSessionDiff failed: ${res.status}`);
        return '';
      }

      const data = await res.json();
      return typeof data === 'string'
        ? data
        : (data as Record<string, unknown>).diff as string ||
            (data as Record<string, unknown>).content as string ||
            JSON.stringify(data, null, 2);
    } catch (err) {
      console.warn('[OpenCodeClient] getSessionDiff error:', err);
      return '';
    }
  }

  // ── Session sharing ────────────────────────────────────────────────────

  async shareSession(sessionId: string): Promise<{ shareUrl: string } | null> {
    try {
      const res = await fetch(`${this.baseUrl}/session/${sessionId}/share`, {
        method: 'POST',
        headers: this.headers,
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) {
        console.warn(`[OpenCodeClient] shareSession failed: ${res.status}`);
        return null;
      }

      const data = (await res.json()) as Record<string, unknown>;
      const shareUrl = (data.shareUrl || data.share_url || data.url) as string;
      if (!shareUrl) return null;
      return { shareUrl };
    } catch (err) {
      console.warn('[OpenCodeClient] shareSession error:', err);
      return null;
    }
  }
}
