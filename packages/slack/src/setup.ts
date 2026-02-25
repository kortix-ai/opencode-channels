/**
 * Slack App Manifest auto-configuration.
 *
 * Uses the Slack Manifest API to programmatically update a Slack app's
 * URLs (event subscriptions, slash commands, interactivity) so there's
 * zero manual configuration when switching tunnels/domains.
 *
 * Requires a configuration refresh token from:
 *   https://api.slack.com/apps → your app → "Configuration Tokens"
 *   or https://api.slack.com/authentication/config-tokens
 *
 * Flow:
 *   1. Rotate refresh token → get short-lived access token
 *   2. Export current manifest (preserves all existing settings)
 *   3. Patch URLs in the manifest
 *   4. Push updated manifest back
 */

const SLACK_API = 'https://slack.com/api';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SlackManifest {
  _metadata?: { major_version: number; minor_version: number };
  display_information?: Record<string, unknown>;
  settings?: {
    interactivity?: {
      is_enabled?: boolean;
      request_url?: string;
      message_menu_options_url?: string;
    };
    event_subscriptions?: {
      request_url?: string;
      bot_events?: string[];
      user_events?: string[];
    };
    socket_mode_enabled?: boolean;
    [key: string]: unknown;
  };
  features?: {
    bot_user?: { display_name?: string; always_online?: boolean };
    slash_commands?: Array<{
      command: string;
      description: string;
      url?: string;
      usage_hint?: string;
      should_escape?: boolean;
    }>;
    [key: string]: unknown;
  };
  oauth_config?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface SetupOptions {
  /** Slack App ID (e.g. A0AGVEKGHFG) */
  appId: string;
  /** Configuration refresh token (starts with xoxe-) */
  refreshToken: string;
  /** The public base URL (e.g. https://abc123.ngrok.app) */
  baseUrl: string;
  /** Slash commands to register (default: /oc) */
  slashCommands?: Array<{
    command: string;
    description: string;
    usageHint?: string;
  }>;
  /** Bot events to subscribe to (defaults to standard set) */
  botEvents?: string[];
}

export interface SetupResult {
  ok: boolean;
  /** New refresh token (MUST be saved — the old one is now invalid) */
  newRefreshToken?: string;
  /** The updated manifest */
  manifest?: SlackManifest;
  error?: string;
}

// ─── Default bot events ─────────────────────────────────────────────────────

const DEFAULT_BOT_EVENTS = [
  'app_mention',
  'message.channels',
  'message.groups',
  'message.im',
  'message.mpim',
  'reaction_added',
];

const DEFAULT_SLASH_COMMANDS = [
  {
    command: '/oc',
    description: 'OpenCode slash command',
    usageHint: '/oc [command] [args]',
  },
];

// ─── Token rotation ─────────────────────────────────────────────────────────

async function rotateToken(
  refreshToken: string,
): Promise<{ token: string; refreshToken: string } | { error: string }> {
  const res = await fetch(`${SLACK_API}/tooling.tokens.rotate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ refresh_token: refreshToken }),
  });

  const data = (await res.json()) as Record<string, unknown>;

  if (!data.ok) {
    return { error: `Token rotation failed: ${data.error}` };
  }

  return {
    token: data.token as string,
    refreshToken: data.refresh_token as string,
  };
}

// ─── Export manifest ────────────────────────────────────────────────────────

async function exportManifest(
  token: string,
  appId: string,
): Promise<{ manifest: SlackManifest } | { error: string }> {
  const res = await fetch(`${SLACK_API}/apps.manifest.export`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ app_id: appId }),
  });

  const data = (await res.json()) as Record<string, unknown>;

  if (!data.ok) {
    return { error: `Manifest export failed: ${data.error}` };
  }

  return { manifest: data.manifest as SlackManifest };
}

// ─── Update manifest ───────────────────────────────────────────────────────

async function updateManifest(
  token: string,
  appId: string,
  manifest: SlackManifest,
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${SLACK_API}/apps.manifest.update`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ app_id: appId, manifest }),
  });

  const data = (await res.json()) as Record<string, unknown>;

  if (!data.ok) {
    const errors = data.errors as unknown[];
    const errorDetail = errors
      ? JSON.stringify(errors, null, 2)
      : (data.error as string);
    return { ok: false, error: `Manifest update failed: ${errorDetail}` };
  }

  return { ok: true };
}

// ─── Patch URLs in manifest ─────────────────────────────────────────────────

function patchManifestUrls(
  manifest: SlackManifest,
  baseUrl: string,
  options: SetupOptions,
): SlackManifest {
  const patched = JSON.parse(JSON.stringify(manifest)) as SlackManifest;

  // Ensure settings exists
  if (!patched.settings) patched.settings = {};

  // Event subscriptions
  if (!patched.settings.event_subscriptions) {
    patched.settings.event_subscriptions = {};
  }
  patched.settings.event_subscriptions.request_url = `${baseUrl}/slack/events`;
  patched.settings.event_subscriptions.bot_events =
    options.botEvents ?? DEFAULT_BOT_EVENTS;

  // Interactivity
  if (!patched.settings.interactivity) {
    patched.settings.interactivity = {};
  }
  patched.settings.interactivity.is_enabled = true;
  patched.settings.interactivity.request_url = `${baseUrl}/slack/interactivity`;

  // Disable socket mode (we use HTTP webhooks)
  patched.settings.socket_mode_enabled = false;

  // Ensure features exists
  if (!patched.features) patched.features = {};

  // Ensure bot_user exists (required for slash commands & events)
  if (!patched.features.bot_user) {
    patched.features.bot_user = {
      display_name: 'OpenCode',
      always_online: true,
    };
  }

  // Slash commands
  const commands = options.slashCommands ?? DEFAULT_SLASH_COMMANDS;
  patched.features.slash_commands = commands.map((cmd) => ({
    command: cmd.command,
    description: cmd.description,
    url: `${baseUrl}/slack/commands`,
    usage_hint: cmd.usageHint ?? '',
    should_escape: false,
  }));

  // Ensure oauth_config with required bot scopes
  if (!patched.oauth_config) patched.oauth_config = {};

  const oauthScopes = patched.oauth_config.scopes as
    | { bot?: string[]; user?: string[] }
    | undefined;

  const requiredBotScopes = [
    'app_mentions:read',
    'channels:history',
    'channels:read',
    'chat:write',
    'chat:write.public',
    'commands',
    'files:read',
    'files:write',
    'groups:history',
    'groups:read',
    'im:history',
    'im:read',
    'im:write',
    'mpim:history',
    'mpim:read',
    'reactions:read',
    'reactions:write',
    'users:read',
  ];

  if (!oauthScopes) {
    patched.oauth_config.scopes = { bot: requiredBotScopes };
  } else {
    const existing = new Set(oauthScopes.bot ?? []);
    for (const scope of requiredBotScopes) {
      existing.add(scope);
    }
    oauthScopes.bot = [...existing];
  }

  return patched;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Auto-configure a Slack app by updating its manifest with the correct URLs.
 *
 * Returns the new refresh token (MUST be persisted — the old one is invalidated
 * on each rotation).
 */
export async function setupSlackApp(options: SetupOptions): Promise<SetupResult> {
  const { appId, refreshToken, baseUrl } = options;

  console.log(`[slack-setup] Rotating configuration token...`);

  // 1. Rotate token
  const tokenResult = await rotateToken(refreshToken);
  if ('error' in tokenResult) {
    return { ok: false, error: tokenResult.error };
  }

  const { token: accessToken, refreshToken: newRefreshToken } = tokenResult;
  console.log(`[slack-setup] Got access token (expires in 12h)`);

  // 2. Export current manifest
  console.log(`[slack-setup] Exporting current manifest for ${appId}...`);
  const manifestResult = await exportManifest(accessToken, appId);
  if ('error' in manifestResult) {
    return { ok: false, newRefreshToken, error: manifestResult.error as string };
  }

  console.log(`[slack-setup] Current manifest exported`);

  // 3. Patch URLs
  const patchedManifest = patchManifestUrls(manifestResult.manifest, baseUrl, options);

  console.log(`[slack-setup] URLs patched:`);
  console.log(`  events:        ${baseUrl}/slack/events`);
  console.log(`  interactivity: ${baseUrl}/slack/interactivity`);
  console.log(`  commands:      ${baseUrl}/slack/commands`);

  // 4. Push updated manifest
  console.log(`[slack-setup] Updating manifest...`);
  const updateResult = await updateManifest(accessToken, appId, patchedManifest);
  if (!updateResult.ok) {
    return { ok: false, newRefreshToken, error: updateResult.error };
  }

  console.log(`[slack-setup] Manifest updated successfully`);

  return {
    ok: true,
    newRefreshToken,
    manifest: patchedManifest,
  };
}

/**
 * Detect the current ngrok public URL by querying the local ngrok API.
 * Returns null if ngrok isn't running.
 */
export async function detectNgrokUrl(
  ngrokApiUrl = 'http://127.0.0.1:4040',
): Promise<string | null> {
  try {
    const res = await fetch(`${ngrokApiUrl}/api/tunnels`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;

    const data = (await res.json()) as {
      tunnels: Array<{ public_url: string; proto: string }>;
    };

    // Prefer HTTPS tunnel
    const httpsTunnel = data.tunnels.find((t) => t.proto === 'https');
    return httpsTunnel?.public_url ?? data.tunnels[0]?.public_url ?? null;
  } catch {
    return null;
  }
}
