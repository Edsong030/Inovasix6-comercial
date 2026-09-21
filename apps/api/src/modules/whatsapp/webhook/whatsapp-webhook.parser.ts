/**
 * Turns a WhatsApp Cloud API webhook payload (already authenticated by its
 * signature) into the few events this system acts on. Pure and defensive: the
 * payload is untrusted-shaped JSON, so every field is checked before use and
 * anything unexpected is REPORTED as ignored, never thrown.
 *
 * Shape (Meta docs, "messages" webhook field):
 *   { object: "whatsapp_business_account",
 *     entry: [{ id: <WABA id>,
 *       changes: [{ field: "messages",
 *         value: { messaging_product: "whatsapp",
 *           metadata: { display_phone_number, phone_number_id },
 *           contacts: [{ wa_id?, user_id?, profile: { name, username? } }],
 *           messages: [{ id, from?, from_user_id?, timestamp, type, text: { body } }],
 *           statuses: [{ id, status, timestamp, recipient_id?, errors?: [{ code }] }] } }] }] }
 *
 * WHAT IS ACTED ON
 *  - text messages;
 *  - status callbacks sent | delivered | read | failed for OUR outbound messages.
 * Everything else (media, location, reactions, contacts, stickers, interactive,
 * unsupported, plus other webhook fields such as template or account updates) is
 * acknowledged and ignored: this stage cannot represent it as a conversation
 * message correctly, and answering content we cannot represent would be wrong.
 *
 * SENDER IDENTITY. The phone number is not guaranteed: when a user has enabled a
 * WhatsApp username and the business has no prior interaction, `from`/`wa_id`
 * are omitted and only the business-scoped user id (BSUID: `from_user_id`,
 * "US.1349...") is present. So the sender is a phone (`waId`) when the payload
 * has one, and a BSUID otherwise; the two are distinguishable by format.
 *
 * ECHOES / LOOPS. The `messages` field only carries messages sent BY a WhatsApp
 * user; what the business sends comes back as `statuses`. Messages the business
 * sends through the WhatsApp Business app (coexistence) arrive in a DIFFERENT
 * field, `smb_message_echoes`, which is never processed (reported as 'echo').
 * As a second layer, a message whose sender is the business's own number is
 * dropped as an echo too. Statuses never create messages.
 */

export type IgnoreReason =
  | 'not_whatsapp_object'
  | 'unsupported_field'
  | 'echo'
  | 'unsupported_message_type'
  | 'unsupported_status'
  | 'no_sender'
  | 'malformed';

export interface WhatsAppIgnored {
  reason: IgnoreReason;
  /** Webhook field (e.g. "smb_message_echoes"), when that is what was ignored. Sanitized. */
  field?: string;
  /** Message type (e.g. "image"), when that is what was ignored. Sanitized. */
  type?: string;
  phoneNumberId?: string;
}

export interface WhatsAppTextEvent {
  kind: 'text';
  phoneNumberId: string;
  /** Meta's message id (wamid): the idempotency key of the inbound message. */
  messageId: string;
  sender: { waId: string | null; bsuid: string | null };
  profileName: string | null;
  text: string;
  occurredAt: Date | null;
}

export type MetaStatus = 'sent' | 'delivered' | 'read' | 'failed';

export interface WhatsAppStatusEvent {
  kind: 'status';
  phoneNumberId: string;
  /** The wamid of the outbound message the status is about. */
  messageId: string;
  status: MetaStatus;
  /** Meta's numeric error code of a failed status, as a string. Nothing else of the error is kept. */
  errorCode: string | null;
  occurredAt: Date | null;
}

export type WhatsAppEvent = WhatsAppTextEvent | WhatsAppStatusEvent;

export interface ParsedWebhook {
  events: WhatsAppEvent[];
  ignored: WhatsAppIgnored[];
}

const PHONE_NUMBER_ID = /^\d{5,32}$/;
const MESSAGE_ID = /^[\x21-\x7e]{1,256}$/;
const WA_ID = /^\d{5,20}$/;
/** Business-scoped user id: ISO 3166 alpha-2 country, ".", up to 128 alphanumerics (Meta docs). */
export const BSUID_PATTERN = /^[A-Z]{2}\.[A-Za-z0-9]{1,128}$/;
const TOKEN = /^[a-z][a-z0-9_]{0,63}$/;
const TIMESTAMP = /^\d{9,12}$/;
const STATUSES: ReadonlySet<string> = new Set(['sent', 'delivered', 'read', 'failed']);
const MAX_NAME_LENGTH = 256;

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const digitsOf = (value: string): string => value.replace(/\D/g, '');
/** Only well-formed identifiers reach a log line; anything else is reported as 'other'. */
const safeToken = (value: unknown): string => (typeof value === 'string' && TOKEN.test(value) ? value : 'other');

export function parseWhatsAppWebhook(payload: unknown): ParsedWebhook {
  const result: ParsedWebhook = { events: [], ignored: [] };
  if (!isObject(payload) || payload.object !== 'whatsapp_business_account') {
    result.ignored.push({ reason: 'not_whatsapp_object' });
    return result;
  }

  for (const entry of asArray(payload.entry)) {
    if (!isObject(entry)) {
      result.ignored.push({ reason: 'malformed' });
      continue;
    }
    for (const change of asArray(entry.changes)) {
      if (!isObject(change)) {
        result.ignored.push({ reason: 'malformed' });
        continue;
      }
      const field = safeToken(change.field);
      if (change.field === 'smb_message_echoes') {
        result.ignored.push({ reason: 'echo', field });
        continue;
      }
      if (change.field !== 'messages') {
        result.ignored.push({ reason: 'unsupported_field', field });
        continue;
      }
      parseMessagesValue(change.value, result);
    }
  }
  return result;
}

function parseMessagesValue(value: unknown, out: ParsedWebhook): void {
  const metadata = isObject(value) ? value.metadata : undefined;
  const phoneNumberId = isObject(metadata) ? asString(metadata.phone_number_id) : null;
  if (!isObject(value) || !phoneNumberId || !PHONE_NUMBER_ID.test(phoneNumberId)) {
    out.ignored.push({ reason: 'malformed' });
    return;
  }
  const businessDigits = digitsOf(asString((metadata as Json).display_phone_number) ?? '');
  const contacts = asArray(value.contacts).filter(isObject);

  for (const message of asArray(value.messages)) {
    if (!isObject(message)) {
      out.ignored.push({ reason: 'malformed', phoneNumberId });
      continue;
    }
    parseMessage(message, contacts, phoneNumberId, businessDigits, out);
  }
  for (const status of asArray(value.statuses)) {
    if (!isObject(status)) {
      out.ignored.push({ reason: 'malformed', phoneNumberId });
      continue;
    }
    parseStatus(status, phoneNumberId, out);
  }
}

function parseMessage(message: Json, contacts: Json[], phoneNumberId: string, businessDigits: string, out: ParsedWebhook): void {
  const id = asString(message.id);
  if (!id || !MESSAGE_ID.test(id)) {
    out.ignored.push({ reason: 'malformed', phoneNumberId });
    return;
  }
  if (message.type !== 'text') {
    out.ignored.push({ reason: 'unsupported_message_type', type: safeToken(message.type), phoneNumberId });
    return;
  }
  const body = isObject(message.text) ? asString(message.text.body) : null;
  if (!body || body.length === 0) {
    out.ignored.push({ reason: 'malformed', type: 'text', phoneNumberId });
    return;
  }

  const from = asString(message.from);
  const fromUserId = asString(message.from_user_id);
  const waId = from && WA_ID.test(from) ? from : null;
  const bsuid = fromUserId && BSUID_PATTERN.test(fromUserId) ? fromUserId : null;
  if (!waId && !bsuid) {
    out.ignored.push({ reason: 'no_sender', type: 'text', phoneNumberId });
    return;
  }
  // The business's own number can never be a customer: that would be an echo, and answering it would loop.
  if (waId && businessDigits && waId === businessDigits) {
    out.ignored.push({ reason: 'echo', type: 'text', phoneNumberId });
    return;
  }

  out.events.push({
    kind: 'text',
    phoneNumberId,
    messageId: id,
    sender: { waId, bsuid },
    profileName: profileNameFor(contacts, waId, bsuid),
    text: body,
    occurredAt: toDate(message.timestamp),
  });
}

function parseStatus(status: Json, phoneNumberId: string, out: ParsedWebhook): void {
  const id = asString(status.id);
  if (!id || !MESSAGE_ID.test(id)) {
    out.ignored.push({ reason: 'malformed', phoneNumberId });
    return;
  }
  const kind = asString(status.status);
  if (!kind || !STATUSES.has(kind)) {
    // e.g. "played" (audio) and any status Meta adds later.
    out.ignored.push({ reason: 'unsupported_status', type: safeToken(kind), phoneNumberId });
    return;
  }
  out.events.push({
    kind: 'status',
    phoneNumberId,
    messageId: id,
    status: kind as MetaStatus,
    errorCode: kind === 'failed' ? errorCodeOf(status.errors) : null,
    occurredAt: toDate(status.timestamp),
  });
}

/** The display name Meta gives for THIS sender: matched by id, never by position. */
function profileNameFor(contacts: Json[], waId: string | null, bsuid: string | null): string | null {
  const contact = contacts.find((c) => (waId && c.wa_id === waId) || (bsuid && c.user_id === bsuid));
  const name = contact && isObject(contact.profile) ? asString(contact.profile.name) : null;
  // eslint-disable-next-line no-control-regex -- strip control characters from an external display name
  const cleaned = name?.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_NAME_LENGTH);
  return cleaned || null;
}

function toDate(value: unknown): Date | null {
  const text = typeof value === 'number' ? String(value) : asString(value);
  if (!text || !TIMESTAMP.test(text)) return null;
  return new Date(Number(text) * 1000);
}

function errorCodeOf(errors: unknown): string | null {
  const first = asArray(errors).find(isObject);
  const code = first?.code;
  return typeof code === 'number' && Number.isInteger(code) && code >= 0 && code <= 999_999_999 ? String(code) : null;
}
