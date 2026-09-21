import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConversationChannel } from '@prisma/client';
import { AppConfigService } from '../../../config/app-config.service';
import { OutboundChannelAdapter, OutboundDeliveryError, OutboundSendInput, OutboundSendResult } from '../../delivery/outbound-channel-adapter';
import { WhatsAppAccountResolver } from '../whatsapp-account.resolver';
import { BSUID_PATTERN } from '../webhook/whatsapp-webhook.parser';
import { classifyGraphFailure } from './whatsapp-error-codes';

/** DI token for the HTTP function: production uses global fetch; tests inject a double. */
export const WHATSAPP_FETCH = Symbol('WHATSAPP_FETCH');
export type FetchLike = typeof fetch;

const PHONE_RECIPIENT = /^\d{5,20}$/;
const MAX_RESPONSE_CHARS = 1_000_000;
const MAX_PROVIDER_ID_LENGTH = 512;

/**
 * Delivers an OUTBOUND text message through the WhatsApp Cloud API (Graph API).
 * It is an ordinary channel adapter for the Stage F delivery engine: the engine
 * claims the message, calls send(), and records SENT/retry/FAILED from the
 * result. This class knows Meta; the engine and the domain do not.
 *
 *   POST {base}/{version}/{phone_number_id}/messages
 *   Authorization: Bearer {token}
 *   { messaging_product: "whatsapp", recipient_type: "individual", to, type: "text", text: { body } }
 *   -> 200 { messages: [{ id: "wamid...." }] }
 *
 * TENANT AND SENDER. Which phone number and token to use comes from the tenant
 * of the message being sent (WhatsAppAccountResolver.byTenant), never from the
 * message. A tenant with no configured account fails permanently
 * (WA_NOT_CONFIGURED) instead of borrowing another tenant's number.
 *
 * RECIPIENT. It is the contact's identity on this channel, resolved by the
 * engine from the conversation (Message -> Conversation -> Contact ->
 * ContactChannelIdentity), never from request data: a wa_id (digits) goes in
 * `to`, a business-scoped user id (BSUID, when the customer's phone was never
 * shown to us) goes in `recipient`. Anything else is refused.
 *
 * CONTENT. Free-form TEXT only; no templates, media, buttons or previews. That
 * is valid only inside the 24-hour customer service window (which starts when
 * the customer writes). The automatic first-contact reply is sent right after
 * the customer's message, inside it. Outside it Meta answers error 131047 and
 * the message ends FAILED (WA_131047): this stage neither works around the
 * window nor sends templates.
 *
 * HTTP. Every call has a hard timeout (WHATSAPP_HTTP_TIMEOUT_MS, below the
 * engine's own send timeout) and also aborts with the engine's signal. Redirects
 * are never followed: a redirect would resend the Authorization header to
 * whatever host answered. The response body is read with a size cap and only
 * the message id or Meta's numeric error code is used from it.
 *
 * SECRETS. The token is read only to build the Authorization header. It is
 * never logged, and no error thrown from here carries provider text.
 *
 * DELIVERY GUARANTEE. Meta's Messages API has no idempotency key, so the engine's
 * at-least-once window applies in full: if the process dies after Meta accepted
 * a message and before SENT was recorded, it is sent again and the customer may
 * get it twice.
 */
@Injectable()
export class WhatsAppCloudAdapter implements OutboundChannelAdapter {
  readonly channel = ConversationChannel.WHATSAPP;
  private readonly logger = new Logger(WhatsAppCloudAdapter.name);
  private readonly fetchImpl: FetchLike;

  constructor(
    private readonly config: AppConfigService,
    private readonly accounts: WhatsAppAccountResolver,
    @Optional() @Inject(WHATSAPP_FETCH) fetchImpl?: FetchLike,
  ) {
    this.fetchImpl = fetchImpl ?? ((input, init) => fetch(input, init));
  }

  async send(input: OutboundSendInput): Promise<OutboundSendResult> {
    const settings = this.config.whatsappCloud;
    const account = this.accounts.byTenant(input.tenantId);
    if (!account) throw OutboundDeliveryError.permanent('WA_NOT_CONFIGURED');

    const recipient = buildRecipient(input.recipient.externalContactId);
    if (!recipient) throw OutboundDeliveryError.permanent('WA_INVALID_RECIPIENT');

    const url = `${settings.graphApiBaseUrl}/${settings.graphApiVersion}/${account.phoneNumberId}/messages`;
    const ownTimeout = AbortSignal.timeout(settings.httpTimeoutMs);
    const signal = AbortSignal.any([input.signal, ownTimeout]);
    const started = Date.now();

    let response: Response;
    let text: string;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: {
          Authorization: `Bearer ${account.accessToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          ...recipient,
          type: 'text',
          text: { body: input.body },
        }),
      });
      text = (await response.text()).slice(0, MAX_RESPONSE_CHARS + 1);
    } catch {
      // No error detail is kept (a network library message can include the URL and headers).
      const code = input.signal.aborted ? 'TIMEOUT' : ownTimeout.aborted ? 'WA_TIMEOUT' : 'WA_NETWORK';
      this.report(input, account.phoneNumberId, started, { code });
      throw OutboundDeliveryError.temporary(code);
    }

    const body = parseJson(text);

    if (response.ok) {
      const providerId = firstMessageId(body);
      if (!providerId) {
        // 200 without a usable id: whether Meta accepted it is unknowable. Retrying could send it twice
        // to a real customer, so it is not retried (same stance as the engine's INVALID_ADAPTER_RESULT).
        this.report(input, account.phoneNumberId, started, { httpStatus: response.status, code: 'WA_INVALID_RESPONSE' });
        throw OutboundDeliveryError.permanent('WA_INVALID_RESPONSE');
      }
      this.report(input, account.phoneNumberId, started, { httpStatus: response.status });
      return { externalMessageId: providerId };
    }

    const failure = classifyGraphFailure(response.status, body);
    this.report(input, account.phoneNumberId, started, { httpStatus: response.status, code: failure.code });
    throw new OutboundDeliveryError(failure.kind, failure.code);
  }

  /** Ids, status, duration and a numeric code. Never the token, the recipient, the text or the response body. */
  private report(input: OutboundSendInput, phoneNumberId: string, started: number, result: { httpStatus?: number; code?: string }): void {
    this.logger.debug({
      event: 'whatsapp.send',
      tenantId: input.tenantId,
      phoneNumberId,
      messageId: input.idempotencyKey,
      durationMs: Date.now() - started,
      ...result,
    });
  }
}

/** `to` for a phone (wa_id), `recipient` for a BSUID, null for anything else. */
function buildRecipient(externalContactId: string): { recipient_type: 'individual'; to: string } | { recipient: string } | null {
  if (PHONE_RECIPIENT.test(externalContactId)) return { recipient_type: 'individual', to: externalContactId };
  if (BSUID_PATTERN.test(externalContactId)) return { recipient: externalContactId };
  return null;
}

function parseJson(text: string): unknown {
  if (text.length === 0 || text.length > MAX_RESPONSE_CHARS) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function firstMessageId(body: unknown): string | null {
  const messages = typeof body === 'object' && body !== null ? (body as { messages?: unknown }).messages : undefined;
  const first = Array.isArray(messages) ? messages[0] : undefined;
  const id = typeof first === 'object' && first !== null ? (first as { id?: unknown }).id : undefined;
  return typeof id === 'string' && id.trim().length > 0 && id.length <= MAX_PROVIDER_ID_LENGTH ? id : null;
}

