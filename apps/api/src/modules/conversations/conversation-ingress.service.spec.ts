import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ContactsService } from '../contacts/contacts.service';
import { InvalidPhoneNumberException } from '../contacts/phone-number';
import { ConversationIngressInput, ConversationIngressService } from './conversation-ingress.service';

/**
 * Unit tests for ConversationIngressService (and the real ContactsService it
 * delegates to) against an in-memory fake that behaves like Postgres where it
 * matters here (READ COMMITTED):
 *  - writes stay pending until the transaction commits; a throw rolls back
 *    everything, including in-place UPDATEs (undo log)
 *  - the three constraints raise a real Prisma P2002 with `meta.target = null`
 *    (that is what the installed Prisma reports):
 *      conversations_open_per_contact_channel (partial: state <> ENCERRADA)
 *      conversations_open_external_conversation_id (partial:
 *        (tenant, channel, external_conversation_id) WHERE state <> 'ENCERRADA')
 *      messages (tenant, external_id)
 *  - composite FKs keep conversations/messages inside their tenant
 *  - RLS: a transaction only sees/writes rows of the tenant it was opened for
 * Real-database concurrency lives in test/conversation-ingress.integration-spec.ts.
 */

type Row = Record<string, any>;
type Table = 'contacts' | 'identities' | 'conversations' | 'messages';

function p2002(modelName: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the (not available)', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { modelName, target: null },
  });
}

class FakeDb {
  contacts: Row[] = [];
  identities: Row[] = [];
  conversations: Row[] = [];
  messages: Row[] = [];
  transactions = 0;
  private seq = 0;

  /** Called right before each operation; lets a test interleave a "winner". */
  before?: (op: string, tenantId: string) => void;
  /** Force an operation to throw once / on every call. */
  failOnce?: { op: string; error: Error };
  failAlways?: { op: string; error: Error };

  id(prefix: string): string {
    return `${prefix}-${++this.seq}`;
  }

  /** Commit a row directly, as if another request had already finished. */
  commit(table: Table, row: Row): Row {
    const defaults: Record<Table, Row> = {
      contacts: { name: null, phoneE164: null, email: null },
      identities: {},
      conversations: {
        state: 'AI_ATENDENDO',
        leadId: null,
        assignedUserId: null,
        subject: null,
        externalConversationId: null,
        lastMessageAt: null,
      },
      messages: { status: 'PENDING', senderType: 'CUSTOMER', senderUserId: null, externalId: null, body: null },
    };
    const created = {
      id: this.id(table),
      createdAt: new Date(Date.UTC(2020, 0, 1, 0, 0, this.seq)),
      ...defaults[table],
      ...row,
    };
    this[table].push(created);
    return created;
  }

  prisma(): any {
    return {
      runWithTenant: async (tenantId: string, work: (tx: any) => Promise<unknown>) => {
        this.transactions++;
        const pending: Record<Table, Row[]> = { contacts: [], identities: [], conversations: [], messages: [] };
        const undo: Array<() => void> = [];
        try {
          const result = await work(this.makeTx(tenantId, pending, undo));
          for (const table of Object.keys(pending) as Table[]) this[table].push(...pending[table]); // commit
          return result;
        } catch (error) {
          for (const revert of undo.reverse()) revert(); // rollback of in-place updates
          throw error; // pending inserts are simply discarded
        }
      },
    };
  }

  private makeTx(tenantId: string, pending: Record<Table, Row[]>, undo: Array<() => void>) {
    const guard = (op: string) => {
      this.before?.(op, tenantId);
      if (this.failAlways?.op === op) throw this.failAlways.error;
      if (this.failOnce?.op === op) {
        const { error } = this.failOnce;
        this.failOnce = undefined;
        throw error;
      }
    };
    // Unique checks see everything committed (a competing txn) + own pending rows.
    const all = (t: Table) => [...this[t], ...pending[t]];
    // RLS: only rows of the current tenant are visible.
    const visible = (t: Table) => all(t).filter((r) => r.tenantId === tenantId);
    const rls = (row: Row) => {
      if (row.tenantId !== tenantId) throw new Error('new row violates row-level security policy');
    };
    const fk = (t: Table, tenant: string, id: string, name: string) => {
      if (!all(t).some((r) => r.tenantId === tenant && r.id === id)) {
        throw new Error(`Foreign key constraint violated: ${name}`);
      }
    };
    const insert = (t: Table, row: Row) => {
      pending[t].push(row);
      return row;
    };
    const stamp = () => ({ createdAt: new Date(), updatedAt: new Date() });
    // conversations_open_external_conversation_id: (tenant, channel, thread) unique among OPEN rows.
    const threadTaken = (row: Row, self: Row | undefined) =>
      row.externalConversationId !== null &&
      row.state !== 'ENCERRADA' &&
      all('conversations').some(
        (c) =>
          c !== self &&
          c.tenantId === row.tenantId &&
          c.channel === row.channel &&
          c.externalConversationId === row.externalConversationId &&
          c.state !== 'ENCERRADA',
      );

    return {
      contact: {
        findUnique: async ({ where }: any) => {
          guard('contact.findUnique');
          const k = where.tenantId_phoneE164;
          return visible('contacts').find((c) => c.tenantId === k.tenantId && c.phoneE164 === k.phoneE164) ?? null;
        },
        create: async ({ data }: any) => {
          guard('contact.create');
          rls(data);
          if (data.phoneE164 && all('contacts').some((c) => c.tenantId === data.tenantId && c.phoneE164 === data.phoneE164)) {
            throw p2002('Contact');
          }
          return insert('contacts', { id: this.id('contacts'), name: null, phoneE164: null, email: null, ...data, ...stamp() });
        },
      },
      contactChannelIdentity: {
        findUnique: async ({ where, include }: any) => {
          guard('identity.findUnique');
          const k = where.tenantId_channel_externalContactId;
          const row = visible('identities').find(
            (i) => i.tenantId === k.tenantId && i.channel === k.channel && i.externalContactId === k.externalContactId,
          );
          if (!row) return null;
          return include?.contact ? { ...row, contact: visible('contacts').find((c) => c.id === row.contactId) } : row;
        },
        create: async ({ data }: any) => {
          guard('identity.create');
          rls(data);
          fk('contacts', data.tenantId, data.contactId, 'contact_channel_identities_tenant_id_contact_id_fkey');
          if (
            all('identities').some(
              (i) => i.tenantId === data.tenantId && i.channel === data.channel && i.externalContactId === data.externalContactId,
            )
          ) {
            throw p2002('ContactChannelIdentity');
          }
          return insert('identities', { id: this.id('identities'), ...data });
        },
      },
      conversation: {
        findUniqueOrThrow: async ({ where }: any) => {
          guard('conversation.findUniqueOrThrow');
          const row = visible('conversations').find((c) => c.id === where.id);
          if (!row) throw new Error('No Conversation found');
          return row;
        },
        findFirst: async ({ where }: any) => {
          guard('conversation.findFirst');
          const rows = visible('conversations').filter(
            (c) =>
              c.tenantId === where.tenantId &&
              (where.contactId === undefined || c.contactId === where.contactId) &&
              c.channel === where.channel &&
              (where.externalConversationId === undefined || c.externalConversationId === where.externalConversationId) &&
              c.state !== where.state.not,
          );
          return rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null;
        },
        create: async ({ data }: any) => {
          guard('conversation.create');
          rls(data);
          fk('contacts', data.tenantId, data.contactId, 'conversations_tenant_id_contact_id_fkey');
          const row: Row = {
            id: this.id('conversations'),
            state: 'AI_ATENDENDO',
            leadId: null,
            assignedUserId: null,
            subject: null,
            externalConversationId: null,
            lastMessageAt: null,
            ...data,
            ...stamp(),
          };
          // conversations_open_per_contact_channel: WHERE state <> 'ENCERRADA'
          if (
            row.state !== 'ENCERRADA' &&
            all('conversations').some(
              (c) =>
                c.tenantId === row.tenantId &&
                c.contactId === row.contactId &&
                c.channel === row.channel &&
                c.state !== 'ENCERRADA',
            )
          ) {
            throw p2002('Conversation');
          }
          if (threadTaken(row, undefined)) throw p2002('Conversation');
          return insert('conversations', row);
        },
        updateMany: async ({ where, data }: any) => {
          guard('conversation.updateMany');
          const matches = (c: Row) => {
            if (c.id !== where.id || c.tenantId !== where.tenantId) return false;
            if ('externalConversationId' in where && c.externalConversationId !== where.externalConversationId) return false;
            if (where.state?.not && c.state === where.state.not) return false;
            if (
              where.OR &&
              !where.OR.some((cond: any) =>
                cond.lastMessageAt === null
                  ? c.lastMessageAt === null
                  : c.lastMessageAt !== null && c.lastMessageAt < cond.lastMessageAt.lt,
              )
            ) {
              return false;
            }
            return true;
          };
          const rows = visible('conversations').filter(matches);
          for (const row of rows) {
            if (threadTaken({ ...row, ...data }, row)) throw p2002('Conversation');
            const before = { ...row };
            Object.assign(row, data, { updatedAt: new Date() });
            undo.push(() => Object.assign(row, before));
          }
          return { count: rows.length };
        },
      },
      message: {
        findUnique: async ({ where }: any) => {
          guard('message.findUnique');
          const k = where.tenantId_externalId;
          const row = visible('messages').find((m) => m.tenantId === k.tenantId && m.externalId === k.externalId);
          if (!row) return null;
          const conversation = visible('conversations').find((c) => c.id === row.conversationId);
          return { ...row, conversation: { ...conversation, contact: visible('contacts').find((c) => c.id === conversation!.contactId) } };
        },
        create: async ({ data }: any) => {
          guard('message.create');
          rls(data);
          fk('conversations', data.tenantId, data.conversationId, 'messages_tenant_id_conversation_id_fkey');
          if (
            data.externalId != null &&
            all('messages').some((m) => m.tenantId === data.tenantId && m.externalId === data.externalId)
          ) {
            throw p2002('Message');
          }
          return insert('messages', {
            id: this.id('messages'),
            status: 'PENDING',
            senderType: 'CUSTOMER',
            senderUserId: null,
            externalId: null,
            body: null,
            createdAt: new Date(),
            ...data,
          });
        },
      },
    };
  }
}

const at = (h: number, m: number) => new Date(Date.UTC(2024, 0, 1, h, m));

describe('ConversationIngressService.ingest', () => {
  const A = 'tenant-a';
  const B = 'tenant-b';
  let db: FakeDb;
  let service: ConversationIngressService;

  const input = (over: Partial<ConversationIngressInput> = {}): ConversationIngressInput => ({
    tenantId: A,
    channel: 'WHATSAPP',
    externalContactId: 'wa-1',
    externalMessageId: 'm-1',
    content: 'Olá',
    ...over,
  });

  /** Contact + identity + open conversation, as if created by an earlier ingest. */
  const seedThread = (over: Row = {}, tenantId = A) => {
    const contact = db.commit('contacts', { tenantId, name: 'Ana' });
    db.commit('identities', { tenantId, contactId: contact.id, channel: 'WHATSAPP', externalContactId: 'wa-1' });
    const conversation = db.commit('conversations', { tenantId, contactId: contact.id, channel: 'WHATSAPP', ...over });
    return { contact, conversation };
  };

  beforeEach(() => {
    db = new FakeDb();
    const prisma = db.prisma();
    service = new ConversationIngressService(prisma, new ContactsService(prisma));
  });

  describe('new conversation flow', () => {
    it('4. new Contact: resolves Contact + identity via ContactsService and creates the Conversation', async () => {
      const result = await service.ingest(
        input({ contact: { name: 'Ana', phone: '+5541999999999', email: 'ana@example.com' } }),
      );

      expect(result).toMatchObject({
        contactCreated: true,
        identityCreated: true,
        conversationCreated: true,
        messageCreated: true,
        duplicate: false,
      });
      expect(db.contacts).toHaveLength(1);
      expect(db.contacts[0]).toMatchObject({ tenantId: A, name: 'Ana', phoneE164: '+5541999999999' });
      expect(db.identities).toEqual([
        expect.objectContaining({ contactId: db.contacts[0].id, channel: 'WHATSAPP', externalContactId: 'wa-1' }),
      ]);
      expect(db.conversations).toHaveLength(1);
      expect(result.contact.id).toBe(db.contacts[0].id);
      expect(result.conversation.id).toBe(db.conversations[0].id);
      expect(result.message.id).toBe(db.messages[0].id);
    });

    it('creates the Conversation in the default AI_ATENDENDO state, unassigned and with no Lead', async () => {
      await service.ingest(input());

      expect(db.conversations[0]).toMatchObject({
        tenantId: A,
        channel: 'WHATSAPP',
        state: 'AI_ATENDENDO',
        leadId: null,
        assignedUserId: null,
        externalConversationId: null,
      });
    });

    it('5-7. persists the Message as INBOUND/DELIVERED/CUSTOMER with the external id and content', async () => {
      const result = await service.ingest(input({ content: '  Preciso de ajuda  ' }));

      expect(db.messages).toHaveLength(1);
      expect(db.messages[0]).toMatchObject({
        tenantId: A,
        conversationId: db.conversations[0].id,
        direction: 'INBOUND',
        status: 'DELIVERED',
        senderType: 'CUSTOMER',
        senderUserId: null,
        externalId: 'm-1',
        body: '  Preciso de ajuda  ', // no trimming, same as the agent API
      });
      expect(result.message).toBe(db.messages[0]);
    });

    it('8. sets lastMessageAt to the persisted message timestamp', async () => {
      const result = await service.ingest(input({ occurredAt: at(10, 5) }));

      expect(result.message.createdAt).toEqual(at(10, 5));
      expect(result.conversation.lastMessageAt).toEqual(at(10, 5));
      expect(db.conversations[0].lastMessageAt).toEqual(at(10, 5));
    });

    it('without occurredAt, uses the time of receipt for both', async () => {
      const before = Date.now();
      const result = await service.ingest(input());
      const after = Date.now();

      const t = result.message.createdAt.getTime();
      expect(t).toBeGreaterThanOrEqual(before);
      expect(t).toBeLessThanOrEqual(after);
      expect(result.conversation.lastMessageAt).toEqual(result.message.createdAt);
    });

    it('clamps a future occurredAt to the time of receipt', async () => {
      const result = await service.ingest(input({ occurredAt: new Date(Date.now() + 24 * 3600 * 1000) }));

      expect(result.message.createdAt.getTime()).toBeLessThanOrEqual(Date.now());
      expect(result.conversation.lastMessageAt).toEqual(result.message.createdAt);
    });
  });

  describe('conversation resolution', () => {
    it('2. existing Contact + open Conversation: reuses the Conversation', async () => {
      const { contact, conversation } = seedThread();

      const result = await service.ingest(input());

      expect(result).toMatchObject({
        contactCreated: false,
        identityCreated: false,
        conversationCreated: false,
        messageCreated: true,
      });
      expect(result.contact.id).toBe(contact.id);
      expect(result.conversation.id).toBe(conversation.id);
      expect(db.conversations).toHaveLength(1);
      expect(db.messages[0].conversationId).toBe(conversation.id);
    });

    it.each(['AGUARDANDO_HUMANO', 'HUMANO_ATENDENDO'])('reuses an open conversation in state %s', async (state) => {
      const { conversation } = seedThread({ state, assignedUserId: state === 'HUMANO_ATENDENDO' ? 'u-1' : null });

      const result = await service.ingest(input());

      expect(result.conversation.id).toBe(conversation.id);
      expect(result.conversation.state).toBe(state); // ingest never changes state/assignment
      expect(db.conversations).toHaveLength(1);
    });

    it('3. existing Contact + only an ENCERRADA Conversation: creates a new one', async () => {
      const { contact, conversation: closed } = seedThread({ state: 'ENCERRADA' });

      const result = await service.ingest(input());

      expect(result.conversationCreated).toBe(true);
      expect(result.conversation.id).not.toBe(closed.id);
      expect(result.conversation.contactId).toBe(contact.id);
      expect(result.conversation.state).toBe('AI_ATENDENDO');
      expect(db.conversations).toHaveLength(2);
      expect(db.conversations.find((c) => c.id === closed.id)).toMatchObject({ state: 'ENCERRADA', lastMessageAt: null });
    });

    it('9. two different sequential messages share the same open Conversation', async () => {
      const first = await service.ingest(input({ externalMessageId: 'm-1', occurredAt: at(10, 0) }));
      const second = await service.ingest(input({ externalMessageId: 'm-2', occurredAt: at(10, 1) }));

      expect(first.conversationCreated).toBe(true);
      expect(second.conversationCreated).toBe(false);
      expect(second.conversation.id).toBe(first.conversation.id);
      expect(db.contacts).toHaveLength(1);
      expect(db.conversations).toHaveLength(1);
      expect(db.messages).toHaveLength(2);
      expect(second.conversation.lastMessageAt).toEqual(at(10, 1));
    });

    it('10. a message after the Conversation was closed opens a new Conversation', async () => {
      const first = await service.ingest(input({ externalMessageId: 'm-1' }));
      db.conversations[0].state = 'ENCERRADA';

      const second = await service.ingest(input({ externalMessageId: 'm-2' }));

      expect(second.conversationCreated).toBe(true);
      expect(second.conversation.id).not.toBe(first.conversation.id);
      expect(second.contact.id).toBe(first.contact.id);
      expect(db.conversations.map((c) => c.state).sort()).toEqual(['AI_ATENDENDO', 'ENCERRADA']);
    });

    it('11. same Contact on different channels gets a Conversation per channel', async () => {
      const wa = await service.ingest(
        input({ channel: 'WHATSAPP', externalMessageId: 'm-1', contact: { phone: '+5541999999999' } }),
      );
      const ig = await service.ingest(
        input({
          channel: 'INSTAGRAM',
          externalContactId: 'ig-1',
          externalMessageId: 'm-2',
          contact: { phone: '+5541999999999' },
        }),
      );

      expect(ig.contact.id).toBe(wa.contact.id); // same person, matched by phone
      expect(ig.conversation.id).not.toBe(wa.conversation.id);
      expect(db.conversations.map((c) => c.channel).sort()).toEqual(['INSTAGRAM', 'WHATSAPP']);
    });

    it('12. different tenants are fully isolated, even with identical ids', async () => {
      const a = await service.ingest(input({ tenantId: A, contact: { phone: '+5541999999999' } }));
      const b = await service.ingest(input({ tenantId: B, contact: { phone: '+5541999999999' } }));

      expect(b.duplicate).toBe(false); // same externalMessageId in another tenant is NOT a duplicate
      expect(a.contact.id).not.toBe(b.contact.id);
      expect(a.conversation.id).not.toBe(b.conversation.id);
      expect(a.message.id).not.toBe(b.message.id);
      expect(db.contacts.map((c) => c.tenantId).sort()).toEqual([A, B]);
      expect(db.conversations.map((c) => c.tenantId).sort()).toEqual([A, B]);
      expect(db.messages.map((m) => m.tenantId).sort()).toEqual([A, B]);
    });
  });

  describe('externalConversationId', () => {
    it('anchors a NEW conversation with the provider thread id', async () => {
      const result = await service.ingest(input({ channel: 'WEBCHAT', externalConversationId: 'S1' }));

      expect(result.conversation.externalConversationId).toBe('S1');
    });

    it('13. reuses the open conversation that carries this thread id for the same Contact', async () => {
      const { conversation } = seedThread({ channel: 'WEBCHAT', externalConversationId: 'S1' });
      db.identities[0].channel = 'WEBCHAT';

      const result = await service.ingest(input({ channel: 'WEBCHAT', externalConversationId: 'S1' }));

      expect(result.conversationCreated).toBe(false);
      expect(result.conversation.id).toBe(conversation.id);
      expect(db.conversations).toHaveLength(1);
    });

    it('14. thread id that belongs to ANOTHER Contact is a 409, never reassigned', async () => {
      const other = db.commit('contacts', { tenantId: A, name: 'Outro' });
      const foreign = db.commit('conversations', {
        tenantId: A,
        contactId: other.id,
        channel: 'WEBCHAT',
        externalConversationId: 'S1',
      });

      await expect(
        service.ingest(input({ channel: 'WEBCHAT', externalContactId: 'visitor-9', externalConversationId: 'S1' })),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(db.conversations).toEqual([foreign]);
      expect(db.conversations[0].contactId).toBe(other.id);
      expect(db.messages).toHaveLength(0);
    });

    it('14b. a thread id held only by an ENCERRADA conversation of another Contact does not block: it is history', async () => {
      const other = db.commit('contacts', { tenantId: A });
      const history = db.commit('conversations', {
        tenantId: A,
        contactId: other.id,
        channel: 'WEBCHAT',
        externalConversationId: 'S1',
        state: 'ENCERRADA',
      });

      const result = await service.ingest(
        input({ channel: 'WEBCHAT', externalContactId: 'visitor-9', externalConversationId: 'S1' }),
      );

      expect(result.conversationCreated).toBe(true);
      expect(result.conversation.id).not.toBe(history.id);
      expect(result.conversation.externalConversationId).toBe('S1');
      expect(history).toMatchObject({ contactId: other.id, state: 'ENCERRADA', lastMessageAt: null }); // untouched
    });

    it('15. a thread id of ANOTHER tenant is never reused', async () => {
      const otherContact = db.commit('contacts', { tenantId: B });
      const foreign = db.commit('conversations', {
        tenantId: B,
        contactId: otherContact.id,
        channel: 'WEBCHAT',
        externalConversationId: 'S1',
      });

      const result = await service.ingest(input({ channel: 'WEBCHAT', externalConversationId: 'S1' }));

      expect(result.conversationCreated).toBe(true);
      expect(result.conversation.tenantId).toBe(A);
      expect(result.conversation.id).not.toBe(foreign.id);
      expect(result.conversation.externalConversationId).toBe('S1'); // unique is per tenant: free in A
      expect(db.messages).toEqual([expect.objectContaining({ tenantId: A })]);
      expect(foreign).toMatchObject({ tenantId: B, lastMessageAt: null });
    });

    it('a CLOSED conversation holding the thread id is not reused; the new one carries the thread id', async () => {
      const { contact, conversation: closed } = seedThread({
        channel: 'WEBCHAT',
        externalConversationId: 'S1',
        state: 'ENCERRADA',
      });
      db.identities[0].channel = 'WEBCHAT';

      const first = await service.ingest(input({ channel: 'WEBCHAT', externalConversationId: 'S1' }));

      expect(first.conversationCreated).toBe(true);
      expect(first.conversation.id).not.toBe(closed.id);
      expect(first.conversation.contactId).toBe(contact.id);
      expect(first.conversation.externalConversationId).toBe('S1'); // closed and open now share it
      expect(db.conversations.find((c) => c.id === closed.id)).toMatchObject({
        externalConversationId: 'S1',
        state: 'ENCERRADA',
        lastMessageAt: null,
      });

      // ...and the next message of the same thread reuses the new open conversation.
      const second = await service.ingest(
        input({ channel: 'WEBCHAT', externalConversationId: 'S1', externalMessageId: 'm-2' }),
      );
      expect(second.conversationCreated).toBe(false);
      expect(second.conversation.id).toBe(first.conversation.id);
      expect(db.conversations).toHaveLength(2);
    });

    it('an open conversation with a DIFFERENT thread id is reused and keeps its own anchor', async () => {
      const { conversation } = seedThread({ channel: 'WEBCHAT', externalConversationId: 'S1' });
      db.identities[0].channel = 'WEBCHAT';

      const result = await service.ingest(input({ channel: 'WEBCHAT', externalConversationId: 'S2' }));

      expect(result.conversationCreated).toBe(false);
      expect(result.conversation.id).toBe(conversation.id);
      expect(db.conversations).toHaveLength(1);
      expect(db.conversations[0].externalConversationId).toBe('S1'); // not overwritten
      expect(db.messages).toHaveLength(1); // and the message was not lost
    });

    it('an open conversation WITHOUT an anchor receives the incoming thread id (first anchor wins)', async () => {
      const { conversation } = seedThread({ channel: 'WEBCHAT' });
      db.identities[0].channel = 'WEBCHAT';

      const first = await service.ingest(input({ channel: 'WEBCHAT', externalConversationId: 'S1' }));
      expect(first.conversation.id).toBe(conversation.id);
      expect(first.conversationCreated).toBe(false);
      expect(first.conversation.externalConversationId).toBe('S1'); // returned row is the anchored one
      expect(db.conversations[0].externalConversationId).toBe('S1');

      // a later, different thread id does not overwrite it
      await service.ingest(input({ channel: 'WEBCHAT', externalConversationId: 'S2', externalMessageId: 'm-2' }));
      expect(db.conversations).toHaveLength(1);
      expect(db.conversations[0].externalConversationId).toBe('S1');
    });

    it('a message without a thread id never touches the anchor', async () => {
      seedThread({ channel: 'WEBCHAT', externalConversationId: 'S1' });
      db.identities[0].channel = 'WEBCHAT';

      await service.ingest(input({ channel: 'WEBCHAT', externalConversationId: null }));

      expect(db.conversations[0].externalConversationId).toBe('S1');
    });

    it('anchoring loses a race to ANOTHER Contact that claimed the thread: rolled back, then 409', async () => {
      const { conversation } = seedThread({ channel: 'WEBCHAT' });
      db.identities[0].channel = 'WEBCHAT';
      const rival = db.commit('contacts', { tenantId: A });
      let claimed: Row | undefined;
      db.before = (op) => {
        if (op === 'conversation.updateMany' && !claimed) {
          claimed = db.commit('conversations', {
            tenantId: A,
            contactId: rival.id,
            channel: 'WEBCHAT',
            externalConversationId: 'S1',
          });
        }
      };

      await expect(
        service.ingest(input({ channel: 'WEBCHAT', externalConversationId: 'S1' })),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(conversation.externalConversationId).toBeNull(); // our anchor did not stick
      expect(claimed!.contactId).toBe(rival.id);
      expect(db.messages).toHaveLength(0);
    });

    it('thread id claimed by an open conversation of another tenant does not interfere with anchoring', async () => {
      const foreignContact = db.commit('contacts', { tenantId: B });
      db.commit('conversations', {
        tenantId: B,
        contactId: foreignContact.id,
        channel: 'WEBCHAT',
        externalConversationId: 'S1',
      });
      const { conversation } = seedThread({ channel: 'WEBCHAT' });
      db.identities[0].channel = 'WEBCHAT';

      await service.ingest(input({ channel: 'WEBCHAT', externalConversationId: 'S1' }));

      expect(conversation.externalConversationId).toBe('S1');
    });
  });

  describe('idempotency by externalMessageId', () => {
    it('1. an already-persisted externalMessageId returns the existing result without duplicating anything', async () => {
      const first = await service.ingest(input({ contact: { name: 'Ana' } }));
      const txBefore = db.transactions;

      const again = await service.ingest(input({ contact: { name: 'Ana' } }));

      expect(again.duplicate).toBe(true);
      expect(again).toMatchObject({
        contactCreated: false,
        identityCreated: false,
        conversationCreated: false,
        messageCreated: false,
      });
      expect(again.message.id).toBe(first.message.id);
      expect(again.conversation.id).toBe(first.conversation.id);
      expect(again.contact.id).toBe(first.contact.id);
      expect([db.contacts.length, db.identities.length, db.conversations.length, db.messages.length]).toEqual([1, 1, 1, 1]);
      // only the duplicate check ran: no Contact resolution, no persist step
      expect(db.transactions - txBefore).toBe(1);
    });

    it('16. a redelivery with different content/timestamp does not overwrite: the first event wins', async () => {
      const first = await service.ingest(input({ content: 'original', occurredAt: at(10, 0) }));

      const again = await service.ingest(input({ content: 'EDITADO', occurredAt: at(11, 0) }));

      expect(again.duplicate).toBe(true);
      expect(again.message.body).toBe('original');
      expect(again.message.createdAt).toEqual(at(10, 0));
      expect(db.messages).toHaveLength(1);
      expect(db.messages[0].body).toBe('original');
      expect(db.conversations[0].lastMessageAt).toEqual(at(10, 0)); // not advanced by the replay
      expect(again.message.id).toBe(first.message.id);
    });

    it('duplicate detection is per tenant: another tenant cannot see or reuse the message', async () => {
      await service.ingest(input({ tenantId: A }));

      const b = await service.ingest(input({ tenantId: B, content: 'do tenant B' }));

      expect(b.duplicate).toBe(false);
      expect(b.message.body).toBe('do tenant B');
      expect(db.messages).toHaveLength(2);
    });

    it('rejects (409) an externalMessageId already used by ANOTHER channel instead of dropping the message', async () => {
      await service.ingest(input({ channel: 'WHATSAPP', externalMessageId: 'same-id' }));

      await expect(
        service.ingest(input({ channel: 'INSTAGRAM', externalContactId: 'ig-1', externalMessageId: 'same-id' })),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(db.messages).toHaveLength(1);
      expect(db.identities).toHaveLength(1); // rejected before any Contact resolution
    });
  });

  describe('lastMessageAt', () => {
    it('never regresses when an older message arrives after a newer one', async () => {
      await service.ingest(input({ externalMessageId: 'm-late', occurredAt: at(10, 5) }));

      const older = await service.ingest(input({ externalMessageId: 'm-early', occurredAt: at(10, 0) }));

      expect(older.message.createdAt).toEqual(at(10, 0)); // the message keeps ITS time
      expect(older.conversation.lastMessageAt).toEqual(at(10, 5)); // the conversation does not go back
      expect(db.conversations[0].lastMessageAt).toEqual(at(10, 5));
    });

    it('advances for a newer message', async () => {
      await service.ingest(input({ externalMessageId: 'm-1', occurredAt: at(10, 0) }));
      const newer = await service.ingest(input({ externalMessageId: 'm-2', occurredAt: at(10, 30) }));

      expect(newer.conversation.lastMessageAt).toEqual(at(10, 30));
    });
  });

  describe('atomicity', () => {
    it('17. a failure creating the Message rolls back the new Conversation (Contact stays, by design)', async () => {
      db.failOnce = { op: 'message.create', error: new Error('boom') };

      await expect(service.ingest(input())).rejects.toThrow('boom');

      expect(db.conversations).toHaveLength(0);
      expect(db.messages).toHaveLength(0);
      // Contact resolution committed in its own transaction; it is idempotent.
      expect(db.contacts).toHaveLength(1);
      expect(db.identities).toHaveLength(1);

      // The provider's redelivery completes normally and reuses that Contact.
      const retry = await service.ingest(input());
      expect(retry).toMatchObject({ contactCreated: false, conversationCreated: true, messageCreated: true });
      expect(db.contacts).toHaveLength(1);
    });

    it('17b. a failure advancing lastMessageAt rolls back the Message too', async () => {
      const { conversation } = seedThread({ lastMessageAt: at(9, 0) });
      db.failOnce = { op: 'conversation.updateMany', error: new Error('boom') };

      await expect(service.ingest(input({ occurredAt: at(10, 0) }))).rejects.toThrow('boom');

      expect(db.messages).toHaveLength(0);
      expect(db.conversations[0]).toBe(conversation);
      expect(db.conversations[0].lastMessageAt).toEqual(at(9, 0));
    });
  });

  describe('concurrency (lost races)', () => {
    /** Persist attempts = transactions - duplicate check - contact resolution. */
    const persistAttempts = () => db.transactions - 2;

    it('18. P2002 on the open-conversation index: rolls back, re-reads and reuses the winner', async () => {
      let winner: Row | undefined;
      db.before = (op) => {
        if (op === 'conversation.create' && !winner) {
          winner = db.commit('conversations', { tenantId: A, contactId: db.contacts[0].id, channel: 'WHATSAPP' });
        }
      };

      const result = await service.ingest(input());

      expect(result.conversation.id).toBe(winner!.id);
      expect(result).toMatchObject({ conversationCreated: false, messageCreated: true });
      expect(db.conversations).toHaveLength(1);
      expect(db.messages).toEqual([expect.objectContaining({ conversationId: winner!.id })]);
      expect(persistAttempts()).toBe(2);
    });

    it('18b. P2002 on the thread-id unique (same Contact): retry reuses the winner’s conversation', async () => {
      let winner: Row | undefined;
      db.before = (op) => {
        if (op === 'conversation.create' && !winner) {
          winner = db.commit('conversations', {
            tenantId: A,
            contactId: db.contacts[0].id,
            channel: 'WEBCHAT',
            externalConversationId: 'S1',
          });
        }
      };

      const result = await service.ingest(input({ channel: 'WEBCHAT', externalConversationId: 'S1' }));

      expect(result.conversation.id).toBe(winner!.id);
      expect(db.conversations).toHaveLength(1);
      expect(persistAttempts()).toBe(2);
    });

    it('18c. thread-id race lost to ANOTHER Contact turns into a 409 on retry, nothing reassigned', async () => {
      const other = db.commit('contacts', { tenantId: A });
      let winner: Row | undefined;
      db.before = (op) => {
        if (op === 'conversation.create' && !winner) {
          winner = db.commit('conversations', {
            tenantId: A,
            contactId: other.id,
            channel: 'WEBCHAT',
            externalConversationId: 'S1',
          });
        }
      };

      await expect(
        service.ingest(input({ channel: 'WEBCHAT', externalConversationId: 'S1' })),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(db.conversations).toEqual([winner]);
      expect(db.messages).toHaveLength(0);
    });

    it('19. P2002 on the message externalId: rolls back, re-reads and returns the winner (idempotent)', async () => {
      const { conversation } = seedThread();
      let winner: Row | undefined;
      db.before = (op) => {
        if (op === 'message.create' && !winner) {
          winner = db.commit('messages', {
            tenantId: A,
            conversationId: conversation.id,
            direction: 'INBOUND',
            status: 'DELIVERED',
            externalId: 'm-1',
            body: 'do vencedor',
          });
        }
      };

      const result = await service.ingest(input({ content: 'do perdedor' }));

      expect(result).toMatchObject({ duplicate: true, messageCreated: false, conversationCreated: false });
      expect(result.message.id).toBe(winner!.id);
      expect(result.message.body).toBe('do vencedor');
      expect(db.messages).toHaveLength(1);
      expect(persistAttempts()).toBe(2);
    });

    it('20. a P2002 that is not one of the expected races is NOT retried or masked', async () => {
      db.failOnce = { op: 'message.create', error: p2002('Contact') }; // wrong model for this statement

      await expect(service.ingest(input())).rejects.toMatchObject({ code: 'P2002' });

      expect(persistAttempts()).toBe(1);
      expect(db.conversations).toHaveLength(0);
      expect(db.messages).toHaveLength(0);
    });

    it('20b. non-unique database errors are not retried', async () => {
      db.failOnce = { op: 'conversation.create', error: new Error('connection reset') };

      await expect(service.ingest(input())).rejects.toThrow('connection reset');
      expect(persistAttempts()).toBe(1);
    });

    it('20c. losing the SAME kind of race twice stops the retries and rethrows the P2002', async () => {
      db.failAlways = { op: 'conversation.create', error: p2002('Conversation') };

      await expect(service.ingest(input())).rejects.toMatchObject({ code: 'P2002' });

      expect(persistAttempts()).toBe(2); // 1 try + 1 retry, well under the global cap
      expect(db.conversations).toHaveLength(0);
    });

    it('20d. same for message races that never resolve', async () => {
      db.failAlways = { op: 'message.create', error: p2002('Message') };

      await expect(service.ingest(input())).rejects.toMatchObject({ code: 'P2002' });

      expect(persistAttempts()).toBe(2);
      expect(db.conversations).toHaveLength(0); // rolled back with the message
    });
  });

  describe('input validation (nothing touches the database)', () => {
    it.each([
      ['blank externalMessageId', { externalMessageId: '   ' }],
      ['empty content', { content: '' }],
      ['blank externalContactId', { externalContactId: ' ' }],
      ['missing tenantId', { tenantId: '' }],
      ['unknown channel', { channel: 'TELEGRAM' as any }],
      ['invalid occurredAt', { occurredAt: new Date('nope') }],
    ])('rejects %s with 400', async (_name, over) => {
      await expect(service.ingest(input(over as Partial<ConversationIngressInput>))).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(db.transactions).toBe(0);
    });

    it('an invalid contact phone is rejected before any Contact/Conversation/Message is written', async () => {
      await expect(service.ingest(input({ contact: { phone: '12345' } }))).rejects.toBeInstanceOf(
        InvalidPhoneNumberException,
      );

      expect(db.contacts).toHaveLength(0);
      expect(db.conversations).toHaveLength(0);
      expect(db.messages).toHaveLength(0);
    });

    it('trims externalMessageId before using it as the idempotency key', async () => {
      await service.ingest(input({ externalMessageId: ' m-1 ' }));
      const again = await service.ingest(input({ externalMessageId: 'm-1' }));

      expect(again.duplicate).toBe(true);
      expect(db.messages[0].externalId).toBe('m-1');
    });
  });
});
