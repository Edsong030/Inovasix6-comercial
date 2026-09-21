import { ConversationChannel } from '@prisma/client';
import { createHash } from 'node:crypto';

/**
 * Machine-to-machine credentials for POST /api/conversations/inbound, read from
 * the INBOUND_SERVICE_CREDENTIALS environment variable (server-side only).
 *
 * Format: a JSON array, one entry per credential:
 *
 *   [{ "keyId": "acme-whatsapp-1", "tenantId": "<tenant uuid>",
 *      "channel": "WHATSAPP", "secret": "<>= 32 random characters>" }]
 *
 * A credential binds one caller to exactly one tenant AND one channel; the
 * request body never chooses either. Several credentials may target the same
 * tenant/channel (key rotation: add the new one, switch the caller, remove the
 * old one). The variable being empty/unset means "no credentials": the endpoint
 * rejects every request.
 *
 * Validation runs at boot (Joi, env.validation.ts) and again when the registry
 * is built, so a bad value fails fast. Error messages describe WHICH entry and
 * field is wrong and NEVER contain a value: the raw variable holds secrets, and
 * even JSON.parse's own message can quote part of its input.
 */

/** Channels a credential may be bound to: the external ones. MANUAL has no provider. */
export const INBOUND_CHANNELS: readonly ConversationChannel[] = [
  ConversationChannel.WHATSAPP,
  ConversationChannel.INSTAGRAM,
  ConversationChannel.FACEBOOK,
  ConversationChannel.WEBCHAT,
];

/**
 * Minimum secret length: 32 characters. `openssl rand -hex 32` gives 64 hex
 * characters (256 bits); 32 is the floor where an online guess is infeasible
 * even with no rate limit. Entropy is the operator's job (no generation here);
 * this only rejects obviously weak or placeholder values.
 */
export const MIN_SECRET_LENGTH = 32;
export const MAX_SECRET_LENGTH = 256;

const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/; // no ":" - it separates keyId and secret in HTTP Basic
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SECRET_CHARS = /^[\x21-\x7e]+$/; // visible ASCII, no whitespace
const PLACEHOLDER = /replace|change_?me|placeholder|example|dummy/i;
const ALLOWED_KEYS = new Set(['keyId', 'tenantId', 'channel', 'secret']);

export interface InboundCredential {
  keyId: string;
  tenantId: string;
  channel: ConversationChannel;
  /** SHA-256 of the secret. The plaintext is not kept after validation. */
  secretDigest: Buffer;
}

export class InboundCredentialsConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`INBOUND_SERVICE_CREDENTIALS is invalid: ${problems.join('; ')}`);
    this.name = 'InboundCredentialsConfigError';
  }
}

export function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** Parses and validates the raw variable. Throws InboundCredentialsConfigError (value-free message). */
export function parseInboundCredentials(raw: string | undefined | null): InboundCredential[] {
  const text = raw?.trim();
  if (!text) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Deliberately not forwarding the parser's message: it may quote the input.
    throw new InboundCredentialsConfigError(['value is not valid JSON']);
  }
  if (!Array.isArray(parsed)) throw new InboundCredentialsConfigError(['value must be a JSON array']);

  const problems: string[] = [];
  const credentials: InboundCredential[] = [];
  const keyIds = new Set<string>();
  const digests = new Set<string>();

  parsed.forEach((entry, index) => {
    const at = `credential #${index + 1}`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      problems.push(`${at}: must be an object`);
      return;
    }
    const fields = entry as Record<string, unknown>;
    for (const key of Object.keys(fields)) {
      if (!ALLOWED_KEYS.has(key)) problems.push(`${at}: unknown field (allowed: keyId, tenantId, channel, secret)`);
    }

    const { keyId, tenantId, channel, secret } = fields;
    let ok = true;
    const fail = (message: string) => {
      problems.push(`${at}: ${message}`);
      ok = false;
    };

    if (typeof keyId !== 'string' || !KEY_ID.test(keyId)) {
      fail('keyId must be 3-64 characters of letters, digits, ".", "_" or "-", starting with a letter or digit');
    } else if (keyIds.has(keyId)) {
      fail('keyId is duplicated');
    }
    if (typeof tenantId !== 'string' || !UUID.test(tenantId)) fail('tenantId must be a UUID');
    if (typeof channel !== 'string' || !INBOUND_CHANNELS.includes(channel as ConversationChannel)) {
      fail(`channel must be one of ${INBOUND_CHANNELS.join(', ')}`);
    }
    if (typeof secret !== 'string') {
      fail('secret must be a string');
    } else if (secret.length < MIN_SECRET_LENGTH) {
      fail(`secret must have at least ${MIN_SECRET_LENGTH} characters`);
    } else if (secret.length > MAX_SECRET_LENGTH) {
      fail(`secret must have at most ${MAX_SECRET_LENGTH} characters`);
    } else if (!SECRET_CHARS.test(secret)) {
      fail('secret must contain only visible ASCII characters, without spaces');
    } else if (PLACEHOLDER.test(secret)) {
      fail('secret looks like a placeholder; generate a random one');
    } else if (digests.has(sha256(secret).toString('hex'))) {
      fail('secret is reused by another credential');
    }

    if (!ok) return;
    const digest = sha256(secret as string);
    keyIds.add(keyId as string);
    digests.add(digest.toString('hex'));
    credentials.push({
      keyId: keyId as string,
      tenantId: (tenantId as string).toLowerCase(),
      channel: channel as ConversationChannel,
      secretDigest: digest,
    });
  });

  if (problems.length > 0) throw new InboundCredentialsConfigError(problems);
  return credentials;
}
