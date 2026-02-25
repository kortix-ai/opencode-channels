/**
 * Slack webhook payload fixtures for E2E testing (Chat SDK edition).
 *
 * Generates realistic Slack Events API payloads for testing the Chat SDK
 * webhook handler at /api/webhooks/slack.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SlackEventPayload {
  token: string;
  team_id: string;
  api_app_id: string;
  event: {
    type: string;
    user: string;
    text: string;
    ts: string;
    channel: string;
    event_ts: string;
    channel_type?: string;
    thread_ts?: string;
    [key: string]: unknown;
  };
  type: string;
  event_id: string;
  event_time: number;
  authorizations?: Array<{
    enterprise_id: string | null;
    team_id: string;
    user_id: string;
    is_bot: boolean;
    is_enterprise_install: boolean;
  }>;
}

export interface SlackSlashCommandPayload {
  token: string;
  team_id: string;
  team_domain: string;
  channel_id: string;
  channel_name: string;
  user_id: string;
  user_name: string;
  command: string;
  text: string;
  api_app_id: string;
  is_enterprise_install: string;
  response_url: string;
  trigger_id: string;
}

// ─── Defaults ───────────────────────────────────────────────────────────────

const DEFAULTS = {
  token: 'test-verification-token',
  teamId: 'T07FUFNT3RV',
  appId: 'A0AGRKXUVQT',
  botUserId: 'U0AGH4H1NPR',
  userId: 'U07G2D722TY',
  userName: 'testuser',
  channel: 'C0AG3PJLCHH', // #test012931
  channelName: 'test012931',
};

// ─── Generators ─────────────────────────────────────────────────────────────

let eventCounter = 1000;

function nextTs(): string {
  return `${Math.floor(Date.now() / 1000)}.${String(eventCounter++).padStart(6, '0')}`;
}

function nextEventId(): string {
  return `Ev0${String(eventCounter++).padStart(10, '0')}`;
}

/**
 * Generate a Slack `app_mention` event payload.
 */
export function makeAppMention(
  text: string,
  options?: {
    threadTs?: string;
    userId?: string;
  } & Partial<typeof DEFAULTS>,
): SlackEventPayload {
  const { threadTs, ...overrides } = options || {};
  const d = { ...DEFAULTS, ...overrides };
  const ts = nextTs();

  return {
    token: d.token,
    team_id: d.teamId,
    api_app_id: d.appId,
    event: {
      type: 'app_mention',
      user: d.userId,
      text: `<@${d.botUserId}> ${text}`,
      ts,
      channel: d.channel,
      event_ts: ts,
      ...(threadTs ? { thread_ts: threadTs } : {}),
    },
    type: 'event_callback',
    event_id: nextEventId(),
    event_time: Math.floor(Date.now() / 1000),
    authorizations: [
      {
        enterprise_id: null,
        team_id: d.teamId,
        user_id: d.botUserId,
        is_bot: true,
        is_enterprise_install: false,
      },
    ],
  };
}

/**
 * Generate a Slack `message` event payload (DM or channel).
 */
export function makeMessage(
  text: string,
  options?: {
    isDm?: boolean;
    threadTs?: string;
    userId?: string;
    botId?: string;
  } & Partial<typeof DEFAULTS>,
): SlackEventPayload {
  const { isDm, threadTs, botId, ...overrides } = options || {};
  const d = { ...DEFAULTS, ...overrides };
  const ts = nextTs();

  const event: SlackEventPayload['event'] = {
    type: 'message',
    user: d.userId,
    text,
    ts,
    channel: isDm ? `D${d.userId.slice(1)}` : d.channel,
    event_ts: ts,
    channel_type: isDm ? 'im' : 'channel',
    ...(threadTs ? { thread_ts: threadTs } : {}),
  };

  if (botId) {
    event.bot_id = botId;
  }

  return {
    token: d.token,
    team_id: d.teamId,
    api_app_id: d.appId,
    event,
    type: 'event_callback',
    event_id: nextEventId(),
    event_time: Math.floor(Date.now() / 1000),
    authorizations: [
      {
        enterprise_id: null,
        team_id: d.teamId,
        user_id: d.botUserId,
        is_bot: true,
        is_enterprise_install: false,
      },
    ],
  };
}

/**
 * Generate a Slack `reaction_added` event payload.
 */
export function makeReaction(
  reaction: string,
  itemTs: string,
  overrides?: Partial<typeof DEFAULTS>,
): SlackEventPayload {
  const d = { ...DEFAULTS, ...overrides };
  const ts = nextTs();

  return {
    token: d.token,
    team_id: d.teamId,
    api_app_id: d.appId,
    event: {
      type: 'reaction_added',
      user: d.userId,
      text: '',
      ts,
      channel: d.channel,
      event_ts: ts,
      reaction,
      item: {
        type: 'message',
        channel: d.channel,
        ts: itemTs,
      },
      item_user: d.botUserId,
    },
    type: 'event_callback',
    event_id: nextEventId(),
    event_time: Math.floor(Date.now() / 1000),
  };
}

/**
 * Generate a Slack URL verification challenge payload.
 */
export function makeUrlVerification(challenge?: string): {
  token: string;
  challenge: string;
  type: string;
} {
  return {
    token: DEFAULTS.token,
    challenge: challenge || `test-challenge-${Date.now()}`,
    type: 'url_verification',
  };
}

/**
 * Generate a Slack slash command payload as URL-encoded form data.
 */
export function makeSlashCommand(
  command: string,
  text: string,
  overrides?: Partial<typeof DEFAULTS>,
): string {
  const d = { ...DEFAULTS, ...overrides };

  const params: SlackSlashCommandPayload = {
    token: d.token,
    team_id: d.teamId,
    team_domain: 'testworkspace',
    channel_id: d.channel,
    channel_name: d.channelName,
    user_id: d.userId,
    user_name: d.userName,
    command,
    text,
    api_app_id: d.appId,
    is_enterprise_install: 'false',
    response_url: `https://hooks.slack.com/commands/test/${Date.now()}`,
    trigger_id: `${Date.now()}.${d.userId}`,
  };

  return new URLSearchParams(params as Record<string, string>).toString();
}

export { DEFAULTS };
