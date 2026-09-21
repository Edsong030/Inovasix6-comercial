import { Injectable } from '@nestjs/common';
import { ConversationIngressInput, ConversationIngressResult, ConversationIngressService } from './conversation-ingress.service';
import { FirstContactOutcome, FirstContactService } from './first-contact/first-contact.service';

export interface ConversationIntakeResult extends ConversationIngressResult {
  /**
   * What the first-contact step did. NOTE: `conversation` above is the row as
   * the ingress left it; when autoReply.reason is 'replied' its state has since
   * moved to AGUARDANDO_HUMANO.
   */
  autoReply: FirstContactOutcome;
}

/**
 * The whole inbound path in one call: persist the customer's message
 * (ConversationIngressService, which owns Contact/Conversation/Message and
 * idempotency) and then, only if it opened a first contact, create the
 * automatic acknowledgement (FirstContactService).
 *
 * The two steps are separate transactions on purpose: the customer's message is
 * committed before any reply is attempted, so a failed reply cannot lose it (see
 * FirstContactService). Callers - the HTTP controller today, channel adapters
 * later - use this instead of remembering to call both.
 */
@Injectable()
export class ConversationIntakeService {
  constructor(
    private readonly ingress: ConversationIngressService,
    private readonly firstContact: FirstContactService,
  ) {}

  async receive(input: ConversationIngressInput): Promise<ConversationIntakeResult> {
    const result = await this.ingress.ingest(input);
    const autoReply = await this.firstContact.acknowledge(result);
    return { ...result, autoReply };
  }
}
