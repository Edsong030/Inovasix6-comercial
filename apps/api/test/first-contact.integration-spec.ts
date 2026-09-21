import { Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type { TenantContext } from '../src/common/tenant/tenant-context';
import type { AppConfigService } from '../src/config/app-config.service';
import { DEFAULT_FIRST_CONTACT_MESSAGE } from '../src/config/first-contact';
import { ContactsService } from '../src/modules/contacts/contacts.service';
import { ConversationIngressInput, ConversationIngressService } from '../src/modules/conversations/conversation-ingress.service';
import { ConversationIntakeService } from '../src/modules/conversations/conversation-intake.service';
import { ConversationsService } from '../src/modules/conversations/conversations.service';
import { FirstContactService } from '../src/modules/conversations/first-contact/first-contact.service';
import { MessagesService } from '../src/modules/messages/messages.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { makeAppClient, makeOwnerClient, runWithTenant } from './rls.helper';

/**
 * First contact -> automatic reply -> human handoff against REAL Postgres (app
 * role, RLS enforced). The guarantee under test is the database claim
 * (UPDATE ... WHERE state = 'AI_ATENDENDO' AND assigned_user_id IS NULL): at
 * most one automatic reply per conversation, and a person who took the
 * conversation always wins.
 */
describe('first contact reply (integration, real Postgres)', () => {
  let appPrisma: PrismaClient;
  let ownerPrisma: PrismaClient;
  let ingress: ConversationIngressService;
  let firstContact: FirstContactService;
  let intake: ConversationIntakeService;
  let conversations: ConversationsService;

  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const userA = randomUUID();
  const ctxA: TenantContext = { tenantId: tenantA, userId: userA, roleCodes: ['ADMIN'] };
  const at = (h: number, m: number) => new Date(Date.UTC(2024, 0, 1, h, m));

  const input = (over: Partial<ConversationIngressInput> = {}): ConversationIngressInput => ({
    tenantId: tenantA,
    channel: 'WHATSAPP',
    externalContactId: 'wa-1',
    externalMessageId: `m-${randomUUID()}`,
    content: 'Oi',
    occurredAt: at(10, 0),
    ...over,
  });

  const owner = <T = any>(tenantId: string, work: (tx: any) => Promise<T>): Promise<T> => runWithTenant(ownerPrisma, tenantId, work);

  const messagesOf = (tenantId: string, where: object = {}) =>
    owner<any[]>(tenantId, (tx) => tx.message.findMany({ where: { tenantId, ...where }, orderBy: { createdAt: 'asc' } }));
  /** The structural marker of an automatic reply. */
  const autoReplies = (tenantId: string, where: object = {}) =>
    messagesOf(tenantId, { direction: 'OUTBOUND', senderType: 'SYSTEM', senderUserId: null, ...where });
  const conversationRow = (tenantId: string, id: string) =>
    owner<any>(tenantId, (tx) => tx.conversation.findUnique({ where: { id } }));

  async function wipe(tenantId: string) {
    await owner(tenantId, async (tx) => {
      await tx.$executeRaw`DELETE FROM audit_logs WHERE tenant_id = ${tenantId}::uuid`;
      await tx.$executeRaw`DELETE FROM messages WHERE tenant_id = ${tenantId}::uuid`;
      await tx.$executeRaw`DELETE FROM conversations WHERE tenant_id = ${tenantId}::uuid`;
      await tx.$executeRaw`DELETE FROM contact_channel_identities WHERE tenant_id = ${tenantId}::uuid`;
      await tx.$executeRaw`DELETE FROM contacts WHERE tenant_id = ${tenantId}::uuid`;
    });
  }

  /**
   * Intake whose calls wait, after their inbound message is committed and before
   * any of them tries the automatic reply, until `parties` calls got there: every
   * caller then contends for the claim at the same moment.
   */
  function withBarrier(parties: number): ConversationIntakeService {
    let arrived = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const gatedIngress = {
      ingest: async (i: ConversationIngressInput) => {
        const result = await ingress.ingest(i);
        if (++arrived === parties) release();
        await gate;
        return result;
      },
    } as unknown as ConversationIngressService;
    return new ConversationIntakeService(gatedIngress, firstContact);
  }

  beforeAll(async () => {
    appPrisma = makeAppClient();
    ownerPrisma = makeOwnerClient();
    (appPrisma as any).runWithTenant = PrismaService.prototype.runWithTenant.bind(appPrisma);
    const prisma = appPrisma as unknown as PrismaService;
    ingress = new ConversationIngressService(prisma, new ContactsService(prisma));
    firstContact = new FirstContactService(prisma, { firstContactMessage: DEFAULT_FIRST_CONTACT_MESSAGE } as AppConfigService);
    intake = new ConversationIntakeService(ingress, firstContact);
    conversations = new ConversationsService(prisma);

    for (const [id, slug] of [
      [tenantA, 'first-contact-int-a'],
      [tenantB, 'first-contact-int-b'],
    ]) {
      await owner(id, async (tx) => {
        await tx.$executeRaw`INSERT INTO tenants (id,name,slug,timezone,created_at,updated_at) VALUES (${id}::uuid,${slug},${`${slug}-${id.slice(0, 8)}`},'America/Sao_Paulo',now(),now())`;
      });
    }
    await owner(tenantA, async (tx) => {
      await tx.$executeRaw`INSERT INTO users (id,tenant_id,email,name,password_hash,status,created_at,updated_at) VALUES (${userA}::uuid,${tenantA}::uuid,'agent@first-contact-int.test','Agente','x','ACTIVE',now(),now())`;
    });
  });

  afterEach(async () => {
    await wipe(tenantA);
    await wipe(tenantB);
  });

  afterAll(async () => {
    for (const tenantId of [tenantA, tenantB]) {
      await wipe(tenantId);
      await owner(tenantId, async (tx) => {
        await tx.$executeRaw`DELETE FROM users WHERE tenant_id = ${tenantId}::uuid`;
        await tx.$executeRaw`DELETE FROM tenants WHERE id = ${tenantId}::uuid`;
      });
    }
    await appPrisma.$disconnect();
    await ownerPrisma.$disconnect();
  });

  describe('the flow', () => {
    it('first message -> inbound + ONE automatic reply (OUTBOUND, PENDING, SYSTEM) -> AGUARDANDO_HUMANO, unassigned', async () => {
      const result = await intake.receive(input({ content: 'Oi' }));

      expect(result.autoReply.reason).toBe('replied');
      const thread = await messagesOf(tenantA);
      expect(thread.map((m) => [m.direction, m.status, m.senderType])).toEqual([
        ['INBOUND', 'DELIVERED', 'CUSTOMER'],
        ['OUTBOUND', 'PENDING', 'SYSTEM'],
      ]);
      expect(thread[1]).toMatchObject({ senderUserId: null, externalId: null, body: DEFAULT_FIRST_CONTACT_MESSAGE, conversationId: result.conversation.id });
      expect(thread[1].createdAt.getTime()).toBeGreaterThan(thread[0].createdAt.getTime());
      const row = await conversationRow(tenantA, result.conversation.id);
      expect(row).toMatchObject({ state: 'AGUARDANDO_HUMANO', assignedUserId: null, lastMessageAt: thread[1].createdAt });
      const audit = await owner<any[]>(tenantA, (tx) => tx.auditLog.findMany({ where: { tenantId: tenantA, action: 'CONVERSATION_FIRST_CONTACT_REPLY' } }));
      expect(audit).toHaveLength(1);
      expect(audit[0].actorId).toBeNull();
    });

    it('Oi / Oi? / Tem alguém? / Preciso falar: four inbound stored, one automatic reply', async () => {
      for (const content of ['Oi', 'Oi?', 'Tem alguém?', 'Preciso falar com vocês']) await intake.receive(input({ content }));

      expect(await autoReplies(tenantA)).toHaveLength(1);
      expect((await messagesOf(tenantA, { direction: 'INBOUND' })).length).toBe(4);
    });

    it('a redelivery has no effect (no second reply, nothing written)', async () => {
      const event = input({ externalMessageId: 'wamid-1' });
      await intake.receive(event);
      const before = await messagesOf(tenantA);

      const again = await intake.receive({ ...event, content: 'EDITADO' });

      expect(again.duplicate).toBe(true);
      expect(again.autoReply.reason).toBe('duplicate');
      expect((await messagesOf(tenantA)).length).toBe(before.length);
    });

    it('MANUAL conversations are never auto-replied', async () => {
      const result = await intake.receive(input({ channel: 'MANUAL' }));

      expect(result.autoReply.reason).toBe('not_eligible');
      expect(await autoReplies(tenantA)).toHaveLength(0);
      expect((await conversationRow(tenantA, result.conversation.id)).state).toBe('AI_ATENDENDO');
    });

    it.each(['WHATSAPP', 'INSTAGRAM', 'FACEBOOK', 'WEBCHAT'] as const)('replies on %s', async (channel) => {
      const result = await intake.receive(input({ channel }));

      expect(result.autoReply.reason).toBe('replied');
    });

    it('an agent\'s message written through the existing send API is not an automatic reply, and does not disturb it', async () => {
      const first = await intake.receive(input());
      await new MessagesService(appPrisma as unknown as PrismaService).send(ctxA, first.conversation.id, { body: 'Oi! Aqui é a Ana.' });

      const outbound = await messagesOf(tenantA, { direction: 'OUTBOUND' });
      expect(outbound.map((m) => [m.senderType, m.status])).toEqual([
        ['SYSTEM', 'PENDING'],
        ['AGENT', 'SENT'],
      ]);
      expect(await autoReplies(tenantA)).toHaveLength(1);
    });

    it('the existing Inbox API sees the conversation and the thread in order', async () => {
      const first = await intake.receive(input({ content: 'Preciso de ajuda', contact: { name: 'Ana' } }));

      const list = await conversations.list(ctxA, {} as any);
      expect(list.items.find((c) => c.id === first.conversation.id)).toMatchObject({ contactName: 'Ana', state: 'AGUARDANDO_HUMANO', assignedUserId: null });
      const thread = await new MessagesService(appPrisma as unknown as PrismaService).list(ctxA, first.conversation.id, {} as any);
      expect(thread.items.map((m) => [m.direction, m.senderType, m.status])).toEqual([
        ['INBOUND', 'CUSTOMER', 'DELIVERED'],
        ['OUTBOUND', 'SYSTEM', 'PENDING'],
      ]);
    });
  });

  describe('CONCURRENT: at most one automatic reply per conversation', () => {
    it('A) 2 different simultaneous inbound messages -> 2 inbound, exactly 1 automatic reply ', async () => {
      for (let round = 0; round < 10; round++) {
        const contact = `wa-A-${round}`;
        const gated = withBarrier(2);
        const results = await Promise.all([0, 1].map((i) => gated.receive(input({ externalContactId: contact, externalMessageId: `m-A-${round}-${i}` }))));

        expect(results.filter((r) => r.autoReply.reason === 'replied')).toHaveLength(1);
        const conversationId = results[0].conversation.id;
        expect(results[1].conversation.id).toBe(conversationId);
        expect(await messagesOf(tenantA, { conversationId, direction: 'INBOUND' })).toHaveLength(2);
        expect(await autoReplies(tenantA, { conversationId })).toHaveLength(1);
        expect((await conversationRow(tenantA, conversationId)).state).toBe('AGUARDANDO_HUMANO');
      }
    });

    it('B) 8 simultaneous inbound messages -> all stored, exactly 1 automatic reply', async () => {
      for (let round = 0; round < 5; round++) {
        const contact = `wa-B-${round}`;
        const gated = withBarrier(8);

        const results = await Promise.all(
          Array.from({ length: 8 }, (_, i) => gated.receive(input({ externalContactId: contact, externalMessageId: `m-B-${round}-${i}`, occurredAt: at(10, i) }))),
        );

        const conversationId = results[0].conversation.id;
        expect(new Set(results.map((r) => r.conversation.id)).size).toBe(1);
        expect(results.every((r) => r.messageCreated)).toBe(true);
        expect(results.filter((r) => r.autoReply.reason === 'replied')).toHaveLength(1);
        expect(results.filter((r) => r.autoReply.reason === 'not_eligible')).toHaveLength(7);
        expect(await messagesOf(tenantA, { conversationId, direction: 'INBOUND' })).toHaveLength(8);
        expect(await autoReplies(tenantA, { conversationId })).toHaveLength(1);
      }
      expect(await owner(tenantA, (tx) => tx.message.count({ where: { tenantId: tenantA } }))).toBe(5 * 9);
    });

    it('C) 8 redeliveries of the SAME externalMessageId -> 1 inbound, exactly 1 automatic reply', async () => {
      for (let round = 0; round < 5; round++) {
        const event = input({ externalContactId: `wa-C-${round}`, externalMessageId: `m-C-${round}` });
        const gated = withBarrier(8);

        const results = await Promise.all(Array.from({ length: 8 }, () => gated.receive(event)));

        const conversationId = results[0].conversation.id;
        expect(results.filter((r) => r.messageCreated)).toHaveLength(1);
        expect(results.filter((r) => r.autoReply.reason === 'replied')).toHaveLength(1);
        expect(results.filter((r) => r.autoReply.reason === 'duplicate')).toHaveLength(7);
        expect(await messagesOf(tenantA, { conversationId, direction: 'INBOUND' })).toHaveLength(1);
        expect(await autoReplies(tenantA, { conversationId })).toHaveLength(1);
      }
    });

    it('B2) without any barrier (the natural interleaving) the guarantee holds too', async () => {
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) => intake.receive(input({ externalContactId: 'wa-B2', externalMessageId: `m-B2-${i}` }))),
      );

      expect(new Set(results.map((r) => r.conversation.id)).size).toBe(1);
      expect(await autoReplies(tenantA)).toHaveLength(1);
      expect(await messagesOf(tenantA, { direction: 'INBOUND' })).toHaveLength(8);
    });

    it('E) a closed conversation gets nothing; 8 simultaneous new messages open ONE new conversation with exactly one reply', async () => {
      const first = await intake.receive(input({ externalMessageId: 'm-E-old', occurredAt: at(9, 0) }));
      await owner(tenantA, (tx) => tx.$executeRaw`UPDATE conversations SET state = 'ENCERRADA' WHERE id = ${first.conversation.id}::uuid`);
      const gated = withBarrier(8);

      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) => gated.receive(input({ externalMessageId: `m-E-${i}`, occurredAt: at(11, i) }))),
      );

      const fresh = results[0].conversation.id;
      expect(fresh).not.toBe(first.conversation.id);
      expect(new Set(results.map((r) => r.conversation.id)).size).toBe(1);
      expect(results.filter((r) => r.autoReply.reason === 'replied')).toHaveLength(1);
      expect(await autoReplies(tenantA, { conversationId: fresh })).toHaveLength(1);
      // the old one: still closed, and still with only its own original reply
      expect((await conversationRow(tenantA, first.conversation.id)).state).toBe('ENCERRADA');
      expect(await autoReplies(tenantA, { conversationId: first.conversation.id })).toHaveLength(1);
      expect(await messagesOf(tenantA, { conversationId: first.conversation.id })).toHaveLength(2);
    });

    it('E2) the rule is per conversation, not per Contact: a later conversation of the same Contact is acknowledged again', async () => {
      const first = await intake.receive(input({ externalMessageId: 'm-1' }));
      await owner(tenantA, (tx) => tx.$executeRaw`UPDATE conversations SET state = 'ENCERRADA' WHERE id = ${first.conversation.id}::uuid`);

      const second = await intake.receive(input({ externalMessageId: 'm-2' }));

      expect(second.contact.id).toBe(first.contact.id);
      expect(second.autoReply.reason).toBe('replied');
      expect(await autoReplies(tenantA)).toHaveLength(2);
    });

    it('tenants are independent: the same event in two tenants gets one reply each, in its own tenant', async () => {
      const gated = withBarrier(4);
      const results = await Promise.all([
        gated.receive(input({ tenantId: tenantA, externalMessageId: 'same-id' })),
        gated.receive(input({ tenantId: tenantA, externalMessageId: 'same-id-2' })),
        gated.receive(input({ tenantId: tenantB, externalMessageId: 'same-id' })),
        gated.receive(input({ tenantId: tenantB, externalMessageId: 'same-id-2' })),
      ]);

      expect(results.filter((r) => r.autoReply.reason === 'replied')).toHaveLength(2);
      expect(await autoReplies(tenantA)).toHaveLength(1);
      expect(await autoReplies(tenantB)).toHaveLength(1);
    });
  });

  describe('a person always wins', () => {
    it('D) the person takes the conversation while the reply is waiting for the row: NO reply is created afterwards', async () => {
      const ingested = await ingress.ingest(input({ externalMessageId: 'm-D-1' })); // inbound stored, still AI_ATENDENDO
      const conversationId = ingested.conversation.id;
      let outcome: string | undefined;
      let pending: Promise<unknown> | undefined;

      await owner(tenantA, async (tx) => {
        // The person's transaction holds the row lock...
        await tx.$queryRaw`SELECT id FROM conversations WHERE id = ${conversationId}::uuid FOR UPDATE`;
        // ...the automation tries to claim it and has to WAIT...
        pending = firstContact.acknowledge(ingested).then((o) => (outcome = o.reason));
        await new Promise((resolve) => setTimeout(resolve, 400));
        expect(outcome).toBeUndefined(); // really blocked on the lock, not decided yet
        // ...and the person takes the conversation, exactly as assign() writes it. Commit is the end of this callback.
        await tx.$executeRaw`UPDATE conversations SET assigned_user_id = ${userA}::uuid, state = 'HUMANO_ATENDENDO' WHERE id = ${conversationId}::uuid`;
      });
      await pending; // the claim now re-evaluates its WHERE against the committed row

      expect(outcome).toBe('not_eligible');
      expect(await autoReplies(tenantA)).toHaveLength(0);
      expect(await conversationRow(tenantA, conversationId)).toMatchObject({ state: 'HUMANO_ATENDENDO', assignedUserId: userA });
    });

    it('D) after the takeover further inbound messages are stored and never answered automatically', async () => {
      const first = await intake.receive(input({ externalMessageId: 'm-1' }));
      await conversations.assign(ctxA, first.conversation.id, userA); // the existing endpoint's service

      const next = await Promise.all(
        [2, 3, 4].map((n) => intake.receive(input({ externalMessageId: `m-${n}`, content: 'Quero um orçamento' }))),
      );

      expect(next.every((r) => r.autoReply.reason === 'not_eligible' && r.messageCreated)).toBe(true);
      expect(await autoReplies(tenantA)).toHaveLength(1); // only the one that preceded the takeover
      expect(await conversationRow(tenantA, first.conversation.id)).toMatchObject({ state: 'HUMANO_ATENDENDO', assignedUserId: userA });
      expect(await messagesOf(tenantA, { direction: 'INBOUND' })).toHaveLength(4);
    });

    it('D) a conversation assigned before any reply is never answered', async () => {
      const ingested = await ingress.ingest(input({ externalMessageId: 'm-1' }));
      await conversations.assign(ctxA, ingested.conversation.id, userA);

      const outcome = await firstContact.acknowledge(ingested); // the snapshot still says AI_ATENDENDO

      expect(outcome.reason).toBe('not_eligible');
      expect(await autoReplies(tenantA)).toHaveLength(0);
    });

    it('D) racing the real assign() against the reply, 25 rounds: never more than one reply, the person always ends up in charge', async () => {
      for (let round = 0; round < 25; round++) {
        const ingested = await ingress.ingest(input({ externalContactId: `wa-race-${round}`, externalMessageId: `m-race-${round}` }));

        const [outcome] = await Promise.all([
          firstContact.acknowledge({ ...ingested, conversation: { ...ingested.conversation } }),
          conversations.assign(ctxA, ingested.conversation.id, userA),
        ]);

        const replies = await autoReplies(tenantA, { conversationId: ingested.conversation.id });
        expect(replies.length).toBeLessThanOrEqual(1);
        expect(replies.length).toBe(outcome.reason === 'replied' ? 1 : 0);
        expect(await conversationRow(tenantA, ingested.conversation.id)).toMatchObject({ state: 'HUMANO_ATENDENDO', assignedUserId: userA });
      }
    });

    it('closing the conversation (state -> ENCERRADA) before the reply also wins', async () => {
      const ingested = await ingress.ingest(input({ externalMessageId: 'm-1' }));
      await owner(tenantA, (tx) => tx.$executeRaw`UPDATE conversations SET state = 'ENCERRADA' WHERE id = ${ingested.conversation.id}::uuid`);

      expect((await firstContact.acknowledge(ingested)).reason).toBe('not_eligible');
      expect(await autoReplies(tenantA)).toHaveLength(0);
    });
  });

  describe('failure of the reply', () => {
    it('does not lose the inbound message and leaves the conversation eligible; the next message gets the reply', async () => {
      const prisma = appPrisma as unknown as PrismaService;
      // A reply that fails at its LAST step: after the claim and the message insert, inside the same transaction.
      const failing = new FirstContactService(
        {
          runWithTenant: (tenantId: string, work: any) =>
            prisma.runWithTenant(tenantId, (tx) =>
              work(new Proxy(tx, { get: (target: any, prop) => (prop === 'auditLog' ? { create: () => Promise.reject(new Error('audit down')) } : target[prop]) })),
            ),
        } as unknown as PrismaService,
        { firstContactMessage: DEFAULT_FIRST_CONTACT_MESSAGE } as AppConfigService,
      );
      const errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

      const result = await new ConversationIntakeService(ingress, failing).receive(input({ externalMessageId: 'm-1', content: 'Oi' }));

      expect(result.autoReply.reason).toBe('failed');
      expect(await messagesOf(tenantA, { direction: 'INBOUND' })).toHaveLength(1);
      expect(await autoReplies(tenantA)).toHaveLength(0); // the reply rolled back with the claim
      expect((await conversationRow(tenantA, result.conversation.id)).state).toBe('AI_ATENDENDO');
      expect(errorLog).toHaveBeenCalled();
      errorLog.mockRestore();

      const next = await intake.receive(input({ externalMessageId: 'm-2' }));

      expect(next.autoReply.reason).toBe('replied');
      expect(await autoReplies(tenantA)).toHaveLength(1);
    });
  });
});
