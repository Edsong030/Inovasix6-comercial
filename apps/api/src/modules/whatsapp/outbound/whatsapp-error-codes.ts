import type { OutboundFailureKind } from '../../delivery/outbound-channel-adapter';

/**
 * Classifies a failed Graph API send for the delivery engine's retry policy
 * (Stage F): temporary = trying again later can work, permanent = it never will.
 *
 * Source: Meta's "WhatsApp error codes" table (Cloud API message sending),
 * which states per code whether a retry can help. The engine then applies its
 * own bounded retry (5 attempts, backoff 1 min .. 1 h), so "temporary" here
 * never means "forever".
 *
 * Decision order: a KNOWN Meta error code decides (the code says more than the
 * HTTP status); for an unknown/missing code the HTTP status decides: 429 and 5xx
 * are temporary, everything else (401/403 credentials or permissions, other 4xx
 * bad requests) is permanent. Not every 4xx is treated alike: 429 is a 4xx and
 * is temporary, and 131047/131026/... are 4xx and permanent, each by its code.
 *
 * The stored/logged code is `WA_<code>` or `WA_HTTP_<status>`: numbers only,
 * never Meta's title/message text, which can quote a phone number or content.
 */

/** Retryable per Meta's table (rate limits, throughput, temporary downtime/maintenance, unknown server error). */
const TEMPORARY_CODES: ReadonlySet<number> = new Set([
  4, // app-level API call rate limit (429)
  2, // temporary downtime or overload (503)
  80007, // WABA rate limit (429)
  130429, // Cloud API throughput limit (429)
  131000, // failed to send, unknown error (500)
  131048, // spam rate limit restrictions (429)
  131049, // ecosystem engagement protection (429)
  131052, // unable to download media from user's message (500)
  131056, // pair rate limit: too many messages to the same recipient (429)
  131057, // account in maintenance mode (503)
  // 1: Meta's table lists it as not retryable, but its description is "invalid request OR possible
  // server error" and it comes with HTTP 500. Retrying is bounded (5 attempts) and losing the
  // first-contact reply to a server hiccup is the costlier mistake, so it is retried.
  1,
]);

/** Not retryable per Meta's table (bad request, credentials, policy, 24h window, unsupported content, ...). */
const PERMANENT_CODES: ReadonlySet<number> = new Set([
  100, // unsupported/misspelled parameter
  190, // access token expired or invalid
  200, // no access token provided
  10, // permission not granted / removed
  368, // account restricted or disabled for policy violation
  130403, // business blocked this recipient
  130472, // excluded from an A/B experiment
  131008, // missing required parameter
  131009, // parameter value invalid
  131026, // recipient is not a WhatsApp user / cannot receive
  131031, // account locked
  131037, // display name not approved
  131042, // payment / billing problem
  131045, // phone number registration error
  131047, // more than 24 h since the recipient's last message: a free-form message is not allowed (needs a template)
  131050, // recipient opted out of marketing messages
  131051, // unsupported message type
  131053, // media upload problem
  131062, // BSUID recipients not supported for this message type
  131063,
  132000, // template errors (this stage sends no templates)
  132001,
  132005,
  132007,
  132012,
  132015,
  132016,
]);

export interface ClassifiedFailure {
  kind: OutboundFailureKind;
  code: string;
}

/** Meta's numeric error code from a Graph API error body ({ error: { code } }), or null. */
export function metaErrorCode(body: unknown): number | null {
  if (typeof body !== 'object' || body === null) return null;
  const error = (body as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'number' && Number.isInteger(code) && code >= 0 && code <= 999_999_999 ? code : null;
}

export function classifyGraphFailure(httpStatus: number, body: unknown): ClassifiedFailure {
  const code = metaErrorCode(body);
  if (code !== null) {
    if (TEMPORARY_CODES.has(code)) return { kind: 'temporary', code: `WA_${code}` };
    if (PERMANENT_CODES.has(code)) return { kind: 'permanent', code: `WA_${code}` };
  }
  // Unknown or absent Meta code: fall back on the HTTP status.
  const retryable = httpStatus === 429 || httpStatus >= 500;
  const label = code !== null ? `WA_${code}` : `WA_HTTP_${httpStatus}`;
  return { kind: retryable ? 'temporary' : 'permanent', code: label };
}
