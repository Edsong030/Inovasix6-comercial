import { Prisma } from '@prisma/client';

/**
 * TEST-ONLY. In-memory stand-in for the tenant transaction (PrismaService.
 * runWithTenant) that behaves like Postgres where the conversation flows care
 * (READ COMMITTED):
 *  - writes stay pending until the transaction commits; a throw rolls back
 *    everything, including in-place UPDATEs (undo log)
 *  - unique constraints raise a real Prisma P2002 with `meta.target = null`
 *    (what the installed Prisma reports): conversations_open_per_contact_channel,
 *    conversations_open_external_conversation_id, messages (tenant, external_id)
 *  - composite FKs keep conversations/messages inside their tenant; RLS: a
 *    transaction only sees/writes rows of the tenant it was opened for
 *  - updateMany is a conditional UPDATE: the WHERE is evaluated on the current
 *    row, which is what makes compare-and-set claims work
 * Real concurrency is proven against Postgres in the *.integration-spec.ts files.
 */

export type Row = Record<string, any>;
export type Table = 'contacts' | 'identities' | 'conversations' | 'messages' | 'audits';

export function p2002(modelName: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the (not available)', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { modelName, target: null },
  });
}

export class FakeDb {
  contacts: Row[] = [];
  identities: Row[] = [];
  conversations: Row[] = [];
  messages: Row[] = [];
  audits: Row[] = [];
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
      audits: {},
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
        const pending: Record<Table, Row[]> = { contacts: [], identities: [], conversations: [], messages: [], audits: [] };
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
        findUnique: async ({ where }: any) => {
          guard('conversation.findUnique');
          return visible('conversations').find((c) => c.id === where.id) ?? null;
        },
        update: async ({ where, data }: any) => {
          guard('conversation.update');
          const row = visible('conversations').find((c) => c.id === where.id);
          if (!row) throw new Error('Record to update not found');
          const before = { ...row };
          Object.assign(row, data, { updatedAt: new Date() });
          undo.push(() => Object.assign(row, before));
          return row;
        },
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
            if (typeof where.state === 'string' && c.state !== where.state) return false;
            if (where.state?.not && c.state === where.state.not) return false;
            if ('assignedUserId' in where && c.assignedUserId !== where.assignedUserId) return false;
            if (where.channel?.in && !where.channel.in.includes(c.channel)) return false;
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
      auditLog: {
        create: async ({ data }: any) => {
          guard('audit.create');
          rls(data);
          return insert('audits', { id: this.id('audits'), createdAt: new Date(), ...data });
        },
      },
    };
  }
}
