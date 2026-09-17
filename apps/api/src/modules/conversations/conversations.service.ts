import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConversationState, Prisma, RoleCode } from '@prisma/client';
import { writeAudit } from '../../common/audit/audit.helper';
import type { TenantContext } from '../../common/tenant/tenant-context';
import { PrismaService, TenantTx } from '../../prisma/prisma.service';
import { ListConversationsQueryDto } from './dto/list-conversations.dto';

export interface ConversationListItem {
  id: string;
  contactId: string;
  contactName: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  leadId: string | null;
  state: ConversationState;
  channel: string;
  subject: string | null;
  assignedUserId: string | null;
  assignedUserName: string | null;
  lastMessageAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationListResult {
  items: ConversationListItem[];
  total: number;
  page: number;
  pageSize: number;
}

/** Prisma include shared by list/detail so the mapper has every relation. */
const CONVERSATION_INCLUDE = {
  contact: true,
  assignedUser: true,
} satisfies Prisma.ConversationInclude;

type ConversationWithRelations = Prisma.ConversationGetPayload<{ include: typeof CONVERSATION_INCLUDE }>;

/**
 * Valid manual state transitions (PATCH /conversations/:id/state).
 *
 * HUMANO_ATENDENDO is deliberately NOT a reachable target here — a
 * conversation only enters that state as a side effect of `assign` (a human
 * cannot be "attending" without being assigned), and only leaves it via
 * `unassign` (back to AGUARDANDO_HUMANO) or by closing. This keeps
 * assignedUserId and state from ever disagreeing with each other.
 */
const ALLOWED_TRANSITIONS: Partial<Record<ConversationState, ConversationState[]>> = {
  [ConversationState.AI_ATENDENDO]: [ConversationState.AGUARDANDO_HUMANO, ConversationState.ENCERRADA],
  [ConversationState.AGUARDANDO_HUMANO]: [ConversationState.ENCERRADA],
  [ConversationState.HUMANO_ATENDENDO]: [ConversationState.ENCERRADA],
  [ConversationState.ENCERRADA]: [ConversationState.AGUARDANDO_HUMANO],
};

@Injectable()
export class ConversationsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(ctx: TenantContext, query: ListConversationsQueryDto): Promise<ConversationListResult> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    return this.prisma.runWithTenant(ctx.tenantId, async (tx) => {
      const where: Prisma.ConversationWhereInput = {
        // tenantId is enforced by RLS too, but we keep the app-level predicate.
        tenantId: ctx.tenantId,
        ...(query.state ? { state: query.state } : {}),
        ...(query.channel ? { channel: query.channel } : {}),
        ...(query.unassigned ? { assignedUserId: null } : query.assignedUserId ? { assignedUserId: query.assignedUserId } : {}),
        ...(query.search
          ? {
              contact: {
                is: {
                  OR: [
                    { name: { contains: query.search, mode: 'insensitive' } },
                    { phoneE164: { contains: query.search } },
                    { email: { contains: query.search, mode: 'insensitive' } },
                  ],
                },
              },
            }
          : {}),
      };

      const [rows, total] = await Promise.all([
        tx.conversation.findMany({
          where,
          include: CONVERSATION_INCLUDE,
          orderBy: [{ lastMessageAt: { sort: 'desc', nulls: 'last' } }, { updatedAt: 'desc' }],
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        tx.conversation.count({ where }),
      ]);

      return { items: rows.map(toConversationItem), total, page, pageSize };
    });
  }

  /** Detail. Missing and cross-tenant both yield 404 (RLS returns 0 rows). */
  async getById(ctx: TenantContext, id: string): Promise<ConversationListItem> {
    return this.prisma.runWithTenant(ctx.tenantId, async (tx) => {
      const conversation = await tx.conversation.findUnique({ where: { id }, include: CONVERSATION_INCLUDE });
      if (!conversation) throw new NotFoundException();
      return toConversationItem(conversation);
    });
  }

  /**
   * Assign or transfer the conversation to `userId` (same tenant). Also the
   * ONLY way a conversation enters HUMANO_ATENDENDO.
   *
   * RBAC (approved): ADMIN/GESTOR may (re)assign any conversation of the
   * tenant. COMERCIAL/ATENDENTE may only "assumir" an unassigned conversation
   * for THEMSELVES, or transfer a conversation that is already assigned to
   * THEM to someone else — never touch another agent's assignment.
   */
  async assign(ctx: TenantContext, id: string, userId: string): Promise<ConversationListItem> {
    return this.prisma.runWithTenant(ctx.tenantId, async (tx) => {
      const existing = await tx.conversation.findUnique({ where: { id } });
      if (!existing) throw new NotFoundException();
      if (existing.state === ConversationState.ENCERRADA) {
        throw new ConflictException('Conversa encerrada não pode ser atribuída. Reabra antes de atribuir.');
      }
      await this.assertUserInTenant(tx, userId);
      this.assertCanReassign(ctx, existing.assignedUserId, userId);

      // Concurrency guard: only succeeds if assignedUserId is still what we
      // just read. Two agents racing to "assumir" the same conversation — the
      // loser's WHERE no longer matches once the winner commits, so it
      // updates 0 rows instead of silently overwriting.
      const result = await tx.conversation.updateMany({
        where: { id, tenantId: ctx.tenantId, assignedUserId: existing.assignedUserId },
        data: { assignedUserId: userId, state: ConversationState.HUMANO_ATENDENDO },
      });
      if (result.count === 0) {
        throw new ConflictException('A conversa foi atribuída por outro atendente nesse meio tempo.');
      }

      const updated = await tx.conversation.findUnique({ where: { id }, include: CONVERSATION_INCLUDE });
      await writeAudit(tx, {
        tenantId: ctx.tenantId,
        actorId: ctx.userId,
        action: 'CONVERSATION_ASSIGNED',
        entity: 'Conversation',
        entityId: id,
        before: { assignedUserId: existing.assignedUserId },
        after: { assignedUserId: userId },
      });

      return toConversationItem(updated!);
    });
  }

  /**
   * Releases the conversation back to the pool (assignedUserId = null,
   * state -> AGUARDANDO_HUMANO if it was HUMANO_ATENDENDO). Idempotent if
   * already unassigned.
   */
  async unassign(ctx: TenantContext, id: string): Promise<ConversationListItem> {
    return this.prisma.runWithTenant(ctx.tenantId, async (tx) => {
      const existing = await tx.conversation.findUnique({ where: { id } });
      if (!existing) throw new NotFoundException();

      if (existing.assignedUserId === null) {
        const current = await tx.conversation.findUnique({ where: { id }, include: CONVERSATION_INCLUDE });
        return toConversationItem(current!);
      }
      if (!this.isManager(ctx) && existing.assignedUserId !== ctx.userId) {
        throw new ForbiddenException('Você só pode desatribuir um atendimento que já é seu.');
      }

      const result = await tx.conversation.updateMany({
        where: { id, tenantId: ctx.tenantId, assignedUserId: existing.assignedUserId },
        data: {
          assignedUserId: null,
          state: existing.state === ConversationState.HUMANO_ATENDENDO ? ConversationState.AGUARDANDO_HUMANO : existing.state,
        },
      });
      if (result.count === 0) {
        throw new ConflictException('A conversa foi alterada por outro atendente nesse meio tempo.');
      }

      const updated = await tx.conversation.findUnique({ where: { id }, include: CONVERSATION_INCLUDE });
      await writeAudit(tx, {
        tenantId: ctx.tenantId,
        actorId: ctx.userId,
        action: 'CONVERSATION_UNASSIGNED',
        entity: 'Conversation',
        entityId: id,
        before: { assignedUserId: existing.assignedUserId },
        after: { assignedUserId: null },
      });

      return toConversationItem(updated!);
    });
  }

  /**
   * Validated state transition (see ALLOWED_TRANSITIONS). Idempotent if the
   * target state equals the current one.
   *
   * RBAC (approved): closing (-> ENCERRADA) and reopening (ENCERRADA -> ...)
   * are ownership-gated for COMERCIAL/ATENDENTE — "sob sua responsabilidade"
   * — so both require assignedUserId === ctx.userId unless the caller is
   * ADMIN/GESTOR. Other transitions (e.g. AI_ATENDENDO -> AGUARDANDO_HUMANO)
   * are not ownership-sensitive and open to every role with Inbox access.
   */
  async changeState(ctx: TenantContext, id: string, targetState: ConversationState): Promise<ConversationListItem> {
    return this.prisma.runWithTenant(ctx.tenantId, async (tx) => {
      const existing = await tx.conversation.findUnique({ where: { id } });
      if (!existing) throw new NotFoundException();

      if (existing.state === targetState) {
        const current = await tx.conversation.findUnique({ where: { id }, include: CONVERSATION_INCLUDE });
        return toConversationItem(current!);
      }

      const allowed = ALLOWED_TRANSITIONS[existing.state] ?? [];
      if (!allowed.includes(targetState)) {
        throw new ConflictException(`Transição de ${existing.state} para ${targetState} não é permitida.`);
      }

      const touchesEncerrada = targetState === ConversationState.ENCERRADA || existing.state === ConversationState.ENCERRADA;
      if (touchesEncerrada && !this.isManager(ctx) && existing.assignedUserId !== ctx.userId) {
        throw new ForbiddenException('Você só pode encerrar ou reabrir um atendimento sob sua responsabilidade.');
      }

      const updated = await tx.conversation.update({
        where: { id },
        data: { state: targetState },
        include: CONVERSATION_INCLUDE,
      });

      await writeAudit(tx, {
        tenantId: ctx.tenantId,
        actorId: ctx.userId,
        action:
          targetState === ConversationState.ENCERRADA
            ? 'CONVERSATION_CLOSED'
            : existing.state === ConversationState.ENCERRADA
              ? 'CONVERSATION_REOPENED'
              : 'CONVERSATION_STATE_CHANGED',
        entity: 'Conversation',
        entityId: id,
        before: { state: existing.state },
        after: { state: targetState },
      });

      return toConversationItem(updated);
    });
  }

  // -- helpers ---------------------------------------------------------------

  private async assertUserInTenant(tx: TenantTx, userId: string): Promise<void> {
    const user = await tx.user.findUnique({ where: { id: userId } });
    if (!user) throw new BadRequestException('Usuário inválido para este tenant.');
  }

  private isManager(ctx: TenantContext): boolean {
    return ctx.roleCodes.includes(RoleCode.ADMIN) || ctx.roleCodes.includes(RoleCode.GESTOR);
  }

  private assertCanReassign(ctx: TenantContext, currentAssigneeId: string | null, targetUserId: string): void {
    if (this.isManager(ctx)) return;

    if (currentAssigneeId === null) {
      // "Assumir conversa disponível" — só para si mesmo.
      if (targetUserId !== ctx.userId) {
        throw new ForbiddenException('Só é possível assumir um atendimento disponível para si mesmo.');
      }
      return;
    }
    if (currentAssigneeId === ctx.userId) {
      // "Transferência sob sua própria responsabilidade" — pode passar para qualquer colega do tenant.
      return;
    }
    throw new ForbiddenException('Você só pode transferir um atendimento que já é seu.');
  }
}

function toConversationItem(conversation: ConversationWithRelations): ConversationListItem {
  return {
    id: conversation.id,
    contactId: conversation.contactId,
    contactName: conversation.contact.name,
    contactPhone: conversation.contact.phoneE164,
    contactEmail: conversation.contact.email,
    leadId: conversation.leadId,
    state: conversation.state,
    channel: conversation.channel,
    subject: conversation.subject,
    assignedUserId: conversation.assignedUserId,
    assignedUserName: conversation.assignedUser?.name ?? null,
    lastMessageAt: conversation.lastMessageAt?.toISOString() ?? null,
    createdAt: conversation.createdAt.toISOString(),
    updatedAt: conversation.updatedAt.toISOString(),
  };
}
