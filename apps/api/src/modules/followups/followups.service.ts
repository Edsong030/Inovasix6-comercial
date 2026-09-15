import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { FollowUpStatus, Prisma } from '@prisma/client';
import { writeAudit } from '../../common/audit/audit.helper';
import type { TenantContext } from '../../common/tenant/tenant-context';
import { PrismaService, TenantTx } from '../../prisma/prisma.service';
import { CreateFollowUpDto } from './dto/create-followup.dto';
import { ListFollowUpsQueryDto } from './dto/list-followups.dto';
import { UpdateFollowUpDto } from './dto/update-followup.dto';

export interface FollowUpItem {
  id: string;
  leadId: string;
  leadName: string;
  leadCompany: string | null;
  ownerUserId: string | null;
  ownerName: string | null;
  title: string;
  description: string | null;
  type: string;
  priority: string;
  status: string;
  scheduledAt: string;
  completedAt: string | null;
  canceledAt: string | null;
  /** Derived: status = PENDING AND scheduledAt < now. Not stored. */
  overdue: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface FollowUpListResult {
  items: FollowUpItem[];
  total: number;
  page: number;
  pageSize: number;
}

/** Prisma include shared by list/detail so the mapper has every relation. */
const FOLLOWUP_INCLUDE = {
  lead: { include: { contact: true } },
  owner: true,
} satisfies Prisma.FollowUpInclude;

type FollowUpWithRelations = Prisma.FollowUpGetPayload<{ include: typeof FOLLOWUP_INCLUDE }>;

@Injectable()
export class FollowUpsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(ctx: TenantContext, query: ListFollowUpsQueryDto): Promise<FollowUpListResult> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    return this.prisma.runWithTenant(ctx.tenantId, async (tx) => {
      const overdue = query.overdue === true;
      const scheduledAt: Prisma.DateTimeFilter | undefined = overdue
        ? { lt: new Date() }
        : query.from || query.to
          ? {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            }
          : undefined;

      const where: Prisma.FollowUpWhereInput = {
        // tenantId is enforced by RLS too, but we keep the app-level predicate.
        tenantId: ctx.tenantId,
        status: overdue ? FollowUpStatus.PENDING : query.status,
        ...(query.leadId ? { leadId: query.leadId } : {}),
        ...(query.ownerUserId ? { ownerUserId: query.ownerUserId } : {}),
        ...(scheduledAt ? { scheduledAt } : {}),
      };

      const [rows, total] = await Promise.all([
        tx.followUp.findMany({
          where,
          include: FOLLOWUP_INCLUDE,
          orderBy: { scheduledAt: 'asc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        tx.followUp.count({ where }),
      ]);

      return { items: rows.map(toFollowUpItem), total, page, pageSize };
    });
  }

  /** Detail. Missing and cross-tenant both yield 404 (RLS returns 0 rows). */
  async getById(ctx: TenantContext, id: string): Promise<FollowUpItem> {
    return this.prisma.runWithTenant(ctx.tenantId, async (tx) => {
      const followUp = await tx.followUp.findUnique({ where: { id }, include: FOLLOWUP_INCLUDE });
      if (!followUp) throw new NotFoundException();
      return toFollowUpItem(followUp);
    });
  }

  async create(ctx: TenantContext, dto: CreateFollowUpDto): Promise<FollowUpItem> {
    return this.prisma.runWithTenant(ctx.tenantId, async (tx) => {
      await this.assertLeadInTenant(tx, dto.leadId);
      if (dto.ownerUserId) await this.assertOwnerInTenant(tx, dto.ownerUserId);

      const followUp = await tx.followUp.create({
        data: {
          tenantId: ctx.tenantId,
          leadId: dto.leadId,
          ownerUserId: dto.ownerUserId ?? null,
          title: dto.title,
          description: dto.description ?? null,
          type: dto.type,
          priority: dto.priority,
          scheduledAt: new Date(dto.scheduledAt),
        },
        include: FOLLOWUP_INCLUDE,
      });

      await writeAudit(tx, {
        tenantId: ctx.tenantId,
        actorId: ctx.userId,
        action: 'FOLLOW_UP_CREATED',
        entity: 'FollowUp',
        entityId: followUp.id,
        after: { leadId: dto.leadId, title: dto.title, scheduledAt: dto.scheduledAt },
      });

      await this.recomputeNextActionAt(tx, ctx.tenantId, dto.leadId);

      return toFollowUpItem(followUp);
    });
  }

  async update(ctx: TenantContext, id: string, dto: UpdateFollowUpDto): Promise<FollowUpItem> {
    return this.prisma.runWithTenant(ctx.tenantId, async (tx) => {
      const existing = await tx.followUp.findUnique({ where: { id } });
      if (!existing) throw new NotFoundException();
      if (dto.leadId) await this.assertLeadInTenant(tx, dto.leadId);
      if (dto.ownerUserId) await this.assertOwnerInTenant(tx, dto.ownerUserId);

      const data: Prisma.FollowUpUpdateInput = {};
      if (dto.leadId !== undefined) data.lead = { connect: { tenantId_id: { tenantId: ctx.tenantId, id: dto.leadId } } };
      if (dto.ownerUserId !== undefined) {
        data.owner = { connect: { tenantId_id: { tenantId: ctx.tenantId, id: dto.ownerUserId } } };
      }
      if (dto.title !== undefined) data.title = dto.title;
      if (dto.description !== undefined) data.description = dto.description;
      if (dto.type !== undefined) data.type = dto.type;
      if (dto.priority !== undefined) data.priority = dto.priority;

      const followUp = await tx.followUp.update({ where: { id }, data, include: FOLLOWUP_INCLUDE });

      await writeAudit(tx, {
        tenantId: ctx.tenantId,
        actorId: ctx.userId,
        action: 'FOLLOW_UP_UPDATED',
        entity: 'FollowUp',
        entityId: id,
        after: { ...dto },
      });

      // Reassigning the lead can change the "next follow-up" of BOTH leads.
      if (dto.leadId && dto.leadId !== existing.leadId) {
        await this.recomputeNextActionAt(tx, ctx.tenantId, existing.leadId);
      }
      await this.recomputeNextActionAt(tx, ctx.tenantId, followUp.leadId);

      return toFollowUpItem(followUp);
    });
  }

  /** PENDING -> COMPLETED. Idempotent if already COMPLETED; rejects CANCELED -> COMPLETED. */
  async complete(ctx: TenantContext, id: string): Promise<FollowUpItem> {
    return this.prisma.runWithTenant(ctx.tenantId, async (tx) => {
      const existing = await tx.followUp.findUnique({ where: { id } });
      if (!existing) throw new NotFoundException();

      if (existing.status === FollowUpStatus.COMPLETED) {
        const current = await tx.followUp.findUnique({ where: { id }, include: FOLLOWUP_INCLUDE });
        return toFollowUpItem(current!);
      }
      if (existing.status === FollowUpStatus.CANCELED) {
        throw new ConflictException('Follow-up cancelado não pode ser concluído.');
      }

      const followUp = await tx.followUp.update({
        where: { id },
        data: { status: FollowUpStatus.COMPLETED, completedAt: new Date(), canceledAt: null },
        include: FOLLOWUP_INCLUDE,
      });

      await writeAudit(tx, {
        tenantId: ctx.tenantId,
        actorId: ctx.userId,
        action: 'FOLLOW_UP_COMPLETED',
        entity: 'FollowUp',
        entityId: id,
        before: { status: existing.status },
        after: { status: FollowUpStatus.COMPLETED },
      });

      await this.recomputeNextActionAt(tx, ctx.tenantId, followUp.leadId);

      return toFollowUpItem(followUp);
    });
  }

  /** PENDING -> CANCELED. Idempotent if already CANCELED; rejects COMPLETED -> CANCELED. */
  async cancel(ctx: TenantContext, id: string): Promise<FollowUpItem> {
    return this.prisma.runWithTenant(ctx.tenantId, async (tx) => {
      const existing = await tx.followUp.findUnique({ where: { id } });
      if (!existing) throw new NotFoundException();

      if (existing.status === FollowUpStatus.CANCELED) {
        const current = await tx.followUp.findUnique({ where: { id }, include: FOLLOWUP_INCLUDE });
        return toFollowUpItem(current!);
      }
      if (existing.status === FollowUpStatus.COMPLETED) {
        throw new ConflictException('Follow-up concluído não pode ser cancelado.');
      }

      const followUp = await tx.followUp.update({
        where: { id },
        data: { status: FollowUpStatus.CANCELED, canceledAt: new Date(), completedAt: null },
        include: FOLLOWUP_INCLUDE,
      });

      await writeAudit(tx, {
        tenantId: ctx.tenantId,
        actorId: ctx.userId,
        action: 'FOLLOW_UP_CANCELED',
        entity: 'FollowUp',
        entityId: id,
        before: { status: existing.status },
        after: { status: FollowUpStatus.CANCELED },
      });

      await this.recomputeNextActionAt(tx, ctx.tenantId, followUp.leadId);

      return toFollowUpItem(followUp);
    });
  }

  /** Only a PENDING follow-up may be rescheduled. */
  async reschedule(ctx: TenantContext, id: string, scheduledAt: string): Promise<FollowUpItem> {
    return this.prisma.runWithTenant(ctx.tenantId, async (tx) => {
      const existing = await tx.followUp.findUnique({ where: { id } });
      if (!existing) throw new NotFoundException();
      if (existing.status !== FollowUpStatus.PENDING) {
        throw new ConflictException('Somente follow-ups pendentes podem ser reagendados.');
      }

      const followUp = await tx.followUp.update({
        where: { id },
        data: { scheduledAt: new Date(scheduledAt) },
        include: FOLLOWUP_INCLUDE,
      });

      await writeAudit(tx, {
        tenantId: ctx.tenantId,
        actorId: ctx.userId,
        action: 'FOLLOW_UP_RESCHEDULED',
        entity: 'FollowUp',
        entityId: id,
        before: { scheduledAt: existing.scheduledAt.toISOString() },
        after: { scheduledAt },
      });

      await this.recomputeNextActionAt(tx, ctx.tenantId, followUp.leadId);

      return toFollowUpItem(followUp);
    });
  }

  // -- helpers ---------------------------------------------------------------

  private async assertLeadInTenant(tx: TenantTx, leadId: string): Promise<void> {
    const lead = await tx.lead.findUnique({ where: { id: leadId } });
    if (!lead) throw new BadRequestException('Lead inválido para este tenant.');
  }

  private async assertOwnerInTenant(tx: TenantTx, ownerUserId: string): Promise<void> {
    const owner = await tx.user.findUnique({ where: { id: ownerUserId } });
    if (!owner) throw new BadRequestException('Responsável inválido para este tenant.');
  }

  /**
   * The real source of truth is FollowUp; Lead.nextActionAt is kept as a
   * compatibility mirror (read by the CRM/Leads screens). Always recompute
   * the FULL next-pending-follow-up for the lead — never copy the date of
   * the follow-up that was just touched, since completing/canceling/moving
   * one follow-up can leave an EARLIER or LATER one as the new "next".
   */
  private async recomputeNextActionAt(tx: TenantTx, tenantId: string, leadId: string): Promise<void> {
    const next = await tx.followUp.findFirst({
      where: { tenantId, leadId, status: FollowUpStatus.PENDING },
      orderBy: { scheduledAt: 'asc' },
    });
    await tx.lead.update({
      where: { id: leadId },
      data: { nextActionAt: next?.scheduledAt ?? null },
    });
  }
}

function toFollowUpItem(followUp: FollowUpWithRelations): FollowUpItem {
  const overdue = followUp.status === FollowUpStatus.PENDING && followUp.scheduledAt < new Date();
  return {
    id: followUp.id,
    leadId: followUp.leadId,
    leadName: followUp.lead.contact.name ?? 'Sem nome',
    leadCompany: followUp.lead.interest ?? null,
    ownerUserId: followUp.ownerUserId,
    ownerName: followUp.owner?.name ?? null,
    title: followUp.title,
    description: followUp.description ?? null,
    type: followUp.type,
    priority: followUp.priority,
    status: followUp.status,
    scheduledAt: followUp.scheduledAt.toISOString(),
    completedAt: followUp.completedAt?.toISOString() ?? null,
    canceledAt: followUp.canceledAt?.toISOString() ?? null,
    overdue,
    createdAt: followUp.createdAt.toISOString(),
    updatedAt: followUp.updatedAt.toISOString(),
  };
}
