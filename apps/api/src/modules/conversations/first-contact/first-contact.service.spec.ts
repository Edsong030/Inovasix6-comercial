import { BadRequestException, ConflictException, Logger } from '@nestjs/common';
import type { AppConfigService } from '../../../config/app-config.service';
import { DEFAULT_FIRST_CONTACT_MESSAGE } from '../../../config/first-contact';
import { ContactsService } from '../../contacts/contacts.service';
import { MessagesService } from '../../messages/messages.service';
import { ConversationIngressInput, ConversationIngressService } from '../conversation-ingress.service';
import { ConversationIntakeService } from '../conversation-intake.service';
import { FakeDb, Row } from '../../../../test/fake-tenant-db';
import { FIRST_CONTACT_CHANNELS, FirstContactService } from './first-contact.service';

/**
 * First contact -> automatic reply -> human handoff, through the REAL
 * ConversationIntakeService / ConversationIngressService / ContactsService /
 * FirstContactService over the in-memory tenant DB (rollback, unique
 * constraints, conditional UPDATE). Postgres concurrency is proven in
 * test/first-contact.integration-spec.ts.
 */
describe('first contact -> automatic reply -> handoff', () => {
  const A = 'tenant-a';
  const B = 'tenant-b';
  let db: FakeDb;
  let intake: ConversationIntakeService;
  let firstContact: FirstContactService;
  let messageText: string;

  const input = (over: Partial<ConversationIngressInput> = {}): ConversationIngressInput => ({
    tenantId: A,
    channel: 'WHATSAPP',
    externalContactId: 'wa-1',
    externalMessageId: `m-${++seq}`,
    content: 'Oi',
    ...over,
  });
  let seq = 0;

  /** The ingest result as a caller would hold it: a copy, so later changes to the row do not show through. */
  const detached = <T extends { conversation: object }>(result: T): T => ({ ...result, conversation: { ...result.conversation } });

  const outbound = (tenantId?: string) => db.messages.filter((m) => m.direction === 'OUTBOUND' && (!tenantId || m.tenantId === tenantId));
  const inbound = (tenantId?: string) => db.messages.filter((m) => m.direction === 'INBOUND' && (!tenantId || m.tenantId === tenantId));
  /** The structural marker of an automatic reply. */
  const isAutoReply = (m: Row) => m.direction === 'OUTBOUND' && m.senderType === 'SYSTEM' && m.senderUserId === null;

  /** Contact + identity + a conversation in a chosen state, as if created earlier. */
  const seedThread = (over: Row = {}, tenantId = A, channel = 'WHATSAPP', externalContactId = 'wa-1') => {
    const contact = db.commit('contacts', { tenantId });
    db.commit('identities', { tenantId, contactId: contact.id, channel, externalContactId });
    const conversation = db.commit('conversations', { tenantId, contactId: contact.id, channel, ...over });
    return { contact, conversation };
  };

  let loggedErrors: string[];

  beforeEach(() => {
    loggedErrors = [];
    jest.spyOn(Logger.prototype, 'error').mockImplementation((...args: unknown[]) => void loggedErrors.push(JSON.stringify(args)));
    db = new FakeDb();
    messageText = DEFAULT_FIRST_CONTACT_MESSAGE;
    const prisma = db.prisma();
    const config = { get firstContactMessage() { return messageText; } } as AppConfigService;
    firstContact = new FirstContactService(prisma, config);
    intake = new ConversationIntakeService(new ConversationIngressService(prisma, new ContactsService(prisma)), firstContact);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('the acknowledgement', () => {
    it('1. a first message like "Oi" gets the automatic reply', async () => {
      const result = await intake.receive(input({ content: 'Oi' }));

      expect(result.autoReply.reason).toBe('replied');
      expect(inbound()).toHaveLength(1);
      expect(outbound()).toHaveLength(1);
      expect(result.autoReply.message).toBe(outbound()[0]);
    });

    it('2. a long, detailed first message gets it too', async () => {
      const long = 'Bom dia, gostaria de saber como funciona o serviço de vocês. '.repeat(60).slice(0, 3900);

      const result = await intake.receive(input({ content: long }));

      expect(result.autoReply.reason).toBe('replied');
      expect(outbound()).toHaveLength(1);
    });

    it.each([
      'Oi',
      'Bom dia',
      'Quero informações',
      'Quanto custa?',
      'Vocês fazem esse serviço?',
      'Preciso de um orçamento',
      'Preciso falar com alguém',
      '?',
      '👍',
      'asdkjh qwe',
      'X'.repeat(4000),
    ])('3/20. the content never decides eligibility: %p', async (content) => {
      const result = await intake.receive(input({ content, externalContactId: `c-${++seq}` }));

      expect(result.autoReply.reason).toBe('replied');
    });

    it('20. the reply text does not depend on what the customer wrote', async () => {
      const a = await intake.receive(input({ content: 'preço', externalContactId: 'c-a' }));
      const b = await intake.receive(input({ content: 'Bom dia', externalContactId: 'c-b' }));

      expect(a.autoReply.message!.body).toBe(DEFAULT_FIRST_CONTACT_MESSAGE);
      expect(b.autoReply.message!.body).toBe(DEFAULT_FIRST_CONTACT_MESSAGE);
    });

    it('uses the configured text when there is one', async () => {
      messageText = 'Olá! Já chamamos alguém da equipe.';

      const result = await intake.receive(input());

      expect(result.autoReply.message!.body).toBe('Olá! Já chamamos alguém da equipe.');
    });

    it('does not interrogate the customer: the default text asks nothing mandatory', () => {
      expect(DEFAULT_FIRST_CONTACT_MESSAGE).toMatch(/se quiser/i);
      expect(DEFAULT_FIRST_CONTACT_MESSAGE).not.toMatch(/qual (o )?seu|CPF|endereço|cidade|orçamento/i);
      expect(DEFAULT_FIRST_CONTACT_MESSAGE.split('?')).toHaveLength(1); // no questions
    });

    it.each(FIRST_CONTACT_CHANNELS.map((c) => [c]))('29. works on the external channel %s (channel-agnostic)', async (channel) => {
      const result = await intake.receive(input({ channel: channel as any }));

      expect(result.autoReply.reason).toBe('replied');
      expect(outbound()[0]).toMatchObject({ tenantId: A });
      expect(db.conversations[0].channel).toBe(channel);
    });

    it('29. MANUAL is not an external channel: no automatic reply', async () => {
      const result = await intake.receive(input({ channel: 'MANUAL' }));

      expect(result.autoReply.reason).toBe('not_eligible');
      expect(inbound()).toHaveLength(1); // the message is still stored
      expect(outbound()).toHaveLength(0);
      expect(db.conversations[0].state).toBe('AI_ATENDENDO'); // untouched
      expect(FIRST_CONTACT_CHANNELS).not.toContain('MANUAL');
    });
  });

  describe('the reply is a real, structurally identifiable message', () => {
    it('14. it is an OUTBOUND Message of the same tenant and conversation', async () => {
      const result = await intake.receive(input());

      expect(outbound()[0]).toMatchObject({
        tenantId: A,
        conversationId: result.conversation.id,
        direction: 'OUTBOUND',
        body: DEFAULT_FIRST_CONTACT_MESSAGE,
      });
    });

    it('status PENDING: created, not yet delivered to any provider (no adapter exists)', async () => {
      await intake.receive(input());

      expect(outbound()[0].status).toBe('PENDING');
    });

    it('15. it is identified by structure (SYSTEM sender, no user), never by its text', async () => {
      await intake.receive(input());
      const reply = outbound()[0];

      expect(reply).toMatchObject({ senderType: 'SYSTEM', senderUserId: null, externalId: null });
      expect(isAutoReply(reply)).toBe(true);
      // the customer's own message is not one, even with the very same text
      const echo = db.commit('messages', { tenantId: A, conversationId: reply.conversationId, direction: 'INBOUND', senderType: 'CUSTOMER', body: reply.body });
      expect(isAutoReply(echo)).toBe(false);
    });

    it('16. an agent\'s message (POST /conversations/:id/messages) is not mistaken for an automatic one', async () => {
      const result = await intake.receive(input());
      const messages = new MessagesService(db.prisma());

      await messages.send({ tenantId: A, userId: 'agent-1', roleCodes: ['ATENDENTE'] }, result.conversation.id, { body: 'Olá, sou a Ana da equipe.' });

      const human = outbound().find((m) => m.senderType === 'AGENT')!;
      expect(human).toMatchObject({ senderType: 'AGENT', senderUserId: 'agent-1', status: 'SENT' });
      expect(isAutoReply(human)).toBe(false);
      expect(outbound().filter(isAutoReply)).toHaveLength(1);
    });

    it('is written strictly after the customer\'s message, so the thread reads in order', async () => {
      const result = await intake.receive(input({ occurredAt: new Date() }));

      expect(outbound()[0].createdAt.getTime()).toBeGreaterThan(result.message.createdAt.getTime());
    });

    it('advances lastMessageAt to the reply', async () => {
      const result = await intake.receive(input({ occurredAt: new Date('2024-01-01T10:00:00Z') }));

      expect(db.conversations[0].lastMessageAt).toEqual(outbound()[0].createdAt);
      expect(outbound()[0].createdAt.getTime()).toBeGreaterThan(result.message.createdAt.getTime());
    });

    it('is audited without an actor (it was not a person)', async () => {
      const result = await intake.receive(input());

      expect(db.audits).toEqual([
        expect.objectContaining({
          tenantId: A,
          actorId: null,
          action: 'CONVERSATION_FIRST_CONTACT_REPLY',
          entity: 'Conversation',
          entityId: result.conversation.id,
          after: expect.objectContaining({ state: 'AGUARDANDO_HUMANO', messageId: outbound()[0].id }),
        }),
      ]);
    });
  });

  describe('handoff', () => {
    it('12/13/18. after the reply the conversation waits for a human, unassigned', async () => {
      await intake.receive(input());

      expect(db.conversations[0]).toMatchObject({ state: 'AGUARDANDO_HUMANO', assignedUserId: null });
    });

    it('the reply and the handoff are one unit: the conversation is not handed over without its reply', async () => {
      db.before = (op) => {
        if (op === 'audit.create') throw new Error('boom'); // last step of the reply transaction
      };

      const result = await intake.receive(input());

      expect(result.autoReply.reason).toBe('failed');
      expect(db.conversations[0].state).toBe('AI_ATENDENDO'); // the claim rolled back with the reply
      expect(outbound()).toHaveLength(0);
    });

    it('a person taking over (assign) after the reply moves it to HUMANO_ATENDENDO and the automation stays out', async () => {
      const first = await intake.receive(input({ externalMessageId: 'm-first' }));
      // what ConversationsService.assign writes
      db.conversations.find((c) => c.id === first.conversation.id)!.assignedUserId = 'agent-1';
      db.conversations.find((c) => c.id === first.conversation.id)!.state = 'HUMANO_ATENDENDO';

      const next = await intake.receive(input({ externalMessageId: 'm-next', content: 'Quero um orçamento' }));

      expect(next.autoReply.reason).toBe('not_eligible');
      expect(outbound().filter(isAutoReply)).toHaveLength(1);
      expect(inbound()).toHaveLength(2);
    });
  });

  describe('at most one reply per conversation', () => {
    it('5/6/7/17. Oi / Oi? / Tem alguém? / Preciso falar: four messages stored, ONE automatic reply', async () => {
      const results = [];
      for (const content of ['Oi', 'Oi?', 'Tem alguém?', 'Preciso falar com vocês']) {
        results.push(await intake.receive(input({ content })));
      }

      expect(results.map((r) => r.autoReply.reason)).toEqual(['replied', 'not_eligible', 'not_eligible', 'not_eligible']);
      expect(inbound()).toHaveLength(4);
      expect(outbound()).toHaveLength(1);
      expect(db.conversations).toHaveLength(1);
      // the history reads: customer, reply, customer, customer, customer
      const thread = [...db.messages].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      expect(thread[0].direction).toBe('INBOUND');
      expect(thread.filter((m) => m.direction === 'OUTBOUND')).toHaveLength(1);
    });

    it('a second inbound does not even open a transaction for the first-contact step', async () => {
      await intake.receive(input({ externalMessageId: 'm-1' }));
      const before = db.transactions;

      await intake.receive(input({ externalMessageId: 'm-2' }));

      expect(db.transactions - before).toBe(3); // duplicate check + contact + persist. No fourth.
    });

    it('acknowledging the very same ingest result twice replies only once (the database claim decides)', async () => {
      const ingressOnly = new ConversationIngressService(db.prisma(), new ContactsService(db.prisma()));
      const result = await ingressOnly.ingest(input());

      const [first, second] = [await firstContact.acknowledge(result), await firstContact.acknowledge(result)];

      expect([first.reason, second.reason]).toEqual(['replied', 'not_eligible']);
      expect(outbound()).toHaveLength(1);
    });

    it('a stale snapshot cannot trigger a second reply: the row in the database decides, not the object passed in', async () => {
      const ingressOnly = new ConversationIngressService(db.prisma(), new ContactsService(db.prisma()));
      const result = detached(await ingressOnly.ingest(input()));
      db.conversations[0].state = 'AGUARDANDO_HUMANO'; // someone moved on after ingest returned

      const outcome = await firstContact.acknowledge(result); // result.conversation still says AI_ATENDENDO

      expect(outcome.reason).toBe('not_eligible');
      expect(outbound()).toHaveLength(0);
    });
  });

  describe('idempotency (redelivery)', () => {
    it('4/18. a duplicate inbound gets no reply and has no side effect', async () => {
      const original = input({ externalMessageId: 'wamid-1' });
      await intake.receive(original);
      const before = { transactions: db.transactions, messages: db.messages.length, audits: db.audits.length, state: db.conversations[0].state };

      const again = await intake.receive({ ...original, content: 'EDITADO' });

      expect(again.duplicate).toBe(true);
      expect(again.autoReply).toEqual({ reason: 'duplicate', message: null });
      expect(db.messages).toHaveLength(before.messages);
      expect(db.audits).toHaveLength(before.audits);
      expect(db.conversations[0].state).toBe(before.state);
      expect(db.transactions - before.transactions).toBe(1); // only the duplicate check
    });

    it('a redelivery of a message whose reply FAILED does not retry it: duplicates never have effects', async () => {
      let n = 0;
      db.before = (op) => {
        if (op === 'message.create' && ++n === 2) throw new Error('boom');
      };
      const original = input({ externalMessageId: 'wamid-1' });
      await intake.receive(original);
      db.before = undefined;

      const again = await intake.receive(original);

      expect(again.autoReply.reason).toBe('duplicate');
      expect(outbound()).toHaveLength(0);
    });

    it('19. empty content is refused by the existing validation, before anything happens', async () => {
      await expect(intake.receive(input({ content: '' }))).rejects.toBeInstanceOf(BadRequestException);

      expect(db.transactions).toBe(0);
      expect(db.messages).toHaveLength(0);
    });
  });

  describe('a person always has priority', () => {
    it('9. HUMANO_ATENDENDO gets no automatic reply', async () => {
      const { conversation } = seedThread({ state: 'HUMANO_ATENDENDO', assignedUserId: 'agent-1' });

      const result = await intake.receive(input());

      expect(result.conversation.id).toBe(conversation.id);
      expect(result.autoReply.reason).toBe('not_eligible');
      expect(outbound()).toHaveLength(0);
      expect(db.conversations[0]).toMatchObject({ state: 'HUMANO_ATENDENDO', assignedUserId: 'agent-1' });
    });

    it('10. an assignedUserId blocks the reply even if the state still says AI_ATENDENDO', async () => {
      seedThread({ state: 'AI_ATENDENDO', assignedUserId: 'agent-1' });

      const result = await intake.receive(input());

      expect(result.autoReply.reason).toBe('not_eligible');
      expect(outbound()).toHaveLength(0);
      expect(db.conversations[0].assignedUserId).toBe('agent-1');
    });

    it('the claim itself (not just the pre-filter) refuses an assigned row when the snapshot it was given is stale', async () => {
      const ingressOnly = new ConversationIngressService(db.prisma(), new ContactsService(db.prisma()));
      const result = detached(await ingressOnly.ingest(input())); // snapshot: AI_ATENDENDO, unassigned
      db.conversations[0].assignedUserId = 'agent-1'; // a person took it right after (state row not yet moved)

      const outcome = await firstContact.acknowledge(result);

      expect(outcome.reason).toBe('not_eligible');
      expect(outbound()).toHaveLength(0);
      expect(db.conversations[0]).toMatchObject({ state: 'AI_ATENDENDO', assignedUserId: 'agent-1' });
    });

    it('AGUARDANDO_HUMANO (already handed to the team) is not acknowledged again', async () => {
      seedThread({ state: 'AGUARDANDO_HUMANO' });

      const result = await intake.receive(input());

      expect(result.autoReply.reason).toBe('not_eligible');
      expect(outbound()).toHaveLength(0);
    });

    it('a person taking the conversation BETWEEN the ingest and the reply wins: no reply is created', async () => {
      // the human's UPDATE lands right before the automation's claim:
      // updateMany #1 is the ingress advancing lastMessageAt, #2 is the claim
      let updates = 0;
      db.before = (op) => {
        if (op === 'conversation.updateMany' && ++updates === 2) {
          db.conversations[0].assignedUserId = 'agent-1';
          db.conversations[0].state = 'HUMANO_ATENDENDO';
        }
      };

      const result = await intake.receive(input());

      expect(result.autoReply.reason).toBe('not_eligible');
      expect(outbound()).toHaveLength(0);
      expect(db.conversations[0]).toMatchObject({ state: 'HUMANO_ATENDENDO', assignedUserId: 'agent-1' });
    });

    it('closing the conversation between the ingest and the reply also wins', async () => {
      let updates = 0;
      db.before = (op) => {
        if (op === 'conversation.updateMany' && ++updates === 2) db.conversations[0].state = 'ENCERRADA';
      };

      const result = await intake.receive(input());

      expect(result.autoReply.reason).toBe('not_eligible');
      expect(outbound()).toHaveLength(0);
    });
  });

  describe('closed conversations and new ones', () => {
    it('11. an ENCERRADA conversation gets no reply; the message opens a NEW conversation that does', async () => {
      const { conversation: closed } = seedThread({ state: 'ENCERRADA' });

      const result = await intake.receive(input());

      expect(result.conversation.id).not.toBe(closed.id);
      expect(result.conversationCreated).toBe(true);
      expect(result.autoReply.reason).toBe('replied');
      expect(outbound().every((m) => m.conversationId !== closed.id)).toBe(true);
      expect(db.conversations.find((c) => c.id === closed.id)).toMatchObject({ state: 'ENCERRADA', lastMessageAt: null });
    });

    it('acknowledging directly against a closed conversation is refused by the database claim', async () => {
      const ingressOnly = new ConversationIngressService(db.prisma(), new ContactsService(db.prisma()));
      const result = detached(await ingressOnly.ingest(input()));
      db.conversations[0].state = 'ENCERRADA';

      expect((await firstContact.acknowledge(result)).reason).toBe('not_eligible');
      expect(outbound()).toHaveLength(0);
    });

    it('8. the rule is per Conversation, not once per Contact: a new conversation of the same Contact is acknowledged again', async () => {
      const first = await intake.receive(input({ externalMessageId: 'm-1' }));
      db.conversations[0].state = 'ENCERRADA'; // the team closed it

      const second = await intake.receive(input({ externalMessageId: 'm-2' }));

      expect(second.contact.id).toBe(first.contact.id);
      expect(second.conversation.id).not.toBe(first.conversation.id);
      expect(second.autoReply.reason).toBe('replied');
      expect(outbound()).toHaveLength(2);
      expect(new Set(outbound().map((m) => m.conversationId)).size).toBe(2);
    });

    it('a Contact writing on two channels gets one acknowledgement per conversation', async () => {
      await intake.receive(input({ channel: 'WHATSAPP', contact: { phone: '+5541999999999' } }));
      await intake.receive(input({ channel: 'INSTAGRAM', externalContactId: 'ig-1', contact: { phone: '+5541999999999' } }));

      expect(outbound()).toHaveLength(2);
      expect(db.conversations.map((c) => c.channel).sort()).toEqual(['INSTAGRAM', 'WHATSAPP']);
    });

    it('tenants are isolated: each gets its own reply, in its own tenant', async () => {
      await intake.receive(input({ tenantId: A, externalMessageId: 'same' }));
      await intake.receive(input({ tenantId: B, externalMessageId: 'same' }));

      expect(outbound(A)).toHaveLength(1);
      expect(outbound(B)).toHaveLength(1);
      expect(db.audits.map((a) => a.tenantId).sort()).toEqual([A, B]);
    });
  });

  describe('failure of the automatic reply', () => {
    it('17/23. the customer\'s message survives; the failure is logged (not thrown) and the conversation stays eligible', async () => {
      let n = 0;
      db.before = (op) => {
        if (op === 'message.create' && ++n === 2) throw Object.assign(new Error('Invalid `prisma.message.create()`: body "CONTEUDO-PRIVADO"'), { code: 'P2010' });
      };

      const result = await intake.receive(input({ content: 'CONTEUDO-PRIVADO' }));

      expect(result.messageCreated).toBe(true);
      expect(result.autoReply).toEqual({ reason: 'failed', message: null });
      expect(inbound()).toHaveLength(1);
      expect(inbound()[0].body).toBe('CONTEUDO-PRIVADO');
      expect(outbound()).toHaveLength(0);
      expect(db.conversations[0]).toMatchObject({ state: 'AI_ATENDENDO', assignedUserId: null });
      const logged = loggedErrors.join('\n');
      expect(logged).toContain('first_contact.failed');
      expect(logged).toContain('P2010');
      expect(logged).not.toContain('CONTEUDO-PRIVADO'); // the error message (which can quote data) is not logged
    });

    it('the next inbound message recovers: the conversation is still eligible and now gets its reply', async () => {
      let n = 0;
      db.before = (op) => {
        if (op === 'message.create' && ++n === 2) throw new Error('boom');
      };
      await intake.receive(input({ externalMessageId: 'm-1' }));
      db.before = undefined;

      const next = await intake.receive(input({ externalMessageId: 'm-2' }));

      expect(next.autoReply.reason).toBe('replied');
      expect(outbound()).toHaveLength(1);
      expect(inbound()).toHaveLength(2);
    });

    it('an ingest failure is not swallowed: it propagates and no reply is attempted', async () => {
      db.failOnce = { op: 'message.create', error: new Error('inbound boom') };

      await expect(intake.receive(input())).rejects.toThrow('inbound boom');

      expect(outbound()).toHaveLength(0);
    });

    it('a 409 from the ingress stays a 409 and triggers no reply', async () => {
      const other = db.commit('contacts', { tenantId: A });
      db.commit('conversations', { tenantId: A, contactId: other.id, channel: 'WEBCHAT', externalConversationId: 'S1' });

      await expect(
        intake.receive(input({ channel: 'WEBCHAT', externalContactId: 'visitor-9', externalConversationId: 'S1' })),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(outbound()).toHaveLength(0);
    });
  });
});
