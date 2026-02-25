const SLACK_API = 'https://slack.com/api';

export interface SlackPostMessageOptions {
  channel: string;
  text: string;
  thread_ts?: string;
  blocks?: unknown[];
  username?: string;
  icon_url?: string;
}

export interface SlackPostMessageResult {
  ok: boolean;
  ts?: string;
  channel?: string;
  error?: string;
}

export interface SlackUpdateMessageOptions {
  channel: string;
  ts: string;
  text: string;
  blocks?: unknown[];
}

export interface SlackAuthTestResult {
  ok: boolean;
  user_id?: string;
  bot_id?: string;
  user?: string;
  team?: string;
  team_id?: string;
  error?: string;
}

export interface SlackUserInfo {
  ok: boolean;
  user?: {
    id: string;
    name: string;
    real_name?: string;
    profile?: {
      display_name?: string;
      image_48?: string;
    };
  };
  error?: string;
}

export interface SlackReplyMessage {
  type: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  subtype?: string;
  files?: Array<{
    id: string;
    name: string;
    mimetype: string;
    filetype: string;
    url_private: string;
    url_private_download?: string;
    size: number;
  }>;
}

export interface SlackFileUploadOptions {
  channel: string;
  threadTs?: string;
  filename: string;
  content: Buffer;
  title?: string;
}

export interface SlackConversationMessage {
  type: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts: string;
  subtype?: string;
}

export class SlackApi {
  private botToken: string;

  constructor(botToken: string) {
    this.botToken = botToken;
  }

  private get headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.botToken}`,
    };
  }

  async postMessage(options: SlackPostMessageOptions): Promise<SlackPostMessageResult> {
    const res = await fetch(`${SLACK_API}/chat.postMessage`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(options),
    });
    return res.json() as Promise<SlackPostMessageResult>;
  }

  async updateMessage(options: SlackUpdateMessageOptions): Promise<{ ok: boolean; error?: string }> {
    const res = await fetch(`${SLACK_API}/chat.update`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(options),
    });
    return res.json() as Promise<{ ok: boolean; error?: string }>;
  }

  async authTest(): Promise<SlackAuthTestResult> {
    const res = await fetch(`${SLACK_API}/auth.test`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.botToken}`,
      },
    });
    return res.json() as Promise<SlackAuthTestResult>;
  }

  async usersInfo(userId: string): Promise<SlackUserInfo> {
    const res = await fetch(`${SLACK_API}/users.info?user=${encodeURIComponent(userId)}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${this.botToken}`,
      },
    });
    return res.json() as Promise<SlackUserInfo>;
  }

  async addReaction(channel: string, timestamp: string, name: string): Promise<{ ok: boolean; error?: string }> {
    const res = await fetch(`${SLACK_API}/reactions.add`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ channel, timestamp, name }),
    });
    return res.json() as Promise<{ ok: boolean; error?: string }>;
  }

  async removeReaction(channel: string, timestamp: string, name: string): Promise<{ ok: boolean; error?: string }> {
    const res = await fetch(`${SLACK_API}/reactions.remove`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ channel, timestamp, name }),
    });
    return res.json() as Promise<{ ok: boolean; error?: string }>;
  }

  async conversationsReplies(
    channel: string,
    ts: string,
    limit = 20,
  ): Promise<{ ok: boolean; messages?: SlackReplyMessage[]; error?: string }> {
    const params = new URLSearchParams({ channel, ts, limit: String(limit) });
    const res = await fetch(`${SLACK_API}/conversations.replies?${params}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${this.botToken}`,
      },
    });
    return res.json() as Promise<{ ok: boolean; messages?: SlackReplyMessage[]; error?: string }>;
  }

  async filesUploadV2(options: SlackFileUploadOptions): Promise<{ ok: boolean; error?: string }> {
    const getUrlParams = new URLSearchParams();
    getUrlParams.set('filename', options.filename);
    getUrlParams.set('length', String(options.content.length));

    const getUrlRes = await fetch(`${SLACK_API}/files.getUploadURLExternal`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.botToken}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: getUrlParams,
    });

    const urlData = (await getUrlRes.json()) as {
      ok: boolean;
      upload_url?: string;
      file_id?: string;
      error?: string;
    };

    if (!urlData.ok || !urlData.upload_url || !urlData.file_id) {
      console.error(`[SLACK API] getUploadURLExternal failed: ${urlData.error}`);
      return { ok: false, error: urlData.error || 'Failed to get upload URL' };
    }

    console.log(`[SLACK API] Got upload URL, file_id=${urlData.file_id}`);

    const uploadRes = await fetch(urlData.upload_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(options.content),
    });

    if (!uploadRes.ok) {
      console.error(`[SLACK API] File content upload failed: ${uploadRes.status}`);
      return { ok: false, error: `Upload failed: ${uploadRes.status}` };
    }

    console.log(`[SLACK API] Content uploaded, completing for channel=${options.channel} thread=${options.threadTs}`);
    const channelId = options.channel;
    const completeRes = await fetch(`${SLACK_API}/files.completeUploadExternal`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({
        files: [{
          id: urlData.file_id,
          title: options.title || options.filename,
        }],
        channel_id: channelId,
        thread_ts: options.threadTs,
      }),
    });

    const result = (await completeRes.json()) as { ok: boolean; error?: string };
    if (!result.ok) {
      console.error(`[SLACK API] completeUploadExternal failed: ${result.error}`);
    }
    return result;
  }

  async conversationsJoin(channel: string): Promise<{ ok: boolean; channel?: { id: string }; error?: string }> {
    const res = await fetch(`${SLACK_API}/conversations.join`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ channel }),
    });
    return res.json() as Promise<{ ok: boolean; channel?: { id: string }; error?: string }>;
  }

  async usersList(cursor?: string, limit = 200): Promise<{
    ok: boolean;
    members?: Array<{
      id: string;
      name: string;
      real_name?: string;
      deleted?: boolean;
      is_bot?: boolean;
      profile?: {
        display_name?: string;
        real_name?: string;
        image_48?: string;
        email?: string;
      };
    }>;
    response_metadata?: { next_cursor?: string };
    error?: string;
  }> {
    const params = new URLSearchParams({ limit: String(limit) });
    if (cursor) params.set('cursor', cursor);
    const res = await fetch(`${SLACK_API}/users.list?${params}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${this.botToken}` },
    });
    return res.json() as Promise<any>;
  }

  async conversationsList(cursor?: string, limit = 200, types = 'public_channel,private_channel'): Promise<{
    ok: boolean;
    channels?: Array<{
      id: string;
      name: string;
      is_member?: boolean;
      is_private?: boolean;
      num_members?: number;
    }>;
    response_metadata?: { next_cursor?: string };
    error?: string;
  }> {
    const params = new URLSearchParams({ limit: String(limit), types });
    if (cursor) params.set('cursor', cursor);
    const res = await fetch(`${SLACK_API}/conversations.list?${params}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${this.botToken}` },
    });
    return res.json() as Promise<any>;
  }

  async chatUnfurl(
    channel: string,
    ts: string,
    unfurls: Record<string, unknown>,
  ): Promise<{ ok: boolean; error?: string }> {
    const res = await fetch(`${SLACK_API}/chat.unfurl`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ channel, ts, unfurls }),
    });
    return res.json() as Promise<{ ok: boolean; error?: string }>;
  }

  async conversationsHistory(
    channel: string,
    oldest?: string,
    limit = 100,
  ): Promise<{ ok: boolean; messages?: SlackConversationMessage[]; error?: string }> {
    const params = new URLSearchParams({ channel, limit: String(limit) });
    if (oldest) {
      params.set('oldest', oldest);
    }

    const res = await fetch(`${SLACK_API}/conversations.history?${params}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${this.botToken}`,
      },
    });
    return res.json() as Promise<{ ok: boolean; messages?: SlackConversationMessage[]; error?: string }>;
  }

  async searchMessages(
    query: string,
    options?: { sort?: 'score' | 'timestamp'; count?: number; page?: number },
  ): Promise<{
    ok: boolean;
    messages?: {
      total: number;
      matches: Array<{
        ts: string;
        channel: { id: string; name: string };
        text: string;
        username: string;
        permalink: string;
      }>;
    };
    error?: string;
  }> {
    const params = new URLSearchParams({ query });
    if (options?.sort) params.set('sort', options.sort);
    if (options?.count) params.set('count', String(options.count));
    if (options?.page) params.set('page', String(options.page));
    const res = await fetch(`${SLACK_API}/search.messages?${params}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${this.botToken}` },
    });
    return res.json() as Promise<any>;
  }

  async searchFiles(
    query: string,
    options?: { count?: number; page?: number },
  ): Promise<{
    ok: boolean;
    files?: {
      total: number;
      matches: Array<{
        id: string;
        name: string;
        title: string;
        filetype: string;
        permalink: string;
        user: string;
      }>;
    };
    error?: string;
  }> {
    const params = new URLSearchParams({ query });
    if (options?.count) params.set('count', String(options.count));
    if (options?.page) params.set('page', String(options.page));
    const res = await fetch(`${SLACK_API}/search.files?${params}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${this.botToken}` },
    });
    return res.json() as Promise<any>;
  }

  async conversationsCreate(
    name: string,
    isPrivate = false,
  ): Promise<{ ok: boolean; channel?: { id: string; name: string }; error?: string }> {
    const res = await fetch(`${SLACK_API}/conversations.create`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ name, is_private: isPrivate }),
    });
    return res.json() as Promise<any>;
  }

  async conversationsArchive(channel: string): Promise<{ ok: boolean; error?: string }> {
    const res = await fetch(`${SLACK_API}/conversations.archive`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ channel }),
    });
    return res.json() as Promise<{ ok: boolean; error?: string }>;
  }

  async conversationsSetTopic(
    channel: string,
    topic: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const res = await fetch(`${SLACK_API}/conversations.setTopic`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ channel, topic }),
    });
    return res.json() as Promise<{ ok: boolean; error?: string }>;
  }

  async conversationsSetPurpose(
    channel: string,
    purpose: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const res = await fetch(`${SLACK_API}/conversations.setPurpose`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ channel, purpose }),
    });
    return res.json() as Promise<{ ok: boolean; error?: string }>;
  }

  async conversationsOpen(users: string): Promise<{
    ok: boolean;
    channel?: { id: string };
    error?: string;
  }> {
    const res = await fetch(`${SLACK_API}/conversations.open`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ users }),
    });
    return res.json() as Promise<any>;
  }

  async pinsAdd(channel: string, timestamp: string): Promise<{ ok: boolean; error?: string }> {
    const res = await fetch(`${SLACK_API}/pins.add`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ channel, timestamp }),
    });
    return res.json() as Promise<{ ok: boolean; error?: string }>;
  }

  async pinsRemove(channel: string, timestamp: string): Promise<{ ok: boolean; error?: string }> {
    const res = await fetch(`${SLACK_API}/pins.remove`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ channel, timestamp }),
    });
    return res.json() as Promise<{ ok: boolean; error?: string }>;
  }

  async pinsList(channel: string): Promise<{
    ok: boolean;
    items?: Array<{
      type: string;
      message?: { text: string; ts: string; permalink: string };
      file?: { name: string; permalink: string };
    }>;
    error?: string;
  }> {
    const params = new URLSearchParams({ channel });
    const res = await fetch(`${SLACK_API}/pins.list?${params}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${this.botToken}` },
    });
    return res.json() as Promise<any>;
  }

  async usergroupsList(): Promise<{
    ok: boolean;
    usergroups?: Array<{
      id: string;
      name: string;
      handle: string;
      description: string;
      user_count: number;
    }>;
    error?: string;
  }> {
    const res = await fetch(`${SLACK_API}/usergroups.list`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${this.botToken}` },
    });
    return res.json() as Promise<any>;
  }

  async usergroupsUsersList(usergroupId: string): Promise<{
    ok: boolean;
    users?: string[];
    error?: string;
  }> {
    const params = new URLSearchParams({ usergroup: usergroupId });
    const res = await fetch(`${SLACK_API}/usergroups.users.list?${params}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${this.botToken}` },
    });
    return res.json() as Promise<any>;
  }

  async bookmarksAdd(
    channelId: string,
    title: string,
    type: string,
    link?: string,
  ): Promise<{
    ok: boolean;
    bookmark?: { id: string; title: string; link: string };
    error?: string;
  }> {
    const body: Record<string, string> = { channel_id: channelId, title, type };
    if (link) body.link = link;
    const res = await fetch(`${SLACK_API}/bookmarks.add`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
    });
    return res.json() as Promise<any>;
  }

  async bookmarksRemove(
    channelId: string,
    bookmarkId: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const res = await fetch(`${SLACK_API}/bookmarks.remove`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ channel_id: channelId, bookmark_id: bookmarkId }),
    });
    return res.json() as Promise<{ ok: boolean; error?: string }>;
  }

  async bookmarksList(channelId: string): Promise<{
    ok: boolean;
    bookmarks?: Array<{ id: string; title: string; link: string; type: string }>;
    error?: string;
  }> {
    const params = new URLSearchParams({ channel_id: channelId });
    const res = await fetch(`${SLACK_API}/bookmarks.list?${params}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${this.botToken}` },
    });
    return res.json() as Promise<any>;
  }

  async dndInfo(user?: string): Promise<{
    ok: boolean;
    dnd_enabled?: boolean;
    next_dnd_start_ts?: number;
    next_dnd_end_ts?: number;
    error?: string;
  }> {
    const params = new URLSearchParams();
    if (user) params.set('user', user);
    const res = await fetch(`${SLACK_API}/dnd.info?${params}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${this.botToken}` },
    });
    return res.json() as Promise<any>;
  }

  async teamInfo(): Promise<{
    ok: boolean;
    team?: { id: string; name: string; domain: string; icon?: { image_68?: string } };
    error?: string;
  }> {
    const res = await fetch(`${SLACK_API}/team.info`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${this.botToken}` },
    });
    return res.json() as Promise<any>;
  }

  async emojiList(): Promise<{
    ok: boolean;
    emoji?: Record<string, string>;
    error?: string;
  }> {
    const res = await fetch(`${SLACK_API}/emoji.list`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${this.botToken}` },
    });
    return res.json() as Promise<any>;
  }
}
