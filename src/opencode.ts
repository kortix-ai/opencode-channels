export interface OpenCodeClientConfig {
  baseUrl: string;
  headers?: Record<string, string>;
}

export interface FileOutput {
  name: string;
  path: string;
  content?: Buffer;
}

export interface StreamEvent {
  type: 'text' | 'busy' | 'done' | 'error' | 'permission' | 'file' | 'tool';
  data?: string;
  permission?: {
    id: string;
    tool: string;
    description: string;
  };
  file?: {
    name: string;
    url: string;
    mimeType?: string;
  };
  tool?: {
    name: string;
    status: 'running' | 'completed' | 'error';
  };
}

const FILE_PRODUCING_TOOLS = new Set(['show', 'show_user', 'show-user', 'oc-write']);
const FILE_ITEM_TYPES = new Set(['file', 'image']);

const DELIVERABLE_EXTS = new Set([
  'md', 'txt', 'pdf', 'html', 'csv', 'json', 'xml',
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp',
  'mp3', 'mp4', 'wav',
  'docx', 'xlsx', 'pptx',
]);

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
): { name: string; url: string; mimeType?: string; content?: Buffer } | null {
  const input = state.input as Record<string, unknown> | undefined;
  const output = state.output as string | undefined;

  // ── oc-write: extract written file with inline content ──
  if (toolName === 'oc-write') {
    const filePath = (input?.filePath as string) || (input?.file_path as string);
    if (!filePath) return null;

    const ext = filePath.split('.').pop()?.toLowerCase() || '';
    if (!DELIVERABLE_EXTS.has(ext)) return null;

    if (output) {
      try {
        const parsed = JSON.parse(output);
        if (parsed.success === false) return null;
      } catch { /* non-JSON output, assume success */ }
    }

    const name = filePath.split('/').pop() || 'file';
    // Grab the content directly from the tool's input args — no download needed
    const rawContent = input?.content as string | undefined;
    const content = rawContent ? Buffer.from(rawContent, 'utf-8') : undefined;
    return { name, url: filePath, content };
  }

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

export class OpenCodeClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;

  constructor(config: OpenCodeClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.headers = { 'Content-Type': 'application/json', ...config.headers };
  }

  async isReady(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/global/health`, {
        signal: AbortSignal.timeout(5000),
      });
      return res.ok;
    } catch { return false; }
  }

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
      const sseHeaders: Record<string, string> = { Accept: 'text/event-stream' };
      for (const [k, v] of Object.entries(this.headers)) {
        if (k.toLowerCase() !== 'content-type') sseHeaders[k] = v;
      }
      const sseRes = await fetch(`${this.baseUrl}/event`, {
        method: 'GET', headers: sseHeaders, signal: controller.signal,
      });
      if (!sseRes.ok || !sseRes.body) throw new Error(`SSE connect failed: ${sseRes.status}`);

      const parts: Array<Record<string, unknown>> = [{ type: 'text', text: content }];
      if (options?.files) {
        for (const fp of options.files) {
          parts.push({ type: 'file', mime: fp.mime, url: fp.url, filename: fp.filename });
        }
      }
      const promptBody: Record<string, unknown> = { parts };
      if (options?.agentName) promptBody.agent = options.agentName;
      if (options?.model) promptBody.model = options.model;

      const promptRes = await fetch(`${this.baseUrl}/session/${sessionId}/prompt_async`, {
        method: 'POST', headers: this.headers,
        body: JSON.stringify(promptBody), signal: controller.signal,
      });
      if (!promptRes.ok) throw new Error(`Prompt failed: ${promptRes.status} ${await promptRes.text()}`);

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

          if (evt === 'message.updated') {
            const info = (props.info || {}) as Record<string, unknown>;
            if (info.role === 'assistant') assistantMsgIds.add(info.id as string);
          }

          if (evt === 'message.part.delta') {
            // Skip non-text part deltas (reasoning tokens, tool, step, etc.)
            const partType = (props.part as Record<string, unknown>)?.type as string;
            if (partType && partType !== 'text') continue;
            const delta = props.delta as string;
            if (delta) { gotText = true; sawBusy = true; yield delta; }
          }

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
                  options.collectedFiles.push({ name: fileEvent.name, path: fileEvent.url, content: fileEvent.content });
                }
              }
            }
          }

          if (evt === 'session.status') {
            const status = ((props.status as Record<string, unknown>)?.type as string);
            if (status === 'busy') sawBusy = true;
          }

          if (evt === 'session.idle' && (sawBusy || gotText)) return;

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

  async *promptStreamEvents(
    sessionId: string,
    content: string,
    options?: {
      agentName?: string;
      model?: { providerID: string; modelID: string };
      files?: Array<{ type: 'file'; mime: string; url: string; filename?: string }>;
    },
  ): AsyncGenerator<StreamEvent> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 300_000);

    try {
      const sseHeaders: Record<string, string> = { Accept: 'text/event-stream' };
      for (const [k, v] of Object.entries(this.headers)) {
        if (k.toLowerCase() !== 'content-type') sseHeaders[k] = v;
      }
      const sseRes = await fetch(`${this.baseUrl}/event`, {
        method: 'GET', headers: sseHeaders, signal: controller.signal,
      });
      if (!sseRes.ok || !sseRes.body) throw new Error(`SSE connect failed: ${sseRes.status}`);
      console.log(`[opencode] promptStreamEvents: SSE connected for session ${sessionId}`);

      const parts: Array<Record<string, unknown>> = [{ type: 'text', text: content }];
      if (options?.files) {
        for (const fp of options.files) {
          parts.push({ type: 'file', mime: fp.mime, url: fp.url, filename: fp.filename });
        }
      }
      const promptBody: Record<string, unknown> = { parts };
      if (options?.agentName) promptBody.agent = options.agentName;
      if (options?.model) promptBody.model = options.model;

      const promptRes = await fetch(`${this.baseUrl}/session/${sessionId}/prompt_async`, {
        method: 'POST', headers: this.headers,
        body: JSON.stringify(promptBody), signal: controller.signal,
      });
      if (!promptRes.ok) {
        const errBody = await promptRes.text().catch(() => '');
        throw new Error(`Prompt failed (${promptRes.status}): ${errBody || 'unknown error'}`);
      }
      // Check response body for errors (OpenCode may return { error: ... })
      const promptResText = await promptRes.text().catch(() => '');
      if (promptResText) {
        try {
          const parsed = JSON.parse(promptResText);
          if (parsed.error) {
            throw new Error(`Prompt rejected: ${typeof parsed.error === 'string' ? parsed.error : JSON.stringify(parsed.error)}`);
          }
        } catch (e) {
          if (e instanceof Error && e.message.startsWith('Prompt rejected')) throw e;
          // Not JSON or no error field — fine
        }
      }
      console.log(`[opencode] promptStreamEvents: prompt sent, streaming events...`);

      const reader = sseRes.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const assistantMsgIds = new Set<string>();
      const processedToolCalls = new Set<string>();
      let sawBusy = false;
      let gotText = false;
      let promptSentAt = Date.now();

      // Per-read timeout: if no SSE data for this long, bail out.
      // Use a shorter timeout when we haven't seen any activity yet (likely a dead prompt).
      const INITIAL_TIMEOUT_MS = 30_000;  // 30s to see first busy/text event
      const ACTIVE_TIMEOUT_MS = 90_000;   // 90s between events once active

      while (true) {
        const timeoutMs = (sawBusy || gotText) ? ACTIVE_TIMEOUT_MS : INITIAL_TIMEOUT_MS;
        const readPromise = reader.read();
        const timeoutPromise = new Promise<{ done: true; value: undefined }>((resolve) =>
          setTimeout(() => resolve({ done: true, value: undefined }), timeoutMs),
        );
        const { done, value } = await Promise.race([readPromise, timeoutPromise]);
        if (done) {
          if (!gotText && !sawBusy) {
            console.warn('[opencode] promptStreamEvents: timed out with no activity — agent may have failed silently');
            yield { type: 'error' as const, data: 'Agent did not respond (timed out). The agent or model may be unavailable.' };
            return;
          }
          break;
        }
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

          // Debug: log every non-delta event type for our session
          if (evt !== 'message.part.delta') {
            const partType = (props.part as Record<string, unknown>)?.type as string || '';
            const toolName = (props.part as Record<string, unknown>)?.tool as string || '';
            const statusType = ((props.status as Record<string, unknown>)?.type as string) || '';
            console.log(`[opencode] SSE: ${evt}${partType ? ` part=${partType}` : ''}${toolName ? ` tool=${toolName}` : ''}${statusType ? ` status=${statusType}` : ''}`);
          }

          if (evt === 'message.updated') {
            const info = (props.info || {}) as Record<string, unknown>;
            if (info.role === 'assistant') assistantMsgIds.add(info.id as string);
          }

          // Handle text deltas — these arrive as message.part.delta events
          // (NOT message.part.updated which only has the full accumulated text).
          // IMPORTANT: Skip non-text part types (reasoning tokens, tool, step, etc.)
          // to avoid leaking internal model reasoning into channel messages.
          if (evt === 'message.part.delta') {
            const partType = (props.part as Record<string, unknown>)?.type as string;
            if (partType && partType !== 'text') continue;
            const delta = props.delta as string;
            if (delta) {
              gotText = true;
              sawBusy = true;
              yield { type: 'text', data: delta };
            }
          }

          if (evt === 'message.part.updated') {
            const part = (props.part || {}) as Record<string, unknown>;
            const msgId = part.messageID as string;
            if (msgId && !assistantMsgIds.has(msgId)) continue;

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

            if (part.type === 'tool') {
              const toolName = part.tool as string;
              const callID = (part.callID || part.id) as string;
              const state = part.state as Record<string, unknown> | undefined;
              const toolStatus = state?.status as string | undefined;

              // Yield tool activity events so the UI can show progress
              if (toolName && callID && !processedToolCalls.has(callID)) {
                if (toolStatus === 'running' || toolStatus === 'pending') {
                  yield { type: 'tool', tool: { name: toolName, status: 'running' } };
                } else if (toolStatus === 'completed') {
                  processedToolCalls.add(callID);
                  yield { type: 'tool', tool: { name: toolName, status: 'completed' } };
                  // Extract file if applicable
                  if (FILE_PRODUCING_TOOLS.has(toolName)) {
                    const fileEvent = extractFileFromToolOutput(toolName, state!);
                    if (fileEvent) {
                      yield { type: 'file', file: fileEvent };
                    }
                  }
                } else if (toolStatus === 'error') {
                  processedToolCalls.add(callID);
                  yield { type: 'tool', tool: { name: toolName, status: 'error' } };
                }
              }
            }

            // step-start/step-finish parts indicate multi-step agent activity
            if (part.type === 'step-start') {
              const stepName = (part.step as string) || (part.name as string) || '';
              if (stepName) {
                yield { type: 'tool', tool: { name: stepName, status: 'running' } };
              }
            }
          }

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

          if (evt === 'session.status') {
            const status = ((props.status as Record<string, unknown>)?.type as string);
            if (status === 'busy') {
              sawBusy = true;
              yield { type: 'busy' };
            }
          }

          // session.idle means the agent finished. We guard against stale
          // idle events that arrive right after SSE connect (from a previous
          // prompt) by requiring at least 1s to have passed since we sent our
          // prompt, OR that we've already seen activity (busy/text).
          if (evt === 'session.idle') {
            if (sawBusy || gotText || (Date.now() - promptSentAt > 1500)) {
              yield { type: 'done' };
              return;
            }
          }

          if (evt === 'session.error') {
            const err = ((props.error as Record<string, unknown>)?.data as Record<string, unknown>)?.message as string;
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

  async replyPermission(permissionId: string, approved: boolean): Promise<void> {
    try {
      // OpenCode permission API expects: { reply: "once" | "always" | "reject" }
      const reply = approved ? 'always' : 'reject';
      const res = await fetch(`${this.baseUrl}/permission/${permissionId}/reply`, {
        method: 'POST', headers: this.headers,
        body: JSON.stringify({ reply }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        const errText = await res.text();
        console.error(`[OpenCodeClient] Permission reply failed: ${res.status} ${errText}`);
      } else {
        console.log(`[opencode] Permission ${permissionId} replied: ${reply}`);
      }
    } catch (err) {
      console.error('[OpenCodeClient] Permission reply error:', err);
    }
  }

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

  async listAgents(): Promise<Array<{ name: string; description?: string; mode?: string }>> {
    try {
      const res = await fetch(`${this.baseUrl}/agent`, {
        headers: this.headers, signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return [];
      const data = await res.json();
      const agents: unknown[] = Array.isArray(data) ? data : Object.values(data as Record<string, unknown>);
      return agents.map((a: unknown) => {
        const agent = a as Record<string, unknown>;
        return { name: (agent.name as string) || '', description: agent.description as string | undefined, mode: agent.mode as string | undefined };
      });
    } catch { return []; }
  }

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
      const url = `${this.baseUrl}/file/content?${params}`;
      const res = await fetch(url, {
        headers: this.headers, signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as Record<string, unknown>;
      const content = data.content as string | undefined;
      if (!content) return null;
      return data.encoding === 'base64' ? Buffer.from(content, 'base64') : Buffer.from(content, 'utf-8');
    } catch (err) {
      console.error('[opencode-channels] downloadFileByPath error:', err);
      return null;
    }
  }

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
