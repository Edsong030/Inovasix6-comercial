import { inspect } from 'node:util';

/**
 * Configuration of the WhatsApp Cloud API integration (Meta), read from
 * environment variables. Nothing here is hardcoded: no token, no tenant, no
 * phone number, and no single global WhatsApp shared implicitly by all tenants.
 *
 * WHAT IS GLOBAL AND WHAT IS PER TENANT
 *
 *  Global (one Meta App for the whole platform):
 *   - WHATSAPP_META_APP_SECRET: the App Secret that signs every webhook
 *     (X-Hub-Signature-256). The signature is checked BEFORE anything in the
 *     payload is trusted, so it cannot depend on the tenant.
 *   - WHATSAPP_WEBHOOK_VERIFY_TOKEN: the string typed into the Meta dashboard
 *     for the GET verification handshake.
 *
 *  Per tenant, explicit (WHATSAPP_CLOUD_ACCOUNTS, a JSON array, single-quoted):
 *   [{ "tenantId": "<tenant uuid>", "phoneNumberId": "<Meta phone_number_id>",
 *      "accessToken": "<system user / business token>" }]
 *   The tenant of an incoming webhook is resolved ONLY from this table, by the
 *   phone_number_id Meta puts in the (signed) payload. It is never read from a
 *   request field, and a phone_number_id that is not listed is never routed to
 *   any tenant. The same table gives the outbound adapter the phone number and
 *   token to send from for a tenant.
 *
 * WHY ENV IS ENOUGH FOR THIS STAGE, AND WHERE IT STOPS SCALING: it needs no
 * schema change and keeps every secret out of the database and the repository.
 * But adding a tenant or rotating its token means editing the variable and
 * restarting, and every tenant's token sits in one variable. Beyond a handful
 * of tenants the accounts belong in an encrypted table (see the stage report);
 * WhatsAppAccountResolver is the seam where that source would be swapped in.
 * One WhatsApp account per tenant for now: a Conversation does not record which
 * business number it was opened on, so a tenant with two numbers would make the
 * sender ambiguous.
 *
 * FEATURE FLAG: WHATSAPP_CLOUD_ENABLED is false by default. While false the
 * webhook endpoints do not exist (404) and no outbound adapter is registered,
 * so adding the variables to a dev/test environment can never start sending
 * real messages by accident.
 *
 * Validation runs at boot (Joi, env.validation.ts). Error messages name WHICH
 * entry/field is wrong and NEVER contain a value: these variables hold secrets,
 * and even JSON.parse's own message can quote part of its input.
 */

/**
 * Graph API version used when WHATSAPP_GRAPH_API_VERSION is unset. v25.0 is the
 * version Meta's WhatsApp Cloud API documentation shows as current (checked
 * September 2026). It is configurable so an upgrade or a pin is a config change.
 */
export const DEFAULT_GRAPH_API_VERSION = 'v25.0';
export const DEFAULT_GRAPH_API_BASE_URL = 'https://graph.facebook.com';
/** Hard limit of one Graph API call. Must stay below OUTBOUND_SEND_TIMEOUT_MS (the dispatcher's own limit). */
export const DEFAULT_WHATSAPP_HTTP_TIMEOUT_MS = 10_000;
export const WHATSAPP_HTTP_TIMEOUT_LIMITS = { min: 1_000, max: 60_000 } as const;

export const MIN_APP_SECRET_LENGTH = 16;
export const MIN_VERIFY_TOKEN_LENGTH = 16;
export const MAX_SECRET_LENGTH = 512;
const MIN_ACCESS_TOKEN_LENGTH = 20;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Meta ids (phone_number_id, WABA id) are numeric strings. */
const PHONE_NUMBER_ID = /^\d{5,32}$/;
const VISIBLE_ASCII = /^[\x21-\x7e]+$/;
const PLACEHOLDER = /replace|change_?me|placeholder|example|dummy|your[_-]?token/i;
const ALLOWED_KEYS = new Set(['tenantId', 'phoneNumberId', 'accessToken']);
export const GRAPH_API_VERSION_PATTERN = /^v\d{1,3}\.\d{1,2}$/;

export interface WhatsAppCloudSettings {
  enabled: boolean;
  appSecret: string;
  verifyToken: string;
  graphApiVersion: string;
  graphApiBaseUrl: string;
  httpTimeoutMs: number;
}

/**
 * One tenant's WhatsApp number and token. The token is a secret: it is kept in a
 * private field and every implicit serialization (JSON, util.inspect, string
 * conversion) shows a redaction instead, so an account that ends up in a log
 * line or an error message cannot leak it.
 */
export class WhatsAppCloudAccount {
  readonly tenantId: string;
  readonly phoneNumberId: string;
  readonly #accessToken: string;

  constructor(tenantId: string, phoneNumberId: string, accessToken: string) {
    this.tenantId = tenantId;
    this.phoneNumberId = phoneNumberId;
    this.#accessToken = accessToken;
  }

  /** The only way to read the token: call it where the Authorization header is built, nowhere else. */
  get accessToken(): string {
    return this.#accessToken;
  }

  toJSON(): { tenantId: string; phoneNumberId: string; accessToken: string } {
    return { tenantId: this.tenantId, phoneNumberId: this.phoneNumberId, accessToken: '[REDACTED]' };
  }

  toString(): string {
    return `WhatsAppCloudAccount(${this.tenantId}, ${this.phoneNumberId})`;
  }

  [inspect.custom](): string {
    return this.toString();
  }
}

export class WhatsAppCloudConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`WHATSAPP_CLOUD_ACCOUNTS is invalid: ${problems.join('; ')}`);
    this.name = 'WhatsAppCloudConfigError';
  }
}

/** Parses and validates WHATSAPP_CLOUD_ACCOUNTS. Throws WhatsAppCloudConfigError (value-free message). */
export function parseWhatsAppCloudAccounts(raw: string | undefined | null): WhatsAppCloudAccount[] {
  const text = raw?.trim();
  if (!text) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Deliberately not forwarding the parser's message: it may quote the input.
    throw new WhatsAppCloudConfigError(['value is not valid JSON']);
  }
  if (!Array.isArray(parsed)) throw new WhatsAppCloudConfigError(['value must be a JSON array']);

  const problems: string[] = [];
  const accounts: WhatsAppCloudAccount[] = [];
  const tenants = new Set<string>();
  const phoneNumberIds = new Set<string>();

  parsed.forEach((entry, index) => {
    const at = `account #${index + 1}`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      problems.push(`${at}: must be an object`);
      return;
    }
    const fields = entry as Record<string, unknown>;
    for (const key of Object.keys(fields)) {
      if (!ALLOWED_KEYS.has(key)) problems.push(`${at}: unknown field (allowed: tenantId, phoneNumberId, accessToken)`);
    }

    const { tenantId, phoneNumberId, accessToken } = fields;
    let ok = true;
    const fail = (message: string) => {
      problems.push(`${at}: ${message}`);
      ok = false;
    };

    if (typeof tenantId !== 'string' || !UUID.test(tenantId)) {
      fail('tenantId must be a UUID');
    } else if (tenants.has(tenantId.toLowerCase())) {
      fail('tenantId is duplicated (one WhatsApp account per tenant)');
    }
    if (typeof phoneNumberId !== 'string' || !PHONE_NUMBER_ID.test(phoneNumberId)) {
      fail('phoneNumberId must be the numeric phone_number_id from Meta');
    } else if (phoneNumberIds.has(phoneNumberId)) {
      fail('phoneNumberId is duplicated (a number belongs to one tenant)');
    }
    if (typeof accessToken !== 'string') {
      fail('accessToken must be a string');
    } else if (accessToken.length < MIN_ACCESS_TOKEN_LENGTH) {
      fail(`accessToken must have at least ${MIN_ACCESS_TOKEN_LENGTH} characters`);
    } else if (accessToken.length > MAX_SECRET_LENGTH) {
      fail(`accessToken must have at most ${MAX_SECRET_LENGTH} characters`);
    } else if (!VISIBLE_ASCII.test(accessToken)) {
      fail('accessToken must contain only visible ASCII characters, without spaces');
    } else if (PLACEHOLDER.test(accessToken)) {
      fail('accessToken looks like a placeholder');
    }

    if (!ok) return;
    tenants.add((tenantId as string).toLowerCase());
    phoneNumberIds.add(phoneNumberId as string);
    accounts.push(new WhatsAppCloudAccount((tenantId as string).toLowerCase(), phoneNumberId as string, accessToken as string));
  });

  if (problems.length > 0) throw new WhatsAppCloudConfigError(problems);
  return accounts;
}

/** Value-free problems of a secret-like variable, or null when it is acceptable. */
export function secretProblem(name: string, value: string | undefined, minLength: number): string | null {
  if (!value) return `${name} is required`;
  if (value.length < minLength) return `${name} must have at least ${minLength} characters`;
  if (value.length > MAX_SECRET_LENGTH) return `${name} must have at most ${MAX_SECRET_LENGTH} characters`;
  if (!VISIBLE_ASCII.test(value)) return `${name} must contain only visible ASCII characters, without spaces`;
  if (PLACEHOLDER.test(value)) return `${name} looks like a placeholder`;
  return null;
}

/** Value-free problem of the Graph API base URL (an origin only), or null. */
export function baseUrlProblem(value: string, isProduction: boolean): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'WHATSAPP_GRAPH_API_BASE_URL must be a valid URL';
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && !isProduction)) {
    return isProduction ? 'WHATSAPP_GRAPH_API_BASE_URL must use https' : 'WHATSAPP_GRAPH_API_BASE_URL must use http(s)';
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    return 'WHATSAPP_GRAPH_API_BASE_URL must be an origin only (no credentials, path, query or fragment)';
  }
  return null;
}
