/**
 * OpenCode HTTP/SSE client.
 *
 * Connects to a local OpenCode server and provides:
 *   - Session management (create, abort)
 *   - Streaming prompts via SSE → AsyncIterable<string>
 *   - Provider/model/agent listing
 *   - File downloads and git-status queries
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export interface OpenCodeClientConfig {
  baseUrl: string;
  headers?: Record<string, string>;
}

export interface FileOutput {
  name: string;
  path: string;
  content?: Buffer;
}

// ─── Tool / file extraction helpers ─────────────────────────────────────────

const FILE_PRODUCING_TOOLS = new Set(['show', 'show_user', 'show-user']);
const FILE_ITEM_TYPES = new Set(['file', 'image']);

function guessImageMime(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  const mimes: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp',
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
    let filePath: string | undefined;
    let publicUrl: string | undefined;
    const itemType = (input?.type as string) || '';

    if (output) {
      try {
        const parsed = JSON.parse(output);
        const entry = parsed.entry as Record<string, unknown> | undefined;
        if (entry) {
          publicUrl = entry.publicUrl as string | undefined;
          if (FILE_ITEM_TYPES.has((entry.type as string) || '') && entry.path) {
            filePath = entry.path as string;
          }
        }
      } catch { /* ignore */ }
    }

    if (!filePath && FILE_ITEM_TYPES.has(itemType) && input?.path) {
      filePath = input.path as string;
    }

    if (publicUrl || filePath) {
      const name = (filePath || publicUrl || 'file').split('/').pop()?.split('?')[0] || 'file';
      return { name, url: publicUrl || filePath!, mimeType: itemType === 'image' ? guessImageMime(name) : undefined };
    }
  }
  return null;
}

// ─── OpenCodeClient ─────────────────────────────────────────────────────────

export class OpenCodeClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;

  constructor(config: OpenCodeClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.headers = { 'Content-Type': 'application/json', ...config.headers };
  }

  // ── Health ────────────────────────────────────────────────────────────

  async isReady(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/global/health`, {
        signal: AbortSignal.timeout(5000),
      });
      return res.ok;
    } catch { return false; }
  }

  // ── Sessions ──────────────────────────────────────────────────────────

  async createSession(agentName?: string): Promise<string> {
    const body: Record<string, unknown> = {};
    if (agentName) body.agent = agentName;

    const res = await fetch(`${this.baseUrl}/session`, {
      method: 'POST', headers: this.headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`Failed to create session: ${res.status} ${await res.text()}`);
    const session = (await res.json()) as { id: string };
    return session.id;
  }

  async abort(sessionId: string): Promise<void> {
    try {
      await fetch(`${this.baseUrl}/session/${sessionId}/abort`, {
        method: 'POST', headers: this.headers, signal: AbortSignal.timeout(5000),
      });
    } catch { /* swallow */ }
  }

  // ── Streaming prompt → AsyncIterable<string> ─────────────────────────

  /**
   * Send a prompt and return an async iterable of text deltas.
   * This is the core bridge between OpenCode SSE and Chat SDK's streaming.
   *
   * Also collects file outputs detected during the stream.
   */
  async *promptStream(
    sessionId: string,
    content: string,
    options?: {
      agentName?: string;
      model?: { providerID: string; modelID: string };
      files?: Array<{ type: 'file'; mime: string; url: string; filename?: string }>;
      collectedFiles?: FileOutput[];
    },
  ): AsyncGenerator<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 300_000);

    try {
      // 1. Connect SSE
      const sseHeaders: Record<string, string> = { Accept: 'text/event-stream' };
      for (const [k, v] of Object.entries(this.headers)) {
        if (k.toLowerCase() !== 'content-type') sseHeaders[k] = v;
      }
      const sseRes = await fetch(`${this.baseUrl}/event`, {
        method: 'GET', headers: sseHeaders, signal: controller.signal,
      });
      if (!sseRes.ok || !sseRes.body) throw new Error(`SSE connect failed: ${sseRes.status}`);

      // 2. Build prompt body
      const parts: Array<Record<string, unknown>> = [{ type: 'text', text: content }];
      if (options?.files) {
        for (const fp of options.files) {
          parts.push({ type: 'file', mime: fp.mime, url: fp.url, filename: fp.filename });
        }
      }
      const promptBody: Record<string, unknown> = { parts };
      if (options?.agentName) promptBody.agent = options.agentName;
      if (options?.model) promptBody.model = options.model;

      // 3. Fire prompt async
      const promptRes = await fetch(`${this.baseUrl}/session/${sessionId}/prompt_async`, {
        method: 'POST', headers: this.headers,
        body: JSON.stringify(promptBody), signal: controller.signal,
      });
      if (!promptRes.ok) throw new Error(`Prompt failed: ${promptRes.status} ${await promptRes.text()}`);

      // 4. Parse SSE
      const reader = sseRes.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const assistantMsgIds = new Set<string>();
      const processedToolCalls = new Set<string>();
      let sawBusy = false;
      let gotText = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        while (buffer.includes('\n')) {
          const idx = buffer.indexOf('\n');
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line.startsWith('data:')) continue;

          const dataStr = line.slice(5).trim();
          if (!dataStr) continue;

          let data: Record<string, unknown>;
          try { data = JSON.parse(dataStr); } catch { continue; }

          const evt = data.type as string;
          const props = (data.properties || {}) as Record<string, unknown>;
          const sid = (props.sessionID as string)
            || ((props.part as Record<string, unknown>)?.sessionID as string)
            || ((props.info as Record<string, unknown>)?.sessionID as string);
          if (sid && sid !== sessionId) continue;

          // Track assistant messages
          if (evt === 'message.updated') {
            const info = (props.info || {}) as Record<string, unknown>;
            if (info.role === 'assistant') assistantMsgIds.add(info.id as string);
          }

          // Text deltas
          if (evt === 'message.part.delta') {
            const delta = props.delta as string;
            if (delta) { gotText = true; sawBusy = true; yield delta; }
          }

          // Part updates (text fallback, files, tools)
          if (evt === 'message.part.updated') {
            const part = (props.part || {}) as Record<string, unknown>;
            const delta = props.delta as string;
            const msgId = part.messageID as string;
            if (msgId && !assistantMsgIds.has(msgId)) continue;

            if (part.type === 'text' && delta) {
              gotText = true; sawBusy = true; yield delta;
            }
            if (part.type === 'file' && options?.collectedFiles) {
              options.collectedFiles.push({
                name: (part.filename as string) || 'file',
                path: (part.url as string) || '',
              });
            }
            if (part.type === 'tool') {
              const toolName = part.tool as string;
              const callID = (part.callID || part.id) as string;
              const state = part.state as Record<string, unknown> | undefined;
              if (FILE_PRODUCING_TOOLS.has(toolName) && state?.status === 'completed' && callID && !processedToolCalls.has(callID)) {
                processedToolCalls.add(callID);
                const fileEvent = extractFileFromToolOutput(toolName, state);
                if (fileEvent && options?.collectedFiles) {
                  options.collectedFiles.push({ name: fileEvent.name, path: fileEvent.url });
                }
              }
            }
          }

          // Session status
          if (evt === 'session.status') {
            const status = ((props.status as Record<string, unknown>)?.type as string);
            if (status === 'busy') sawBusy = true;
          }

          // Done
          if (evt === 'session.idle' && (sawBusy || gotText)) return;

          // Error
          if (evt === 'session.error') {
            const err = ((props.error as Record<string, unknown>)?.data as Record<string, unknown>)?.message as string;
            throw new Error(err || 'Agent error');
          }
        }
      }
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  }

  // ── Providers ─────────────────────────────────────────────────────────

  async listProviders(): Promise<Array<{ id: string; name: string; models: Array<{ id: string; name: string }> }>> {
    try {
      const res = await fetch(`${this.baseUrl}/config/providers`, {
        headers: this.headers, signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return [];
      const data = await res.json();
      const rawProviders: unknown[] = Array.isArray(data) ? data : ((data as Record<string, unknown>).providers as unknown[]) || [];
      return rawProviders.map((p: unknown) => {
        const provider = p as Record<string, unknown>;
        const modelsMap = (provider.models || {}) as Record<string, unknown>;
        const models = Object.values(modelsMap).map((m: unknown) => {
          const model = m as Record<string, unknown>;
          return { id: (model.id as string) || '', name: (model.name as string) || (model.id as string) || '' };
        });
        return { id: (provider.id as string) || '', name: (provider.name as string) || (provider.id as string) || '', models };
      });
    } catch { return []; }
  }

  // ── Agents ────────────────────────────────────────────────────────────

  async listAgents(): Promise<Array<{ name: string; description?: string }>> {
    try {
      const res = await fetch(`${this.baseUrl}/agent`, {
        headers: this.headers, signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return [];
      const data = await res.json();
      const agents: unknown[] = Array.isArray(data) ? data : Object.values(data as Record<string, unknown>);
      return agents.map((a: unknown) => {
        const agent = a as Record<string, unknown>;
        return { name: (agent.name as string) || '', description: agent.description as string | undefined };
      });
    } catch { return []; }
  }

  // ── Files ─────────────────────────────────────────────────────────────

  async getModifiedFiles(): Promise<FileOutput[]> {
    try {
      const res = await fetch(`${this.baseUrl}/file/status`, {
        headers: this.headers, signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return [];
      const data = await res.json();
      const entries = Array.isArray(data) ? data
        : Object.entries(data as Record<string, unknown>).map(([path, status]) => ({ path, status }));

      const files: FileOutput[] = [];
      for (const entry of entries) {
        const entryPath = (typeof entry === 'string' ? entry : (entry as Record<string, unknown>).path || (entry as Record<string, unknown>).file) as string | undefined;
        if (!entryPath) continue;
        if (entryPath.startsWith('.') || entryPath.includes('node_modules') || entryPath.includes('/.')) continue;
        const ext = entryPath.split('.').pop()?.toLowerCase() || '';
        if (!/^(md|txt|pdf|html|csv|json|xml|png|jpg|jpeg|gif|svg|mp3|mp4|wav)$/.test(ext)) continue;
        files.push({ name: entryPath.split('/').pop() || entryPath, path: entryPath });
      }
      return files;
    } catch { return []; }
  }

  async downloadFileByPath(filePath: string): Promise<Buffer | null> {
    try {
      const params = new URLSearchParams({ path: filePath });
      const res = await fetch(`${this.baseUrl}/file/content?${params}`, {
        headers: this.headers, signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { content: string; encoding?: string };
      return data.encoding === 'base64' ? Buffer.from(data.content, 'base64') : Buffer.from(data.content, 'utf-8');
    } catch { return null; }
  }

  // ── Session diff ──────────────────────────────────────────────────────

  async getSessionDiff(sessionId: string): Promise<string> {
    try {
      const res = await fetch(`${this.baseUrl}/session/${sessionId}/diff`, {
        headers: this.headers, signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return '';
      const data = await res.json();
      return typeof data === 'string' ? data
        : (data as Record<string, unknown>).diff as string || (data as Record<string, unknown>).content as string || JSON.stringify(data, null, 2);
    } catch { return ''; }
  }

  // ── Session sharing ───────────────────────────────────────────────────

  async shareSession(sessionId: string): Promise<string | null> {
    try {
      const res = await fetch(`${this.baseUrl}/session/${sessionId}/share`, {
        method: 'POST', headers: this.headers, signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as Record<string, unknown>;
      return (data.shareUrl || data.share_url || data.url) as string || null;
    } catch { return null; }
  }
}
