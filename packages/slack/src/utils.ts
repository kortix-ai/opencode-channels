/**
 * Slack request verification utilities.
 *
 * Uses HMAC-SHA256 with constant-time comparison to verify that incoming
 * webhook requests genuinely originate from Slack.
 */

/**
 * Verify a Slack request signature using HMAC-SHA256.
 *
 * @param signingSecret - The Slack app signing secret
 * @param timestamp     - The `X-Slack-Request-Timestamp` header value
 * @param body          - The raw request body string
 * @param signature     - The `X-Slack-Signature` header value (e.g. `v0=abc123...`)
 * @returns `true` if the signature is valid
 */
export async function verifySlackSignature(
  signingSecret: string,
  timestamp: string,
  body: string,
  signature: string,
): Promise<boolean> {
  const basestring = `v0:${timestamp}:${body}`;
  const key = new TextEncoder().encode(signingSecret);
  const message = new TextEncoder().encode(basestring);

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, message);
  const hex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  const expected = `v0=${hex}`;

  // Constant-time comparison
  if (expected.length !== signature.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * Simplified request verifier that takes the signing secret directly.
 *
 * Validates the timestamp is within 5 minutes, then delegates to
 * `verifySlackSignature` for HMAC verification.
 *
 * @param rawBody       - The raw request body string
 * @param headers       - Object with `timestamp` and `signature` from the Slack request headers
 * @param signingSecret - The Slack app signing secret
 * @returns `true` if the request is authentic
 */
export async function verifySlackRequest(
  rawBody: string,
  headers: { timestamp: string; signature: string },
  signingSecret: string,
): Promise<boolean> {
  if (!signingSecret) {
    // No signing secret configured — skip verification (development mode)
    return true;
  }

  // Reject requests older than 5 minutes to prevent replay attacks
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(headers.timestamp)) > 300) {
    return false;
  }

  return verifySlackSignature(signingSecret, headers.timestamp, rawBody, headers.signature);
}
