import { ConflictException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { ContactsService } from '../src/modules/contacts/contacts.service';
import { ConversationIngressInput, ConversationIngressService } from '../src/modules/conversations/conversation-ingress.service';
import { ConversationsService } from '../src/modules/conversations/conversations.service';
import { MessagesService } from '../src/modules/messages/messages.service';
import { PrismaService } from '../src/prisma/prisma.service';
import type { TenantContext } from '../src/common/tenant/tenant-context';
import { makeAppClient, makeOwnerClient, runWithTenant } from './rls.helper';

/**
 * ConversationIngressService against REAL Postgres (app role, RLS enforced).
 * The point is the concurrency guarantees, which an in-memory fake cannot
 * prove: the partial unique index conversations_open_per_contact_channel, the
 * (tenant, external_id) unique on messages, and the atomic lastMessageAt
 * update, exercised with Promise.all.
 */
describe('ConversationIngressService (integration, real Postgres)', () => {
  let appPrisma: PrismaClient;
  let ownerPrisma: PrismaClient;
  let ingress: ConversationIngressService;

  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const ctxA: TenantContext = { tenantId: tenantA, userId: randomUUID(), roleCodes: ['ADMIN'] };

  const at = (h: number, m: number) => new Date(Date.UTC(2024, 0, 1, h, m));

  const input = (over: Partial<ConversationIngressInput> = {}): ConversationIngressInput => ({
    tenantId: tenantA,
    channel: 'WHATSAPP',
    externalContactId: 'wa-1',
    externalMessageId: `m-${randomUUID()}`,
    content: 'Olá',
    occurredAt: at(10, 0),
    ...over,
  });

  const owner = <T = any>(tenantId: string, work: (tx: any) => Promise<T>): Promise<T> => runWithTenant(ownerPrisma, tenantId, work);

  async function counts(tenantId: string) {
    return owner(tenantId, async (tx) => ({
      contacts: await tx.contact.count({ where: { tenantId } }),
      identities: await tx.contactChannelIdentity.count({ where: { tenantId } }),
      conversations: await tx.conversation.count({ where: { tenantId } }),
      openConversations: await tx.conversation.count({ where: { tenantId, state: { not: 'ENCERRADA' } } }),
      messages: await tx.message.count({ where: { tenantId } }),
    }));
  }

  async function wipe(tenantId: string) {
    await owner(tenantId, async (tx) => {
      await tx.$executeRaw`DELETE FROM messages WHERE tenant_id = ${tenantId}::uuid`;
      await tx.$executeRaw`DELETE FROM conversations WHERE tenant_id = ${tenantId}::uuid`;
      await tx.$executeRaw`DELETE FROM contact_channel_identities WHERE tenant_id = ${tenantId}::uuid`;
      await tx.$executeRaw`DELETE FROM contacts WHERE tenant_id = ${tenantId}::uuid`;
    });
  }

  /** An ingress whose calls all wait, after resolving the Contact, until `parties` calls got there. */
  function withBarrierBeforePersist(parties: number): ConversationIngressService {
    const prisma = appPrisma as unknown as PrismaService;
    const contacts = new ContactsService(prisma);
    let arrived = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const gatedContacts = {
      findOrCreateByIdentity: async (i: any) => {
        const resolved = await contacts.findOrCreateByIdentity(i);
        if (++arrived === parties) release();
        await gate;
        return resolved;
      },
    } as unknown as ContactsService;
    return new ConversationIngressService(prisma, gatedContacts);
  }

  const closeAllConversations = (tenantId: string) =>
    owner(tenantId, (tx) => tx.$executeRaw`UPDATE conversations SET state = 'ENCERRADA' WHERE tenant_id = ${tenantId}::uuid`);

  const lastMessageAtOf = (tenantId: string, conversationId: string) =>
    owner(tenantId, async (tx) => (await tx.conversation.findUnique({ where: { id: conversationId } })).lastMessageAt);

  beforeAll(async () => {
    appPrisma = makeAppClient();
    ownerPrisma = makeOwnerClient();
    (appPrisma as any).runWithTenant = PrismaService.prototype.runWithTenant.bind(appPrisma);
    const prisma = appPrisma as unknown as PrismaService;
    ingress = new ConversationIngressService(prisma, new ContactsService(prisma));

    for (const [id, slug] of [
      [tenantA, 'ingress-int-a'],
      [tenantB, 'ingress-int-b'],
    ]) {
      await owner(id, async (tx) => {
        await tx.$executeRaw`INSERT INTO tenants (id,name,slug,timezone,created_at,updated_at) VALUES (${id}::uuid,${slug},${`${slug}-${id.slice(0, 8)}`},'America/Sao_Paulo',now(),now())`;
      });
    }
  });

  afterEach(async () => {
    await wipe(tenantA);
    await wipe(tenantB);
  });

  afterAll(async () => {
    for (const tenantId of [tenantA, tenantB]) {
      await wipe(tenantId);
      await owner(tenantId, async (tx) => {
        await tx.$executeRaw`DELETE FROM audit_logs WHERE tenant_id = ${tenantId}::uuid`;
        await tx.$executeRaw`DELETE FROM tenants WHERE id = ${tenantId}::uuid`;
      });
    }
    await appPrisma.$disconnect();
    await ownerPrisma.$disconnect();
  });

  describe('basic flow and Inbox visibility', () => {
    it('creates Contact -> Conversation -> Message and the existing Inbox API returns them', async () => {
      const result = await ingress.ingest(
        input({ externalMessageId: 'm-basic', content: 'Preciso de um orçamento', contact: { name: 'Ana', phone: '+5541999999999' } }),
      );

      expect(result).toMatchObject({
        contactCreated: true,
        identityCreated: true,
        conversationCreated: true,
        messageCreated: true,
        duplicate: false,
      });
      expect(result.conversation).toMatchObject({ state: 'AI_ATENDENDO', leadId: null, assignedUserId: null });
      expect(result.message).toMatchObject({ direction: 'INBOUND', status: 'DELIVERED', externalId: 'm-basic' });

      // Through the SAME services the Inbox endpoints use:
      const conversations = new ConversationsService(appPrisma as unknown as PrismaService);
      const messages = new MessagesService(appPrisma as unknown as PrismaService);
      const list = await conversations.list(ctxA, {} as any);
      const item = list.items.find((c) => c.id === result.conversation.id);
      expect(item).toMatchObject({
        contactName: 'Ana',
        contactPhone: '+5541999999999',
        channel: 'WHATSAPP',
        state: 'AI_ATENDENDO',
        lastMessageAt: at(10, 0).toISOString(),
      });
      const thread = await messages.list(ctxA, result.conversation.id, {} as any);
      expect(thread.items.map((m) => [m.body, m.direction, m.externalId])).toEqual([
        ['Preciso de um orçamento', 'INBOUND', 'm-basic'],
      ]);
    });

    it('a redelivery returns the original result and writes nothing', async () => {
      const first = await ingress.ingest(input({ externalMessageId: 'm-dup', content: 'original' }));
      const again = await ingress.ingest(input({ externalMessageId: 'm-dup', content: 'EDITADO', occurredAt: at(12, 0) }));

      expect(again.duplicate).toBe(true);
      expect(again.message.id).toBe(first.message.id);
      expect(again.message.body).toBe('original');
      expect(await lastMessageAtOf(tenantA, first.conversation.id)).toEqual(at(10, 0));
      expect(await counts(tenantA)).toMatchObject({ contacts: 1, conversations: 1, messages: 1 });
    });

    it('an externalMessageId already used by another channel is a 409, and nothing is written for it', async () => {
      await ingress.ingest(input({ channel: 'WHATSAPP', externalMessageId: 'shared-id' }));

      await expect(
        ingress.ingest(input({ channel: 'INSTAGRAM', externalContactId: 'ig-1', externalMessageId: 'shared-id' })),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(await counts(tenantA)).toMatchObject({ contacts: 1, identities: 1, conversations: 1, messages: 1 });
    });

    it('a failure inside the persist transaction rolls back the new Conversation (real Postgres)', async () => {
      // Postgres text cannot hold a NUL byte: message INSERT fails AFTER the
      // conversation INSERT succeeded inside the same transaction.
      await expect(ingress.ingest(input({ content: 'a\u0000b' }))).rejects.toThrow(/22021|invalid byte sequence/);

      const c = await counts(tenantA);
      expect(c.conversations).toBe(0);
      expect(c.messages).toBe(0);
      expect(c).toMatchObject({ contacts: 1, identities: 1 }); // committed by its own, idempotent step
    });
  });

  describe('CONCURRENT', () => {
    it('A) 8 simultaneous deliveries of the SAME event -> 1 Contact, 1 identity, 1 open Conversation, 1 Message', async () => {
      for (let round = 0; round < 5; round++) {
        const base = input({ externalContactId: `wa-A-${round}`, externalMessageId: `m-A-${round}` });

        const results = await Promise.all(Array.from({ length: 8 }, () => ingress.ingest(base)));

        expect(new Set(results.map((r) => r.message.id)).size).toBe(1);
        expect(new Set(results.map((r) => r.conversation.id)).size).toBe(1);
        expect(new Set(results.map((r) => r.contact.id)).size).toBe(1);
        // exactly one call actually created the message; the other seven are idempotent replays
        expect(results.filter((r) => r.messageCreated)).toHaveLength(1);
        expect(results.filter((r) => r.duplicate)).toHaveLength(7);
        expect(results.filter((r) => r.conversationCreated).length).toBeLessThanOrEqual(1);
      }
      expect(await counts(tenantA)).toEqual({
        contacts: 5,
        identities: 5,
        conversations: 5,
        openConversations: 5,
        messages: 5,
      });
    });

    it('A2) conversation already open + 8 simultaneous deliveries of the same event -> the (tenant, external_id) race, 1 Message', async () => {
      // With the conversation already there, the only thing the 8 calls fight
      // over is the message's unique key (the loser's INSERT raises P2002).
      const seed = await ingress.ingest(input({ externalContactId: 'wa-A2', externalMessageId: 'm-A2-seed', occurredAt: at(9, 0) }));
      const event = input({ externalContactId: 'wa-A2', externalMessageId: 'm-A2', content: 'evento', occurredAt: at(10, 0) });

      // Barrier between Contact resolution and the persist transaction: all 8
      // enter persist together instead of one finishing before the rest start.
      const gated = withBarrierBeforePersist(8);
      const results = await Promise.all(Array.from({ length: 8 }, () => gated.ingest(event)));

      expect(new Set(results.map((r) => r.message.id)).size).toBe(1);
      expect(results.every((r) => r.conversation.id === seed.conversation.id)).toBe(true);
      expect(results.filter((r) => r.messageCreated)).toHaveLength(1);
      expect(results.filter((r) => r.duplicate)).toHaveLength(7);
      expect(results.some((r) => r.conversationCreated)).toBe(false);
      expect(await counts(tenantA)).toMatchObject({ contacts: 1, conversations: 1, openConversations: 1, messages: 2 });
      expect(await lastMessageAtOf(tenantA, seed.conversation.id)).toEqual(at(10, 0));
    });

    it('B) 8 simultaneous DIFFERENT messages from the same Contact/channel -> 1 open Conversation, 8 Messages', async () => {
      for (let round = 0; round < 5; round++) {
        const results = await Promise.all(
          Array.from({ length: 8 }, (_, i) =>
            ingress.ingest(
              input({ externalContactId: `wa-B-${round}`, externalMessageId: `m-B-${round}-${i}`, occurredAt: at(10, i) }),
            ),
          ),
        );

        expect(new Set(results.map((r) => r.conversation.id)).size).toBe(1);
        expect(new Set(results.map((r) => r.contact.id)).size).toBe(1);
        expect(results.every((r) => r.messageCreated)).toBe(true);
        expect(results.filter((r) => r.conversationCreated)).toHaveLength(1);
        // last message wins regardless of the order the 8 transactions committed
        expect(await lastMessageAtOf(tenantA, results[0].conversation.id)).toEqual(at(10, 7));
      }
      expect(await counts(tenantA)).toEqual({
        contacts: 5,
        identities: 5,
        conversations: 5,
        openConversations: 5,
        messages: 40,
      });
    });

    it('C) existing ENCERRADA Conversation + 8 simultaneous new messages -> exactly 1 new open Conversation', async () => {
      const first = await ingress.ingest(input({ externalMessageId: 'm-C-old', occurredAt: at(9, 0) }));
      await closeAllConversations(tenantA);

      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) => ingress.ingest(input({ externalMessageId: `m-C-${i}`, occurredAt: at(11, i) }))),
      );

      const fresh = new Set(results.map((r) => r.conversation.id));
      expect(fresh.size).toBe(1);
      expect(fresh.has(first.conversation.id)).toBe(false);
      expect(results.filter((r) => r.conversationCreated)).toHaveLength(1);
      expect(await counts(tenantA)).toMatchObject({ conversations: 2, openConversations: 1, messages: 9, contacts: 1 });
      // the closed conversation was left exactly as it was
      const closed = await owner(tenantA, (tx) => tx.conversation.findUnique({ where: { id: first.conversation.id } }));
      expect(closed).toMatchObject({ state: 'ENCERRADA', lastMessageAt: at(9, 0) });
      expect(await owner(tenantA, (tx) => tx.message.count({ where: { conversationId: first.conversation.id } }))).toBe(1);
    });

    it('D) same externalMessageId in two tenants, concurrently -> each tenant keeps its own Message', async () => {
      const shared = { externalContactId: 'wa-D', externalMessageId: 'm-same-in-both-tenants' };

      const results = await Promise.all([
        ...Array.from({ length: 4 }, () => ingress.ingest(input({ ...shared, tenantId: tenantA, content: 'A' }))),
        ...Array.from({ length: 4 }, () => ingress.ingest(input({ ...shared, tenantId: tenantB, content: 'B' }))),
      ]);

      const inA = results.slice(0, 4);
      const inB = results.slice(4);
      expect(new Set(inA.map((r) => r.message.id)).size).toBe(1);
      expect(new Set(inB.map((r) => r.message.id)).size).toBe(1);
      expect(inA[0].message.id).not.toBe(inB[0].message.id);
      expect(inA.every((r) => r.message.tenantId === tenantA && r.message.body === 'A')).toBe(true);
      expect(inB.every((r) => r.message.tenantId === tenantB && r.message.body === 'B')).toBe(true);
      expect(inA.every((r) => r.conversation.tenantId === tenantA && r.contact.tenantId === tenantA)).toBe(true);
      expect(await counts(tenantA)).toMatchObject({ contacts: 1, conversations: 1, messages: 1 });
      expect(await counts(tenantB)).toMatchObject({ contacts: 1, conversations: 1, messages: 1 });
    });

    it('same Contact on two channels, concurrently -> one Conversation per channel', async () => {
      const results = await Promise.all(
        (['WHATSAPP', 'INSTAGRAM'] as const).flatMap((channel) =>
          Array.from({ length: 4 }, (_, i) =>
            ingress.ingest(
              input({
                channel,
                externalContactId: `${channel}-1`,
                externalMessageId: `m-${channel}-${i}`,
                contact: { phone: '+5511977776666' },
              }),
            ),
          ),
        ),
      );

      expect(new Set(results.map((r) => r.contact.id)).size).toBe(1); // matched by phone
      expect(await counts(tenantA)).toMatchObject({ contacts: 1, identities: 2, conversations: 2, openConversations: 2, messages: 8 });
    });
  });

  describe('lastMessageAt ordering (real Postgres)', () => {
    it('does not regress when an older message is processed after a newer one', async () => {
      const newer = await ingress.ingest(input({ externalMessageId: 'm-newer', occurredAt: at(10, 5) }));
      const older = await ingress.ingest(input({ externalMessageId: 'm-older', occurredAt: at(10, 0) }));

      expect(older.message.createdAt).toEqual(at(10, 0));
      expect(older.conversation.lastMessageAt).toEqual(at(10, 5));
      expect(await lastMessageAtOf(tenantA, newer.conversation.id)).toEqual(at(10, 5));
    });

    it('16 messages in shuffled order, concurrently -> lastMessageAt is the maximum', async () => {
      const minutes = [7, 3, 12, 0, 15, 9, 1, 14, 5, 11, 2, 13, 8, 4, 10, 6];
      const first = await ingress.ingest(input({ externalMessageId: 'm-seed', occurredAt: at(9, 0) })); // conversation exists

      await Promise.all(
        minutes.map((m) => ingress.ingest(input({ externalMessageId: `m-shuf-${m}`, occurredAt: at(10, m) }))),
      );

      expect(await lastMessageAtOf(tenantA, first.conversation.id)).toEqual(at(10, 15));
      expect(await counts(tenantA)).toMatchObject({ conversations: 1, messages: 17 });
    });

    it('a future occurredAt is clamped to the receipt time and cannot pin the conversation ahead', async () => {
      const result = await ingress.ingest(input({ occurredAt: new Date(Date.now() + 7 * 24 * 3600 * 1000) }));

      expect(result.message.createdAt.getTime()).toBeLessThanOrEqual(Date.now());
      expect(result.conversation.lastMessageAt).toEqual(result.message.createdAt);
    });
  });

  describe('externalConversationId (real Postgres)', () => {
    it('anchors a new conversation; concurrent messages of that thread share one conversation', async () => {
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          ingress.ingest(
            input({
              channel: 'WEBCHAT',
              externalContactId: 'visitor-1',
              externalConversationId: 'session-1',
              externalMessageId: `m-web-${i}`,
            }),
          ),
        ),
      );

      expect(new Set(results.map((r) => r.conversation.id)).size).toBe(1);
      expect(results[0].conversation.externalConversationId).toBe('session-1');
      expect(await counts(tenantA)).toMatchObject({ conversations: 1, messages: 8 });
    });

    it('a thread id owned by ANOTHER Contact is a 409 and nothing is reassigned', async () => {
      const owned = await ingress.ingest(
        input({ channel: 'WEBCHAT', externalContactId: 'visitor-1', externalConversationId: 'session-1', externalMessageId: 'm-1' }),
      );

      await expect(
        ingress.ingest(
          input({ channel: 'WEBCHAT', externalContactId: 'visitor-2', externalConversationId: 'session-1', externalMessageId: 'm-2' }),
        ),
      ).rejects.toBeInstanceOf(ConflictException);

      const row: any = await owner(tenantA, (tx) => tx.conversation.findUnique({ where: { id: owned.conversation.id } }));
      expect(row.contactId).toBe(owned.contact.id);
      expect(await counts(tenantA)).toMatchObject({ conversations: 1, messages: 1 });
    });

    it('the same thread id in another tenant is independent', async () => {
      const a = await ingress.ingest(
        input({ tenantId: tenantA, channel: 'WEBCHAT', externalConversationId: 'session-1', externalMessageId: 'm-a' }),
      );
      const b = await ingress.ingest(
        input({ tenantId: tenantB, channel: 'WEBCHAT', externalConversationId: 'session-1', externalMessageId: 'm-b' }),
      );

      expect(a.conversation.id).not.toBe(b.conversation.id);
      expect(a.conversation.externalConversationId).toBe('session-1');
      expect(b.conversation.externalConversationId).toBe('session-1');
    });

    it('F+G) after the anchored conversation is closed, the new message opens a NEW conversation WITH the same thread id, which is then reused', async () => {
      const args = { channel: 'WEBCHAT', externalContactId: 'visitor-1', externalConversationId: 'thread-123' } as const;
      const first = await ingress.ingest(input({ ...args, externalMessageId: 'm-1' }));
      await closeAllConversations(tenantA);

      const second = await ingress.ingest(input({ ...args, externalMessageId: 'm-2' }));
      const third = await ingress.ingest(input({ ...args, externalMessageId: 'm-3' }));

      expect(second.conversationCreated).toBe(true);
      expect(second.conversation.id).not.toBe(first.conversation.id);
      expect(second.conversation.externalConversationId).toBe('thread-123'); // no longer lost after closing
      expect(third.conversationCreated).toBe(false);
      expect(third.conversation.id).toBe(second.conversation.id);
      expect(await counts(tenantA)).toMatchObject({ conversations: 2, openConversations: 1, messages: 3 });
      // the closed conversation keeps its own history and its own copy of the id
      const closed: any = await owner(tenantA, (tx) => tx.conversation.findUnique({ where: { id: first.conversation.id } }));
      expect(closed).toMatchObject({ state: 'ENCERRADA', externalConversationId: 'thread-123' });
    });

    it('H) a thread id held by an OPEN conversation of another Contact stays a 409, nothing reassigned', async () => {
      const owned = await ingress.ingest(
        input({ channel: 'WEBCHAT', externalContactId: 'visitor-1', externalConversationId: 'thread-123', externalMessageId: 'm-1' }),
      );

      await expect(
        ingress.ingest(
          input({ channel: 'WEBCHAT', externalContactId: 'visitor-2', externalConversationId: 'thread-123', externalMessageId: 'm-2' }),
        ),
      ).rejects.toBeInstanceOf(ConflictException);

      const row: any = await owner(tenantA, (tx) => tx.conversation.findUnique({ where: { id: owned.conversation.id } }));
      expect(row).toMatchObject({ contactId: owned.contact.id, externalConversationId: 'thread-123' });
      expect(await counts(tenantA)).toMatchObject({ conversations: 1, messages: 1 });
    });

    it('a thread id that only a CLOSED conversation of another Contact holds does not block a new Contact', async () => {
      await ingress.ingest(
        input({ channel: 'WEBCHAT', externalContactId: 'visitor-1', externalConversationId: 'thread-123', externalMessageId: 'm-1' }),
      );
      await closeAllConversations(tenantA);

      const other = await ingress.ingest(
        input({ channel: 'WEBCHAT', externalContactId: 'visitor-2', externalConversationId: 'thread-123', externalMessageId: 'm-2' }),
      );

      expect(other.conversationCreated).toBe(true);
      expect(other.conversation.externalConversationId).toBe('thread-123');
      expect(await counts(tenantA)).toMatchObject({ conversations: 2, openConversations: 1 });
    });

    it('an open conversation without an anchor receives the thread id; a different one later does not overwrite it', async () => {
      const first = await ingress.ingest(
        input({ channel: 'WEBCHAT', externalContactId: 'visitor-1', externalMessageId: 'm-1' }), // no thread id
      );
      expect(first.conversation.externalConversationId).toBeNull();

      const anchored = await ingress.ingest(
        input({ channel: 'WEBCHAT', externalContactId: 'visitor-1', externalConversationId: 'thread-123', externalMessageId: 'm-2' }),
      );
      expect(anchored.conversation.id).toBe(first.conversation.id);
      expect(anchored.conversation.externalConversationId).toBe('thread-123');

      const other = await ingress.ingest(
        input({ channel: 'WEBCHAT', externalContactId: 'visitor-1', externalConversationId: 'thread-999', externalMessageId: 'm-3' }),
      );
      expect(other.conversation.id).toBe(first.conversation.id);
      expect(other.conversation.externalConversationId).toBe('thread-123');
      expect(await counts(tenantA)).toMatchObject({ conversations: 1, messages: 3 });
    });

    it('concurrent anchoring of one unanchored conversation from 8 messages converges on a single anchor', async () => {
      const seed = await ingress.ingest(
        input({ channel: 'WEBCHAT', externalContactId: 'visitor-1', externalMessageId: 'm-seed', occurredAt: at(9, 0) }),
      );

      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          ingress.ingest(
            input({ channel: 'WEBCHAT', externalContactId: 'visitor-1', externalConversationId: 'thread-123', externalMessageId: `m-${i}` }),
          ),
        ),
      );

      expect(results.every((r) => r.conversation.id === seed.conversation.id)).toBe(true);
      const row: any = await owner(tenantA, (tx) => tx.conversation.findUnique({ where: { id: seed.conversation.id } }));
      expect(row.externalConversationId).toBe('thread-123');
      expect(await counts(tenantA)).toMatchObject({ conversations: 1, messages: 9 });
    });

    it('I) closed anchored conversation + 8 simultaneous messages of the same thread -> exactly 1 new open conversation, anchor preserved', async () => {
      const args = { channel: 'WEBCHAT', externalContactId: 'visitor-1', externalConversationId: 'thread-123' } as const;
      const old = await ingress.ingest(input({ ...args, externalMessageId: 'm-old', occurredAt: at(9, 0) }));
      await closeAllConversations(tenantA);

      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) => ingress.ingest(input({ ...args, externalMessageId: `m-I-${i}`, occurredAt: at(11, i) }))),
      );

      const ids = new Set(results.map((r) => r.conversation.id));
      expect(ids.size).toBe(1);
      expect(ids.has(old.conversation.id)).toBe(false);
      expect(results.filter((r) => r.conversationCreated)).toHaveLength(1);
      expect(results.every((r) => r.conversation.externalConversationId === 'thread-123')).toBe(true);
      expect(await counts(tenantA)).toMatchObject({ conversations: 2, openConversations: 1, messages: 9 });
      const fresh: any = await owner(tenantA, (tx) => tx.conversation.findUnique({ where: { id: results[0].conversation.id } }));
      expect(fresh).toMatchObject({ externalConversationId: 'thread-123', state: 'AI_ATENDENDO', lastMessageAt: at(11, 7) });
    });

    it('two different Contacts racing for the SAME new thread id: exactly one wins, the other gets a 409', async () => {
      const settled = await Promise.allSettled(
        ['visitor-1', 'visitor-2'].flatMap((externalContactId) =>
          Array.from({ length: 4 }, (_, i) =>
            ingress.ingest(
              input({ channel: 'WEBCHAT', externalContactId, externalConversationId: 'thread-123', externalMessageId: `m-${externalContactId}-${i}` }),
            ),
          ),
        ),
      );

      const ok = settled.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<any>[];
      const failed = settled.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
      expect(new Set(ok.map((r) => r.value.contact.id)).size).toBe(1); // one owner only
      expect(failed).toHaveLength(4);
      expect(failed.every((r) => r.reason instanceof ConflictException)).toBe(true);
      expect(await counts(tenantA)).toMatchObject({ openConversations: 1 });
    });
  });
});
