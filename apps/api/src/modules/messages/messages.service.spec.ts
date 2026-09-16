import { ConflictException, NotFoundException } from '@nestjs/common';
import { ConversationState, MessageDirection, MessageSenderType, MessageStatus } from '@prisma/client';
import type { TenantContext } from '../../common/tenant/tenant-context';
import { MessagesService } from './messages.service';

/**
 * Unit tests for MessagesService with an in-memory fake of the tenant
 * transaction — same approach as followups/conversations service specs.
 * RLS/cross-tenant isolation is exercised by the integration suite; here we
 * validate: message creation attribution, the ENCERRADA guard, and cursor
 * pagination/ordering, plus that Conversation.lastMessageAt is kept in sync.
 */
describe('MessagesService', () => {
  const CTX: TenantContext = { tenantId: 'tenant-a', userId: 'atendente-a', roleCodes: ['ATENDENTE'] };

  let conversations: Map<string, any>;
  let messages: Map<string, any>;
  let idSeq: number;

  function attachSender(row: any) {
    return { ...row, senderUser: row.senderUserId ? { id: row.senderUserId, name: 'Atendente A' } : null };
  }

  function makeTx() {
    return {
      conversation: {
        findUnique: jest.fn(async ({ where }: any) => conversations.get(where.id) ?? null),
        update: jest.fn(async ({ where, data }: any) => {
          const row = { ...conversations.get(where.id), ...data };
          conversations.set(where.id, row);
          return row;
        }),
      },
      message: {
        create: jest.fn(async ({ data }: any) => {
          idSeq += 1;
          const row = { id: `msg-${idSeq}`, externalId: null, ...data };
          messages.set(row.id, row);
          return attachSender(row);
        }),
        findMany: jest.fn(async ({ where, orderBy, take, cursor, skip }: any) => {
          let rows = [...messages.values()].filter(
            (m) => m.tenantId === where.tenantId && m.conversationId === where.conversationId,
          );
          rows.sort((a, b) =>
            orderBy.createdAt === 'desc' ? b.createdAt.getTime() - a.createdAt.getTime() : a.createdAt.getTime() - b.createdAt.getTime(),
          );
          if (cursor) {
            const idx = rows.findIndex((r) => r.id === cursor.id);
            if (idx === -1) throw new Error('cursor not found');
            rows = rows.slice(idx + (skip ?? 0));
          }
          return rows.slice(0, take).map(attachSender);
        }),
      },
    };
  }

  let tx: ReturnType<typeof makeTx>;
  let prisma: any;
  let service: MessagesService;

  beforeEach(() => {
    conversations = new Map([
      [
        'conv-1',
        {
          id: 'conv-1',
          tenantId: 'tenant-a',
          state: ConversationState.AGUARDANDO_HUMANO,
          lastMessageAt: null,
        },
      ],
    ]);
    messages = new Map();
    idSeq = 0;
    tx = makeTx();
    prisma = { runWithTenant: jest.fn(async (_t: string, work: any) => work(tx)) };
    service = new MessagesService(prisma);
  });

  describe('send', () => {
    it('creates an OUTBOUND/AGENT message attributed to the caller and marks it SENT', async () => {
      const message = await service.send(CTX, 'conv-1', { body: 'Olá!' } as any);
      expect(message.direction).toBe(MessageDirection.OUTBOUND);
      expect(message.senderType).toBe(MessageSenderType.AGENT);
      expect(message.senderUserId).toBe('atendente-a');
      expect(message.status).toBe(MessageStatus.SENT);
      expect(message.body).toBe('Olá!');
    });

    it('updates Conversation.lastMessageAt to the message timestamp', async () => {
      expect(conversations.get('conv-1').lastMessageAt).toBeNull();
      const message = await service.send(CTX, 'conv-1', { body: 'Olá!' } as any);
      expect(conversations.get('conv-1').lastMessageAt.toISOString()).toBe(message.createdAt);
    });

    it('returns 404 for a missing/cross-tenant conversation', async () => {
      await expect(service.send(CTX, 'nope', { body: 'x' } as any)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects sending to a closed (ENCERRADA) conversation with 409', async () => {
      conversations.set('conv-1', { ...conversations.get('conv-1'), state: ConversationState.ENCERRADA });
      await expect(service.send(CTX, 'conv-1', { body: 'x' } as any)).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('list', () => {
    // Forces strictly increasing createdAt values — real Date.now() has only
    // millisecond resolution and a tight in-memory loop can collide, which
    // would make the ordering assertions below flaky.
    async function seedMessages(count: number) {
      const base = Date.now();
      for (let i = 0; i < count; i++) {
        const sent = await service.send(CTX, 'conv-1', { body: `msg-${i}` } as any);
        messages.get(sent.id)!.createdAt = new Date(base + i * 1000);
      }
    }

    it('returns messages in chronological order (oldest first)', async () => {
      await seedMessages(3);
      const result = await service.list(CTX, 'conv-1', {} as any);
      expect(result.items.map((m) => m.body)).toEqual(['msg-0', 'msg-1', 'msg-2']);
    });

    it('paginates with a cursor, reporting hasMore/nextCursor', async () => {
      await seedMessages(5);
      const firstPage = await service.list(CTX, 'conv-1', { limit: 2 } as any);
      expect(firstPage.items.map((m) => m.body)).toEqual(['msg-3', 'msg-4']);
      expect(firstPage.hasMore).toBe(true);
      expect(firstPage.nextCursor).not.toBeNull();

      const secondPage = await service.list(CTX, 'conv-1', { limit: 2, before: firstPage.nextCursor! } as any);
      expect(secondPage.items.map((m) => m.body)).toEqual(['msg-1', 'msg-2']);
    });

    it('returns 404 for a missing/cross-tenant conversation', async () => {
      await expect(service.list(CTX, 'nope', {} as any)).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
