import { BadRequestException, ForbiddenException, HttpException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AppConfigService } from '../../../config/app-config.service';
import { normalizeInternationalPhoneDigits } from '../../contacts/phone-number';
import { ConversationIntakeService } from '../../conversations/conversation-intake.service';
import { WhatsAppAccountResolver } from '../whatsapp-account.resolver';
import { matchesVerifyToken } from './meta-signature';
import { WhatsAppStatusService } from './whatsapp-status.service';
import { WhatsAppIgnored, WhatsAppStatusEvent, WhatsAppTextEvent, parseWhatsAppWebhook } from './whatsapp-webhook.parser';

/** What one notification did. Counters only: this is what gets logged. */
export interface WebhookSummary {
  messages: number;
  duplicates: number;
  statusesApplied: number;
  statusesNoop: number;
  statusesUnmatched: number;
  ignored: number;
  unknownPhoneNumber: number;
  /** Events refused for a reason a retry cannot fix (invalid phone, conflict, ...): acknowledged, not retried. */
  rejected: number;
}

const CHALLENGE = /^[A-Za-z0-9_.~-]{1,256}$/;
/** Prisma errors that come from the data itself: delivering the same event again cannot change the outcome. */
const DETERMINISTIC_PRISMA_CODES = new Set(['P2000', 'P2003', 'P2011', 'P2012', 'P2019']);

/**
 * The WhatsApp webhook use cases: the GET verification handshake and the
 * processing of a signed notification. The controller only reads the request
 * and calls this; every rule lives here or behind it.
 *
 * PROCESSING MODEL: synchronous, before the ACK. That is safe here, and needs
 * no event table or queue, because
 *  - the work is a few short database transactions (ConversationIntakeService),
 *    and nothing in the request path talks to Meta: the automatic reply is only
 *    written as an OUTBOUND/PENDING message and sent later by the delivery
 *    worker, so a slow or dead Meta API cannot slow the ACK;
 *  - the customer's message is committed before anything else is attempted, and
 *    is idempotent by its wamid (ConversationIngressService), so a redelivery
 *    never duplicates it and never creates a second automatic reply;
 *  - durability comes from Meta itself: any non-200 makes Meta retry the same
 *    notification for up to 7 days with decreasing frequency (and it may also
 *    send duplicates unprompted), which the idempotency already absorbs.
 *
 * ERROR POLICY, per event, in payload order:
 *  - a problem the data itself causes (invalid phone, id conflict, a tenant
 *    that does not exist: 4xx-style / constraint errors) is REJECTED: logged and
 *    acknowledged, because Meta re-sending it would fail the same way for 7 days;
 *  - anything else (database down, timeout, unexpected error) makes the whole
 *    notification answer 503 AFTER the other events were processed, so Meta
 *    redelivers it; events already stored are recognised and skipped.
 *
 * The tenant of every event comes from WhatsAppAccountResolver (phone_number_id
 * -> configured tenant). A phone_number_id that is not configured is dropped.
 *
 * Logs carry ids, the event kind and outcomes. Never the message text, the
 * customer's name, phone number or BSUID, or the payload.
 */
@Injectable()
export class WhatsAppWebhookService {
  private readonly logger = new Logger(WhatsAppWebhookService.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly accounts: WhatsAppAccountResolver,
    private readonly intake: ConversationIntakeService,
    private readonly statuses: WhatsAppStatusService,
  ) {}

  /**
   * GET verification: echo the challenge, but only for the right verify token.
   * @throws BadRequestException on missing/odd parameters, ForbiddenException on a wrong token
   */
  verifySubscription(mode: unknown, verifyToken: unknown, challenge: unknown): string {
    if (typeof mode !== 'string' || typeof verifyToken !== 'string' || typeof challenge !== 'string' || mode !== 'subscribe') {
      throw new BadRequestException('Parâmetros de verificação inválidos.');
    }
    // The challenge is echoed back in the response: only Meta's random token alphabet is accepted.
    if (!CHALLENGE.test(challenge)) throw new BadRequestException('Parâmetros de verificação inválidos.');
    if (!matchesVerifyToken(verifyToken, this.config.whatsappCloud.verifyToken)) {
      this.logger.warn({ event: 'whatsapp.webhook.verification_failed' });
      throw new ForbiddenException();
    }
    return challenge;
  }

  /**
   * Processes an AUTHENTICATED notification (the signature was verified over these exact bytes).
   * @throws BadRequestException when the signed body is not JSON
   * @throws ServiceUnavailableException when an event failed for a reason worth retrying
   */
  async process(rawBody: Buffer): Promise<WebhookSummary> {
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new BadRequestException('Corpo inválido.');
    }

    const parsed = parseWhatsAppWebhook(payload);
    const summary: WebhookSummary = {
      messages: 0,
      duplicates: 0,
      statusesApplied: 0,
      statusesNoop: 0,
      statusesUnmatched: 0,
      ignored: parsed.ignored.length,
      unknownPhoneNumber: 0,
      rejected: 0,
    };
    let transientFailures = 0;

    for (const event of parsed.events) {
      const account = this.accounts.byPhoneNumberId(event.phoneNumberId);
      if (!account) {
        summary.unknownPhoneNumber += 1;
        this.logger.warn({ event: 'whatsapp.webhook.unknown_phone_number', phoneNumberId: event.phoneNumberId, kind: event.kind });
        continue;
      }

      try {
        if (event.kind === 'text') await this.handleText(account.tenantId, event, summary);
        else await this.handleStatus(account.tenantId, event, summary);
      } catch (error) {
        if (isDeterministic(error)) {
          summary.rejected += 1;
          this.logger.warn({ event: 'whatsapp.event.rejected', tenantId: account.tenantId, phoneNumberId: event.phoneNumberId, kind: event.kind, messageId: event.messageId, ...describe(error) });
        } else {
          transientFailures += 1;
          this.logger.error({ event: 'whatsapp.event.failed', tenantId: account.tenantId, phoneNumberId: event.phoneNumberId, kind: event.kind, messageId: event.messageId, ...describe(error) });
        }
      }
    }

    this.logger.log({ event: 'whatsapp.webhook.processed', ...summary, ignoredBy: countIgnored(parsed.ignored) });

    if (transientFailures > 0) {
      // 503, not 500: "try again later". Meta redelivers; what was already stored is skipped.
      throw new ServiceUnavailableException();
    }
    return summary;
  }

  private async handleText(tenantId: string, event: WhatsAppTextEvent, summary: WebhookSummary): Promise<void> {
    const { waId, bsuid } = event.sender;
    // A phone-based identity when Meta gave the phone (wa_id is a trusted, international, digits-only
    // id: normalizeInternationalPhoneDigits adds the "+", no default country is ever assumed);
    // otherwise the business-scoped user id, and no phone is known for this contact.
    const externalContactId = (waId ?? bsuid) as string;
    const result = await this.intake.receive({
      tenantId,
      channel: 'WHATSAPP',
      externalContactId,
      // WhatsApp has no provider thread/session id: a conversation is the (open) one of this contact on this channel.
      externalConversationId: null,
      externalMessageId: event.messageId,
      contact: { name: event.profileName, phone: this.normalizedPhone(waId, tenantId, event.phoneNumberId) },
      content: event.text,
      occurredAt: event.occurredAt ?? undefined,
    });

    summary.messages += 1;
    if (result.duplicate) summary.duplicates += 1;
    this.logger.log({
      event: 'whatsapp.message.received',
      tenantId,
      phoneNumberId: event.phoneNumberId,
      messageId: event.messageId,
      conversationId: result.conversation.id,
      senderKind: waId ? 'phone' : 'bsuid',
      duplicate: result.duplicate,
      autoReply: result.autoReply.reason,
    });
  }

  /**
   * The wa_id as an E.164 phone (reusing the Stage B helper: no country is ever
   * guessed), or null. A wa_id our phone metadata does not recognise (e.g. a
   * numbering range newer than the library) must NOT cost the customer their
   * reply: the message is still stored under the wa_id identity, only without a
   * normalized phone on the contact.
   */
  private normalizedPhone(waId: string | null, tenantId: string, phoneNumberId: string): string | null {
    if (!waId) return null;
    try {
      return normalizeInternationalPhoneDigits(waId);
    } catch {
      this.logger.warn({ event: 'whatsapp.phone.not_normalizable', tenantId, phoneNumberId });
      return null;
    }
  }

  private async handleStatus(tenantId: string, event: WhatsAppStatusEvent, summary: WebhookSummary): Promise<void> {
    const outcome = await this.statuses.apply({ tenantId, messageId: event.messageId, status: event.status, errorCode: event.errorCode });

    if (outcome === 'updated') summary.statusesApplied += 1;
    else if (outcome === 'noop') summary.statusesNoop += 1;
    else summary.statusesUnmatched += 1;

    const line = { event: 'whatsapp.status.received', tenantId, phoneNumberId: event.phoneNumberId, messageId: event.messageId, status: event.status, outcome, errorCode: event.errorCode ?? undefined };
    if (outcome === 'unmatched') this.logger.warn(line);
    else this.logger.log(line);
  }
}

/** A failure that re-delivering the same event cannot fix (bad data), as opposed to one worth a retry. */
function isDeterministic(error: unknown): boolean {
  if (error instanceof HttpException) return error.getStatus() < 500;
  return error instanceof Prisma.PrismaClientKnownRequestError && DETERMINISTIC_PRISMA_CODES.has(error.code);
}

/** Error NAME/code only: a Prisma or driver message can quote the data being written (a customer's text or phone). */
function describe(error: unknown): { errorName: string; code?: string; status?: number } {
  const failure = error as { name?: unknown; code?: unknown } | null;
  return {
    errorName: typeof failure?.name === 'string' ? failure.name : 'UnknownError',
    code: typeof failure?.code === 'string' ? failure.code : undefined,
    status: error instanceof HttpException ? error.getStatus() : undefined,
  };
}

function countIgnored(ignored: WhatsAppIgnored[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of ignored) {
    const key = [item.reason, item.field, item.type].filter(Boolean).join(':');
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}
