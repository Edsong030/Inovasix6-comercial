import { Injectable, Logger } from '@nestjs/common';
import {
  Conversation,
  ConversationChannel,
  ConversationState,
  Message,
  MessageDirection,
  MessageSenderType,
  MessageStatus,
} from '@prisma/client';
import { writeAudit } from '../../../common/audit/audit.helper';
import { AppConfigService } from '../../../config/app-config.service';
import { INBOUND_CHANNELS } from '../../../config/inbound-credentials';
import { PrismaService } from '../../../prisma/prisma.service';
import type { ConversationIngressResult } from '../conversation-ingress.service';

/**
 * Channels a first-contact reply may go out on: the external ones. MANUAL is
 * excluded on purpose: a MANUAL conversation is one an internal user opened,
 * so a person is already in control and there is no customer waiting on a
 * provider for an acknowledgement.
 */
export const FIRST_CONTACT_CHANNELS: readonly ConversationChannel[] = INBOUND_CHANNELS;

/**
 * What happened to the first-contact reply of one ingested message.
 *  - replied:      this call created THE automatic reply and handed the conversation to the team
 *  - duplicate:    the inbound was a redelivery; nothing is evaluated, nothing is written
 *  - not_eligible: not a first contact (already acknowledged, a person has it, closed, or a non-external channel)
 *  - failed:       the inbound is safe, the reply could not be created (logged); the conversation stays eligible
 */
export type FirstContactReason = 'replied' | 'duplicate' | 'not_eligible' | 'failed';

export interface FirstContactOutcome {
  reason: FirstContactReason;
  /** The automatic reply, when reason is 'replied'. */
  message: Message | null;
}

/**
 * First contact -> automatic acknowledgement -> human handoff.
 *
 * FORMAL DEFINITION. A message is a first contact when, in the same tenant:
 *   1. it was really created now (not an idempotent redelivery), and
 *   2. its conversation is on an external channel, and
 *   3. the conversation is in AI_ATENDENDO with no assignedUserId.
 * AI_ATENDENDO is the ENTRY state: it is the column default and no flow ever
 * moves a conversation back into it (see ALLOWED_TRANSITIONS; unassign goes to
 * AGUARDANDO_HUMANO). So "still in AI_ATENDENDO" means "never acknowledged and
 * nobody has touched it". The text of the message plays no part.
 *
 * AT MOST ONE reply per conversation, enforced by the database, not by memory:
 * the reply is only created by the transaction that wins an atomic
 * compare-and-set, `UPDATE ... SET state = AGUARDANDO_HUMANO WHERE state =
 * AI_ATENDENDO AND assigned_user_id IS NULL AND channel IN (...)`. Postgres
 * locks the row, and a concurrent transaction re-evaluates that WHERE on the
 * committed row: it sees AGUARDANDO_HUMANO and updates 0 rows. The claim and
 * the reply are one transaction, so a conversation is never handed to the team
 * without its reply, nor replied to twice. Works across any number of instances.
 *
 * A HUMAN ALWAYS WINS. Assigning (assign(): assignedUserId + HUMANO_ATENDENDO),
 * moving the state, or closing all update the same row. Whoever gets the row
 * lock first decides: if the person committed first, the claim's WHERE no
 * longer matches and no reply is ever created after the takeover; if the claim
 * committed first, the reply legitimately came before the takeover.
 *
 * FAILURE. This runs AFTER the inbound message is committed (ConversationIngress
 * owns that transaction), and never throws: a failure is logged as an error and
 * returned as 'failed'. The customer's message is never rolled back for it. The
 * claim rolls back with the failed reply, so the conversation remains in
 * AI_ATENDENDO and the next inbound message tries again.
 *
 * The reply is a real OUTBOUND Message with status PENDING ("created, not yet
 * delivered to the provider": no channel adapter exists yet, so it must not
 * claim SENT/DELIVERED) and senderType SYSTEM with no sender user: that is what
 * tells it apart from an agent's message (AGENT + senderUserId) structurally.
 * A future adapter picks up PENDING outbound messages and moves them on.
 */
@Injectable()
export class FirstContactService {
  private readonly logger = new Logger(FirstContactService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
  ) {}

  async acknowledge(result: ConversationIngressResult): Promise<FirstContactOutcome> {
    const { conversation, message: inbound } = result;

    if (result.duplicate || !result.messageCreated) return { reason: 'duplicate', message: null };
    // Cheap pre-filter from the row ingest just returned: a stale AI_ATENDENDO
    // is settled by the claim below; a non-AI state can never become AI again.
    if (!isPendingFirstContact(conversation)) return { reason: 'not_eligible', message: null };

    try {
      const reply = await this.prisma.runWithTenant(conversation.tenantId, async (tx) => {
        const claimed = await tx.conversation.updateMany({
          where: {
            id: conversation.id,
            tenantId: conversation.tenantId,
            state: ConversationState.AI_ATENDENDO,
            assignedUserId: null,
            channel: { in: [...FIRST_CONTACT_CHANNELS] },
          },
          data: { state: ConversationState.AGUARDANDO_HUMANO },
        });
        if (claimed.count === 0) return null;

        // Strictly after the customer's message, so the thread reads in order.
        const createdAt = new Date(Math.max(Date.now(), inbound.createdAt.getTime() + 1));
        const created = await tx.message.create({
          data: {
            tenantId: conversation.tenantId,
            conversationId: conversation.id,
            direction: MessageDirection.OUTBOUND,
            status: MessageStatus.PENDING,
            senderType: MessageSenderType.SYSTEM,
            senderUserId: null,
            body: this.messageFor(conversation.tenantId, conversation.channel),
            createdAt,
          },
        });

        // Same monotonic rule as the ingress: never move lastMessageAt backwards.
        await tx.conversation.updateMany({
          where: {
            id: conversation.id,
            tenantId: conversation.tenantId,
            OR: [{ lastMessageAt: null }, { lastMessageAt: { lt: createdAt } }],
          },
          data: { lastMessageAt: createdAt },
        });

        await writeAudit(tx, {
          tenantId: conversation.tenantId,
          actorId: null,
          action: 'CONVERSATION_FIRST_CONTACT_REPLY',
          entity: 'Conversation',
          entityId: conversation.id,
          before: { state: ConversationState.AI_ATENDENDO },
          after: { state: ConversationState.AGUARDANDO_HUMANO, messageId: created.id, channel: conversation.channel },
        });
        return created;
      });

      return reply ? { reason: 'replied', message: reply } : { reason: 'not_eligible', message: null };
    } catch (error) {
      // Identifiers and the error NAME/code only: a Prisma message can quote the data being written.
      const failure = error as { name?: unknown; code?: unknown } | null;
      this.logger.error({
        event: 'first_contact.failed',
        tenantId: conversation.tenantId,
        conversationId: conversation.id,
        errorName: typeof failure?.name === 'string' ? failure.name : 'UnknownError',
        code: typeof failure?.code === 'string' ? failure.code : undefined,
      });
      return { reason: 'failed', message: null };
    }
  }

  /**
   * Text of the acknowledgement. One method on purpose: a per-tenant or
   * per-channel text would be resolved here (it needs storage, so it is not
   * part of this step).
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- parameters are the extension point for per-tenant/channel text
  messageFor(_tenantId: string, _channel: ConversationChannel): string {
    return this.config.firstContactMessage;
  }
}

function isPendingFirstContact(conversation: Conversation): boolean {
  return (
    conversation.state === ConversationState.AI_ATENDENDO &&
    conversation.assignedUserId === null &&
    FIRST_CONTACT_CHANNELS.includes(conversation.channel)
  );
}
