import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { LeadStatus, Prisma } from '@prisma/client';
import { writeAudit } from '../../common/audit/audit.helper';
import type { TenantContext } from '../../common/tenant/tenant-context';
import { PrismaService, TenantTx } from '../../prisma/prisma.service';
import { CreateLeadDto } from './dto/create-lead.dto';
import { ListLeadsQueryDto } from './dto/list-leads.dto';
import { UpdateLeadDto } from './dto/update-lead.dto';

export interface LeadListItem {
  id: string;
  name: string;
  company: string | null;
  email: string | null;
  phone: string | null;
  amountCents: number | null;
  status: LeadStatus;
  stageId: string;
  stageName: string;
  ownerName: string | null;
  source: string | null;
  interest: string | null;
  lastInteractionAt: string;
  nextActionAt: string | null;
  createdAt: string;
}

export interface LeadListResult {
  items: LeadListItem[];
  total: number;
  page: number;
  pageSize: number;
}

/** Prisma include shared by list/detail so the mapper has every relation. */
const LEAD_INCLUDE = {
  contact: true,
  pipelineStage: true,
  owner: true,
} satisfies Prisma.LeadInclude;

type LeadWithRelations = Prisma.LeadGetPayload<{ include: typeof LEAD_INCLUDE }>;

@Injectable()
export class LeadsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(ctx: TenantContext, query: ListLeadsQueryDto): Promise<LeadListResult> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    return this.prisma.runWithTenant(ctx.tenantId, async (tx) => {
      const where: Prisma.LeadWhereInput = {
        // tenantId is enforced by RLS too, but we keep the app-level predicate.
        tenantId: ctx.tenantId,
        ...(query.stageId ? { pipelineStageId: query.stageId } : {}),
        ...(query.ownerUserId ? { ownerUserId: query.ownerUserId } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.search
          ? {
              OR: [
                { contact: { is: { name: { contains: query.search, mode: 'insensitive' } } } },
                { interest: { contains: query.search, mode: 'insensitive' } },
              ],
            }
          : {}),
      };

      const [rows, total] = await Promise.all([
        tx.lead.findMany({
          where,
          include: LEAD_INCLUDE,
          orderBy: { updatedAt: 'desc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        tx.lead.count({ where }),
      ]);

      return { items: rows.map(toListItem), total, page, pageSize };
    });
  }

  /** Detail. Missing and cross-tenant both yield 404 (RLS returns 0 rows). */
  async getById(ctx: TenantContext, id: string): Promise<LeadListItem> {
    return this.prisma.runWithTenant(ctx.tenantId, async (tx) => {
      const lead = await tx.lead.findUnique({ where: { id }, include: LEAD_INCLUDE });
      if (!lead) throw new NotFoundException();
      return toListItem(lead);
    });
  }

  async create(ctx: TenantContext, dto: CreateLeadDto): Promise<LeadListItem> {
    return this.prisma.runWithTenant(ctx.tenantId, async (tx) => {
      const stageId = await this.resolveStageId(tx, ctx.tenantId, dto.stageId);
      if (dto.ownerUserId) await this.assertOwnerInTenant(tx, dto.ownerUserId);

      // A lead always has a contact. Create one from the provided name/email/phone.
      const contact = await tx.contact.create({
        data: {
          tenantId: ctx.tenantId,
          name: dto.name,
          email: dto.email ?? null,
          phoneE164: dto.phone ?? null,
        },
      });

      const lead = await tx.lead.create({
        data: {
          tenantId: ctx.tenantId,
          contactId: contact.id,
          pipelineStageId: stageId,
          amountCents: dto.amountCents ?? null,
          ownerUserId: dto.ownerUserId ?? null,
          source: dto.source ?? null,
          interest: dto.interest ?? this.companyToInterest(dto.company),
        },
        include: LEAD_INCLUDE,
      });

      await writeAudit(tx, {
        tenantId: ctx.tenantId,
        actorId: ctx.userId,
        action: 'LEAD_CREATED',
        entity: 'Lead',
        entityId: lead.id,
        after: { name: dto.name, stageId, amountCents: dto.amountCents ?? null },
      });

      return toListItem(lead);
    });
  }

  async update(ctx: TenantContext, id: string, dto: UpdateLeadDto): Promise<LeadListItem> {
    return this.prisma.runWithTenant(ctx.tenantId, async (tx) => {
      const existing = await tx.lead.findUnique({ where: { id } });
      if (!existing) throw new NotFoundException();
      if (dto.ownerUserId) await this.assertOwnerInTenant(tx, dto.ownerUserId);

      const data: Prisma.LeadUpdateInput = {};
      if (dto.amountCents !== undefined) data.amountCents = dto.amountCents;
      if (dto.status !== undefined) data.status = dto.status;
      if (dto.source !== undefined) data.source = dto.source;
      if (dto.interest !== undefined) data.interest = dto.interest;
      if (dto.nextActionAt !== undefined) {
        data.nextActionAt = dto.nextActionAt ? new Date(dto.nextActionAt) : null;
      }
      if (dto.ownerUserId !== undefined) {
        data.owner = { connect: { tenantId_id: { tenantId: ctx.tenantId, id: dto.ownerUserId } } };
      }

      const lead = await tx.lead.update({ where: { id }, data, include: LEAD_INCLUDE });

      await writeAudit(tx, {
        tenantId: ctx.tenantId,
        actorId: ctx.userId,
        action: 'LEAD_UPDATED',
        entity: 'Lead',
        entityId: id,
        after: { ...dto },
      });

      return toListItem(lead);
    });
  }

  /** Move a lead to another stage of the SAME tenant. */
  async moveStage(ctx: TenantContext, id: string, stageId: string): Promise<LeadListItem> {
    return this.prisma.runWithTenant(ctx.tenantId, async (tx) => {
      const existing = await tx.lead.findUnique({ where: { id } });
      if (!existing) throw new NotFoundException();

      // Stage must exist within this tenant. RLS already filters cross-tenant
      // stages to invisible, so a foreign stageId resolves to null => 400.
      const stage = await tx.pipelineStage.findUnique({ where: { id: stageId } });
      if (!stage) throw new BadRequestException('Etapa inválida para este tenant.');

      const lead = await tx.lead.update({
        where: { id },
        data: { pipelineStageId: stageId },
        include: LEAD_INCLUDE,
      });

      await writeAudit(tx, {
        tenantId: ctx.tenantId,
        actorId: ctx.userId,
        action: 'LEAD_STAGE_CHANGED',
        entity: 'Lead',
        entityId: id,
        before: { stageId: existing.pipelineStageId },
        after: { stageId },
      });

      return toListItem(lead);
    });
  }

  // -- helpers ---------------------------------------------------------------

  private async resolveStageId(
    tx: TenantTx,
    tenantId: string,
    stageId: string | undefined,
  ): Promise<string> {
    if (stageId) {
      const stage = await tx.pipelineStage.findUnique({ where: { id: stageId } });
      if (!stage) throw new BadRequestException('Etapa inválida para este tenant.');
      return stage.id;
    }
    // Fallback: first stage (lowest position) of the tenant's default pipeline.
    const stage = await tx.pipelineStage.findFirst({
      where: { tenantId },
      orderBy: [{ pipeline: { isDefault: 'desc' } }, { position: 'asc' }],
    });
    if (!stage) throw new BadRequestException('Nenhum pipeline configurado para este tenant.');
    return stage.id;
  }

  private async assertOwnerInTenant(tx: TenantTx, ownerUserId: string): Promise<void> {
    const owner = await tx.user.findUnique({ where: { id: ownerUserId } });
    if (!owner) throw new BadRequestException('Responsável inválido para este tenant.');
  }

  private companyToInterest(company: string | undefined): string | null {
    return company ? company : null;
  }
}

function toListItem(lead: LeadWithRelations): LeadListItem {
  return {
    id: lead.id,
    name: lead.contact.name ?? 'Sem nome',
    company: lead.interest ?? null,
    email: lead.contact.email ?? null,
    phone: lead.contact.phoneE164 ?? null,
    amountCents: lead.amountCents ?? null,
    status: lead.status,
    stageId: lead.pipelineStageId,
    stageName: lead.pipelineStage.name,
    ownerName: lead.owner?.name ?? null,
    source: lead.source ?? null,
    interest: lead.interest ?? null,
    lastInteractionAt: lead.updatedAt.toISOString(),
    nextActionAt: lead.nextActionAt?.toISOString() ?? null,
    createdAt: lead.createdAt.toISOString(),
  };
}
