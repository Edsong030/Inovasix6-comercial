import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  ConversationState,
  MessageDirection,
  MessageSenderType,
  MessageStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService, TenantTx } from '../../prisma/prisma.service';
import type { TenantContext } from '../../common/tenant/tenant-context';
import { CreateMessageDto } from './dto/create-message.dto';
import { ListMessagesQueryDto } from './dto/list-messages.dto';

export interface MessageItem {
  id: string;
  conversationId: string;
  direction: MessageDirection;
  status: MessageStatus;
  senderType: MessageSenderType;
  senderUserId: string | null;
  senderUserName: string | null;
  body: string | null;
  externalId: string | null;
  createdAt: string;
}

export interface MessageListResult {
  /** Chronological order (oldest first) — ready to render top-to-bottom. */
  items: MessageItem[];
  /** Pass as `before` to load the next (older) page. Null when there is none. */
  nextCursor: string | null;
  hasMore: boolean;
}

const MESSAGE_INCLUDE = {
  senderUser: true,
} satisfies Prisma.MessageInclude;

type MessageWithRelations = Prisma.MessageGetPayload<{ include: typeof MESSAGE_INCLUDE }>;

@Injectable()
export class MessagesService {
  constructor(private readonly prisma: PrismaService) {}

  /** Newest-first from the DB, reversed to chronological order for the client. */
  async list(ctx: TenantContext, conversationId: string, query: ListMessagesQueryDto): Promise<MessageListResult> {
    const limit = query.limit ?? 50;

    return this.prisma.runWithTenant(ctx.tenantId, async (tx) => {
      await this.assertConversationInTenant(tx, conversationId);

      let rows: MessageWithRelations[];
      try {
        rows = await tx.message.findMany({
          where: { tenantId: ctx.tenantId, conversationId },
          include: MESSAGE_INCLUDE,
          orderBy: { createdAt: 'desc' },
          take: limit + 1,
          ...(query.before ? { cursor: { id: query.before }, skip: 1 } : {}),
        });
      } catch {
        throw new BadRequestException('Cursor de paginação inválido.');
      }

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const nextCursor = hasMore ? page[page.length - 1].id : null;

      return { items: page.slice().reverse().map(toMessageItem), nextCursor, hasMore };
    });
  }

  /**
   * Sends a manual message as the authenticated agent (OUTBOUND/AGENT) and
   * keeps Conversation.lastMessageAt consistent in the SAME transaction, so
   * the two never drift apart.
   */
  async send(ctx: TenantContext, conversationId: string, dto: CreateMessageDto): Promise<MessageItem> {
    return this.prisma.runWithTenant(ctx.tenantId, async (tx) => {
      const conversation = await this.assertConversationInTenant(tx, conversationId);
      if (conversation.state === ConversationState.ENCERRADA) {
        throw new ConflictException('Não é possível enviar mensagem em uma conversa encerrada. Reabra antes de responder.');
      }

      const now = new Date();
      const message = await tx.message.create({
        data: {
          tenantId: ctx.tenantId,
          conversationId,
          direction: MessageDirection.OUTBOUND,
          senderType: MessageSenderType.AGENT,
          senderUserId: ctx.userId,
          // No provider round-trip for a manual/local message — it is
          // considered SENT the instant it is written, not PENDING.
          status: MessageStatus.SENT,
          body: dto.body,
          createdAt: now,
        },
        include: MESSAGE_INCLUDE,
      });

      await tx.conversation.update({
        where: { id: conversationId },
        data: { lastMessageAt: now },
      });

      return toMessageItem(message);
    });
  }

  // -- helpers ---------------------------------------------------------------

  private async assertConversationInTenant(tx: TenantTx, conversationId: string) {
    const conversation = await tx.conversation.findUnique({ where: { id: conversationId } });
    if (!conversation) throw new NotFoundException();
    return conversation;
  }
}

function toMessageItem(message: MessageWithRelations): MessageItem {
  return {
    id: message.id,
    conversationId: message.conversationId,
    direction: message.direction,
    status: message.status,
    senderType: message.senderType,
    senderUserId: message.senderUserId,
    senderUserName: message.senderUser?.name ?? null,
    body: message.body,
    externalId: message.externalId,
    createdAt: message.createdAt.toISOString(),
  };
}
