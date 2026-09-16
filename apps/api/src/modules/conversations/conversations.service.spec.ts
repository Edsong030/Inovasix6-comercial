import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ConversationState, RoleCode } from '@prisma/client';
import type { TenantContext } from '../../common/tenant/tenant-context';
import { ConversationsService } from './conversations.service';

/**
 * Unit tests for ConversationsService with an in-memory fake of the tenant
 * transaction — same approach as followups.service.spec.ts. RLS/cross-tenant
 * isolation is exercised by the integration suite; here we validate service
 * logic: filters, state-transition rules, and the RBAC ownership rules for
 * assign/unassign/close/reopen approved for COMERCIAL/ATENDENTE.
 */
function matchesWhere(row: any, where: any): boolean {
  if (where.tenantId !== undefined && row.tenantId !== where.tenantId) return false;
  if (where.state !== undefined && row.state !== where.state) return false;
  if (where.channel !== undefined && row.channel !== where.channel) return false;
  if (where.assignedUserId !== undefined && row.assignedUserId !== where.assignedUserId) return false;
  return true;
}

describe('ConversationsService', () => {
  const ADMIN_CTX: TenantContext = { tenantId: 'tenant-a', userId: 'admin-a', roleCodes: [RoleCode.ADMIN] };
  const ATENDENTE_CTX: TenantContext = { tenantId: 'tenant-a', userId: 'atendente-a', roleCodes: [RoleCode.ATENDENTE] };
  const OTHER_ATENDENTE_CTX: TenantContext = { tenantId: 'tenant-a', userId: 'atendente-b', roleCodes: [RoleCode.ATENDENTE] };

  let contacts: Map<string, any>;
  let users: Map<string, any>;
  let conversations: Map<string, any>;
  let audits: any[];

  function attach(row: any) {
    if (!row) return row;
    return {
      ...row,
      contact: contacts.get(row.contactId),
      assignedUser: row.assignedUserId ? (users.get(row.assignedUserId) ?? null) : null,
    };
  }

  function makeTx() {
    return {
      user: {
        findUnique: jest.fn(async ({ where }: any) => users.get(where.id) ?? null),
      },
      conversation: {
        findUnique: jest.fn(async ({ where }: any) => attach(conversations.get(where.id))),
        findMany: jest.fn(async ({ where, skip, take }: any) => {
          const rows = [...conversations.values()].filter((c) => matchesWhere(c, where));
          rows.sort((a, b) => {
            const at = a.lastMessageAt ? a.lastMessageAt.getTime() : -Infinity;
            const bt = b.lastMessageAt ? b.lastMessageAt.getTime() : -Infinity;
            return bt - at;
          });
          return rows.slice(skip ?? 0, (skip ?? 0) + (take ?? rows.length)).map(attach);
        }),
        count: jest.fn(async ({ where }: any) => [...conversations.values()].filter((c) => matchesWhere(c, where)).length),
        update: jest.fn(async ({ where, data }: any) => {
          const row = { ...conversations.get(where.id), ...data, updatedAt: new Date() };
          conversations.set(where.id, row);
          return attach(row);
        }),
        updateMany: jest.fn(async ({ where, data }: any) => {
          const row = conversations.get(where.id);
          if (!row || row.assignedUserId !== where.assignedUserId) return { count: 0 };
          conversations.set(where.id, { ...row, ...data, updatedAt: new Date() });
          return { count: 1 };
        }),
      },
      auditLog: {
        create: jest.fn(async ({ data }: any) => {
          audits.push(data);
          return data;
        }),
      },
    };
  }

  let tx: ReturnType<typeof makeTx>;
  let prisma: any;
  let service: ConversationsService;

  beforeEach(() => {
    contacts = new Map([['contact-a', { id: 'contact-a', name: 'Cliente A', phoneE164: '+5511900000000', email: 'a@x.test' }]]);
    users = new Map([
      ['atendente-a', { id: 'atendente-a', tenantId: 'tenant-a', name: 'Atendente A' }],
      ['atendente-b', { id: 'atendente-b', tenantId: 'tenant-a', name: 'Atendente B' }],
    ]);
    conversations = new Map([
      [
        'conv-1',
        {
          id: 'conv-1',
          tenantId: 'tenant-a',
          contactId: 'contact-a',
          leadId: null,
          state: ConversationState.AGUARDANDO_HUMANO,
          channel: 'MANUAL',
          subject: null,
          assignedUserId: null,
          lastMessageAt: null,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          updatedAt: new Date('2026-01-01T00:00:00.000Z'),
        },
      ],
    ]);
    audits = [];
    tx = makeTx();
    prisma = { runWithTenant: jest.fn(async (_t: string, work: any) => work(tx)) };
    service = new ConversationsService(prisma);
  });

  describe('list/getById', () => {
    it('lists conversations of the tenant', async () => {
      const result = await service.list(ADMIN_CTX, {} as any);
      expect(result.items).toHaveLength(1);
      expect(result.items[0].contactName).toBe('Cliente A');
    });

    it('returns 404 for a missing/cross-tenant conversation', async () => {
      await expect(service.getById(ADMIN_CTX, 'nope')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('filters by unassigned=true', async () => {
      conversations.set('conv-2', { ...conversations.get('conv-1'), id: 'conv-2', assignedUserId: 'atendente-a' });
      const result = await service.list(ADMIN_CTX, { unassigned: true } as any);
      expect(result.items.map((i) => i.id)).toEqual(['conv-1']);
    });
  });

  describe('assign — RBAC ownership rules', () => {
    it('ATENDENTE can assume (self-assign) an unassigned conversation', async () => {
      const result = await service.assign(ATENDENTE_CTX, 'conv-1', 'atendente-a');
      expect(result.assignedUserId).toBe('atendente-a');
      expect(result.state).toBe(ConversationState.HUMANO_ATENDENDO);
      expect(audits.some((a) => a.action === 'CONVERSATION_ASSIGNED')).toBe(true);
    });

    it('ATENDENTE cannot assign an unassigned conversation to someone else (403)', async () => {
      await expect(service.assign(ATENDENTE_CTX, 'conv-1', 'atendente-b')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('ATENDENTE who owns the conversation can transfer it to a colleague', async () => {
      await service.assign(ATENDENTE_CTX, 'conv-1', 'atendente-a');
      const result = await service.assign(ATENDENTE_CTX, 'conv-1', 'atendente-b');
      expect(result.assignedUserId).toBe('atendente-b');
    });

    it('ATENDENTE cannot transfer a conversation owned by a different agent (403)', async () => {
      await service.assign(ATENDENTE_CTX, 'conv-1', 'atendente-a');
      await expect(
        service.assign(OTHER_ATENDENTE_CTX, 'conv-1', 'atendente-b'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('ADMIN/GESTOR can assign or transfer any conversation of the tenant', async () => {
      await service.assign(ATENDENTE_CTX, 'conv-1', 'atendente-a');
      const result = await service.assign(ADMIN_CTX, 'conv-1', 'atendente-b');
      expect(result.assignedUserId).toBe('atendente-b');
    });

    it('rejects assigning a closed (ENCERRADA) conversation (409)', async () => {
      conversations.set('conv-1', { ...conversations.get('conv-1'), state: ConversationState.ENCERRADA });
      await expect(service.assign(ADMIN_CTX, 'conv-1', 'atendente-a')).rejects.toBeInstanceOf(ConflictException);
    });

    it('surfaces a concurrent reassignment as 409 when the conditional update matches 0 rows', async () => {
      tx.conversation.updateMany.mockResolvedValueOnce({ count: 0 });
      await expect(service.assign(ADMIN_CTX, 'conv-1', 'atendente-a')).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('unassign — RBAC ownership rules', () => {
    it('is idempotent when already unassigned', async () => {
      const result = await service.unassign(ADMIN_CTX, 'conv-1');
      expect(result.assignedUserId).toBeNull();
    });

    it('owner ATENDENTE can unassign their own conversation, state returns to AGUARDANDO_HUMANO', async () => {
      await service.assign(ATENDENTE_CTX, 'conv-1', 'atendente-a');
      const result = await service.unassign(ATENDENTE_CTX, 'conv-1');
      expect(result.assignedUserId).toBeNull();
      expect(result.state).toBe(ConversationState.AGUARDANDO_HUMANO);
    });

    it('a different ATENDENTE cannot unassign someone else\'s conversation (403)', async () => {
      await service.assign(ATENDENTE_CTX, 'conv-1', 'atendente-a');
      await expect(service.unassign(OTHER_ATENDENTE_CTX, 'conv-1')).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('changeState', () => {
    it('allows a valid transition (AI_ATENDENDO -> AGUARDANDO_HUMANO)', async () => {
      conversations.set('conv-1', { ...conversations.get('conv-1'), state: ConversationState.AI_ATENDENDO });
      const result = await service.changeState(ADMIN_CTX, 'conv-1', ConversationState.AGUARDANDO_HUMANO);
      expect(result.state).toBe(ConversationState.AGUARDANDO_HUMANO);
    });

    it('rejects an invalid transition (AGUARDANDO_HUMANO -> HUMANO_ATENDENDO) with 409', async () => {
      await expect(
        service.changeState(ADMIN_CTX, 'conv-1', ConversationState.HUMANO_ATENDENDO),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('is idempotent when the target state equals the current one', async () => {
      const before = audits.length;
      const result = await service.changeState(ADMIN_CTX, 'conv-1', ConversationState.AGUARDANDO_HUMANO);
      expect(result.state).toBe(ConversationState.AGUARDANDO_HUMANO);
      expect(audits.length).toBe(before);
    });

    it('owner ATENDENTE can close (encerrar) their own conversation', async () => {
      await service.assign(ATENDENTE_CTX, 'conv-1', 'atendente-a');
      const result = await service.changeState(ATENDENTE_CTX, 'conv-1', ConversationState.ENCERRADA);
      expect(result.state).toBe(ConversationState.ENCERRADA);
      expect(audits.some((a) => a.action === 'CONVERSATION_CLOSED')).toBe(true);
    });

    it('ATENDENTE cannot close a conversation that is not theirs (403)', async () => {
      await service.assign(ATENDENTE_CTX, 'conv-1', 'atendente-a');
      await expect(
        service.changeState(OTHER_ATENDENTE_CTX, 'conv-1', ConversationState.ENCERRADA),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('ATENDENTE cannot close an unassigned conversation (403) — must assume it first', async () => {
      await expect(
        service.changeState(ATENDENTE_CTX, 'conv-1', ConversationState.ENCERRADA),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('ADMIN can close any conversation regardless of assignment', async () => {
      const result = await service.changeState(ADMIN_CTX, 'conv-1', ConversationState.ENCERRADA);
      expect(result.state).toBe(ConversationState.ENCERRADA);
    });

    it('owner ATENDENTE can reopen (reabrir) their own closed conversation', async () => {
      await service.assign(ATENDENTE_CTX, 'conv-1', 'atendente-a');
      await service.changeState(ATENDENTE_CTX, 'conv-1', ConversationState.ENCERRADA);
      const result = await service.changeState(ATENDENTE_CTX, 'conv-1', ConversationState.AGUARDANDO_HUMANO);
      expect(result.state).toBe(ConversationState.AGUARDANDO_HUMANO);
      expect(audits.some((a) => a.action === 'CONVERSATION_REOPENED')).toBe(true);
    });

    it('a different ATENDENTE cannot reopen a colleague\'s closed conversation (403)', async () => {
      await service.assign(ATENDENTE_CTX, 'conv-1', 'atendente-a');
      await service.changeState(ATENDENTE_CTX, 'conv-1', ConversationState.ENCERRADA);
      await expect(
        service.changeState(OTHER_ATENDENTE_CTX, 'conv-1', ConversationState.AGUARDANDO_HUMANO),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('returns 404 for a missing/cross-tenant conversation', async () => {
      await expect(
        service.changeState(ADMIN_CTX, 'nope', ConversationState.ENCERRADA),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
