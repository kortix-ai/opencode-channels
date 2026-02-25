/**
 * Discord REST API v10 HTTP client.
 *
 * Pure fetch-based — no gateway/websocket dependency.
 * All methods throw on non-2xx responses with a descriptive error.
 */

const DISCORD_API = 'https://discord.com/api/v10';

// ─── Discord type definitions ───────────────────────────────────────────────

export interface DiscordUser {
  id: string;
  username: string;
  discriminator: string;
  global_name?: string | null;
  avatar?: string | null;
  bot?: boolean;
}

export interface DiscordChannel {
  id: string;
  type: number;
  guild_id?: string;
  name?: string;
  topic?: string;
  parent_id?: string;
  last_message_id?: string;
  recipients?: DiscordUser[];
}

export interface DiscordAttachment {
  id: string;
  filename: string;
  content_type?: string;
  size: number;
  url: string;
  proxy_url: string;
}

export interface DiscordMessage {
  id: string;
  channel_id: string;
  author: DiscordUser;
  content: string;
  timestamp: string;
  edited_timestamp?: string | null;
  tts: boolean;
  mention_everyone: boolean;
  mentions: DiscordUser[];
  attachments: DiscordAttachment[];
  embeds: DiscordEmbed[];
  pinned: boolean;
  type: number;
  message_reference?: { message_id?: string; channel_id?: string; guild_id?: string };
  referenced_message?: DiscordMessage | null;
  thread?: DiscordChannel;
  components?: DiscordComponent[];
  interaction_metadata?: {
    id: string;
    type: number;
    user: DiscordUser;
    name?: string;
  };
}

export interface DiscordEmbed {
  title?: string;
  description?: string;
  url?: string;
  timestamp?: string;
  color?: number;
  footer?: { text: string; icon_url?: string };
  image?: { url: string };
  thumbnail?: { url: string };
  author?: { name: string; url?: string; icon_url?: string };
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
}

/** Action row or button / select menu component. */
export interface DiscordComponent {
  type: number; // 1 = ActionRow, 2 = Button, 3 = StringSelect, etc.
  components?: DiscordComponent[];
  style?: number; // 1=Primary, 2=Secondary, 3=Success, 4=Danger, 5=Link
  label?: string;
  emoji?: { name?: string; id?: string; animated?: boolean };
  custom_id?: string;
  url?: string;
  disabled?: boolean;
  options?: Array<{
    label: string;
    value: string;
    description?: string;
    emoji?: { name?: string; id?: string };
    default?: boolean;
  }>;
  placeholder?: string;
  min_values?: number;
  max_values?: number;
}

/** Incoming interaction payload from the Discord interactions endpoint. */
export interface DiscordInteraction {
  id: string;
  application_id: string;
  type: number; // 1=PING, 2=APPLICATION_COMMAND, 3=MESSAGE_COMPONENT, 4=AUTOCOMPLETE, 5=MODAL_SUBMIT
  data?: DiscordInteractionData;
  guild_id?: string;
  channel_id?: string;
  channel?: DiscordChannel;
  member?: {
    user: DiscordUser;
    nick?: string;
    roles: string[];
    joined_at: string;
    permissions: string;
  };
  user?: DiscordUser;
  token: string;
  version: number;
  message?: DiscordMessage;
}

export interface DiscordInteractionData {
  id?: string;
  name?: string;
  type?: number; // 1=CHAT_INPUT, 2=USER, 3=MESSAGE
  options?: DiscordInteractionOption[];
  custom_id?: string;
  component_type?: number;
  values?: string[];
  resolved?: {
    users?: Record<string, DiscordUser>;
    messages?: Record<string, DiscordMessage>;
    attachments?: Record<string, DiscordAttachment>;
  };
}

export interface DiscordInteractionOption {
  name: string;
  type: number;
  value?: string | number | boolean;
  options?: DiscordInteractionOption[];
  focused?: boolean;
}

/** Response to an interaction (sent back to Discord). */
export interface DiscordInteractionResponse {
  type: number; // 1=PONG, 4=CHANNEL_MESSAGE_WITH_SOURCE, 5=DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE, 6=DEFERRED_UPDATE_MESSAGE, 7=UPDATE_MESSAGE
  data?: {
    content?: string;
    embeds?: DiscordEmbed[];
    components?: DiscordComponent[];
    flags?: number; // 64 = ephemeral
    tts?: boolean;
  };
}

// ─── Discord API error ──────────────────────────────────────────────────────

export class DiscordApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
    message?: string,
  ) {
    super(message ?? `Discord API error ${status}: ${JSON.stringify(body)}`);
    this.name = 'DiscordApiError';
  }
}

// ─── API Client ─────────────────────────────────────────────────────────────

export class DiscordApi {
  constructor(private readonly botToken: string) {}

  // ── Internal helpers ────────────────────────────────────────────────────

  private get headers(): Record<string, string> {
    return {
      Authorization: `Bot ${this.botToken}`,
      'Content-Type': 'application/json',
    };
  }

  private get authOnly(): Record<string, string> {
    return {
      Authorization: `Bot ${this.botToken}`,
    };
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${DISCORD_API}${path}`;
    const res = await fetch(url, {
      method,
      headers: body !== undefined ? this.headers : this.authOnly,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    // 204 No Content — nothing to parse
    if (res.status === 204) {
      return undefined as T;
    }

    const json = await res.json();

    if (!res.ok) {
      throw new DiscordApiError(res.status, json);
    }

    return json as T;
  }

  // ── Messages ────────────────────────────────────────────────────────────

  async createMessage(
    channelId: string,
    options: {
      content?: string;
      embeds?: DiscordEmbed[];
      components?: DiscordComponent[];
      message_reference?: { message_id: string };
    },
  ): Promise<DiscordMessage> {
    return this.request<DiscordMessage>(
      'POST',
      `/channels/${channelId}/messages`,
      options,
    );
  }

  async editMessage(
    channelId: string,
    messageId: string,
    options: {
      content?: string;
      embeds?: DiscordEmbed[];
      components?: DiscordComponent[];
    },
  ): Promise<DiscordMessage> {
    return this.request<DiscordMessage>(
      'PATCH',
      `/channels/${channelId}/messages/${messageId}`,
      options,
    );
  }

  async getChannelMessages(
    channelId: string,
    options?: { limit?: number; before?: string },
  ): Promise<DiscordMessage[]> {
    const params = new URLSearchParams();
    if (options?.limit) params.set('limit', String(options.limit));
    if (options?.before) params.set('before', options.before);
    const qs = params.toString();
    return this.request<DiscordMessage[]>(
      'GET',
      `/channels/${channelId}/messages${qs ? `?${qs}` : ''}`,
    );
  }

  // ── Interactions ────────────────────────────────────────────────────────

  async createInteractionResponse(
    interactionId: string,
    interactionToken: string,
    response: DiscordInteractionResponse,
  ): Promise<void> {
    return this.request<void>(
      'POST',
      `/interactions/${interactionId}/${interactionToken}/callback`,
      response,
    );
  }

  async editOriginalInteractionResponse(
    applicationId: string,
    interactionToken: string,
    options: { content?: string; embeds?: DiscordEmbed[]; components?: DiscordComponent[] },
  ): Promise<void> {
    return this.request<void>(
      'PATCH',
      `/webhooks/${applicationId}/${interactionToken}/messages/@original`,
      options,
    );
  }

  // ── Reactions ───────────────────────────────────────────────────────────

  async createReaction(
    channelId: string,
    messageId: string,
    emoji: string,
  ): Promise<void> {
    const encoded = encodeURIComponent(emoji);
    return this.request<void>(
      'PUT',
      `/channels/${channelId}/messages/${messageId}/reactions/${encoded}/@me`,
    );
  }

  async deleteOwnReaction(
    channelId: string,
    messageId: string,
    emoji: string,
  ): Promise<void> {
    const encoded = encodeURIComponent(emoji);
    return this.request<void>(
      'DELETE',
      `/channels/${channelId}/messages/${messageId}/reactions/${encoded}/@me`,
    );
  }

  // ── Users ───────────────────────────────────────────────────────────────

  async getUser(userId: string): Promise<DiscordUser> {
    return this.request<DiscordUser>('GET', `/users/${userId}`);
  }

  async getCurrentUser(): Promise<DiscordUser> {
    return this.request<DiscordUser>('GET', '/users/@me');
  }

  // ── Channels ────────────────────────────────────────────────────────────

  async getChannel(channelId: string): Promise<DiscordChannel> {
    return this.request<DiscordChannel>('GET', `/channels/${channelId}`);
  }

  async createDM(recipientId: string): Promise<DiscordChannel> {
    return this.request<DiscordChannel>('POST', '/users/@me/channels', {
      recipient_id: recipientId,
    });
  }

  // ── Threads ─────────────────────────────────────────────────────────────

  async createThreadFromMessage(
    channelId: string,
    messageId: string,
    name: string,
  ): Promise<DiscordChannel> {
    return this.request<DiscordChannel>(
      'POST',
      `/channels/${channelId}/messages/${messageId}/threads`,
      { name, auto_archive_duration: 1440 },
    );
  }

  // ── File uploads (multipart/form-data) ─────────────────────────────────

  async createMessageWithFiles(
    channelId: string,
    options: {
      content?: string;
      files: Array<{ name: string; data: Buffer }>;
    },
  ): Promise<DiscordMessage> {
    const url = `${DISCORD_API}/channels/${channelId}/messages`;

    const formData = new FormData();

    // Payload JSON describes the message and attachment metadata
    const attachments = options.files.map((f, i) => ({
      id: i,
      filename: f.name,
    }));

    const payloadJson: Record<string, unknown> = { attachments };
    if (options.content) {
      payloadJson.content = options.content;
    }

    formData.append('payload_json', JSON.stringify(payloadJson));

    for (let i = 0; i < options.files.length; i++) {
      const file = options.files[i];
      const blob = new Blob([file.data]);
      formData.append(`files[${i}]`, blob, file.name);
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bot ${this.botToken}` },
      body: formData,
    });

    const json = await res.json();
    if (!res.ok) {
      throw new DiscordApiError(res.status, json);
    }

    return json as DiscordMessage;
  }
}
