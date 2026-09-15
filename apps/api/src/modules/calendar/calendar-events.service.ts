import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { CalendarEventStatus, CalendarEventType, Prisma } from '@prisma/client';
import { writeAudit } from '../../common/audit/audit.helper';
import type { TenantContext } from '../../common/tenant/tenant-context';
import { PrismaService, TenantTx } from '../../prisma/prisma.service';
import { CreateCalendarEventDto } from './dto/create-calendar-event.dto';
import { ListCalendarEventsQueryDto } from './dto/list-calendar-events.dto';
import { UpdateCalendarEventDto } from './dto/update-calendar-event.dto';

export interface CalendarEventItem {
  id: string;
  leadId: string | null;
  leadName: string | null;
  ownerUserId: string | null;
  ownerName: string | null;
  title: string;
  description: string | null;
  type: string;
  status: string;
  startsAt: string;
  endsAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CalendarEventListResult {
  items: CalendarEventItem[];
  total: number;
  page: number;
  pageSize: number;
}

/** Prisma include shared by list/detail so the mapper has every relation. */
const CALENDAR_EVENT_INCLUDE = {
  lead: { include: { contact: true } },
  owner: true,
} satisfies Prisma.CalendarEventInclude;

type CalendarEventWithRelations = Prisma.CalendarEventGetPayload<{ include: typeof CALENDAR_EVENT_INCLUDE }>;

@Injectable()
export class CalendarEventsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(ctx: TenantContext, query: ListCalendarEventsQueryDto): Promise<CalendarEventListResult> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    return this.prisma.runWithTenant(ctx.tenantId, async (tx) => {
      const where: Prisma.CalendarEventWhereInput = {
        tenantId: ctx.tenantId,
        status: query.status,
        ...(query.leadId ? { leadId: query.leadId } : {}),
        ...(query.ownerUserId ? { ownerUserId: query.ownerUserId } : {}),
        ...(query.from || query.to
          ? {
              startsAt: {
                ...(query.from ? { gte: new Date(query.from) } : {}),
                ...(query.to ? { lte: new Date(query.to) } : {}),
              },
            }
          : {}),
      };

      const [rows, total] = await Promise.all([
        tx.calendarEvent.findMany({
          where,
          include: CALENDAR_EVENT_INCLUDE,
          orderBy: { startsAt: 'asc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        tx.calendarEvent.count({ where }),
      ]);

      return { items: rows.map(toCalendarEventItem), total, page, pageSize };
    });
  }

  /** Detail. Missing and cross-tenant both yield 404 (RLS returns 0 rows). */
  async getById(ctx: TenantContext, id: string): Promise<CalendarEventItem> {
    return this.prisma.runWithTenant(ctx.tenantId, async (tx) => {
      const event = await tx.calendarEvent.findUnique({ where: { id }, include: CALENDAR_EVENT_INCLUDE });
      if (!event) throw new NotFoundException();
      return toCalendarEventItem(event);
    });
  }

  async create(ctx: TenantContext, dto: CreateCalendarEventDto): Promise<CalendarEventItem> {
    return this.prisma.runWithTenant(ctx.tenantId, async (tx) => {
      if (dto.leadId) await this.assertLeadInTenant(tx, dto.leadId);
      if (dto.ownerUserId) await this.assertOwnerInTenant(tx, dto.ownerUserId);

      const startsAt = new Date(dto.startsAt);
      const endsAt = dto.endsAt ? new Date(dto.endsAt) : null;
      this.assertInterval(startsAt, endsAt);

      const event = await tx.calendarEvent.create({
        data: {
          tenantId: ctx.tenantId,
          leadId: dto.leadId ?? null,
          ownerUserId: dto.ownerUserId ?? null,
          title: dto.title,
          description: dto.description ?? null,
          type: dto.type ?? CalendarEventType.MEETING,
          startsAt,
          endsAt,
        },
        include: CALENDAR_EVENT_INCLUDE,
      });

      await writeAudit(tx, {
        tenantId: ctx.tenantId,
        actorId: ctx.userId,
        action: 'CALENDAR_EVENT_CREATED',
        entity: 'CalendarEvent',
        entityId: event.id,
        after: { leadId: dto.leadId ?? null, title: dto.title, startsAt: dto.startsAt },
      });

      return toCalendarEventItem(event);
    });
  }

  async update(ctx: TenantContext, id: string, dto: UpdateCalendarEventDto): Promise<CalendarEventItem> {
    return this.prisma.runWithTenant(ctx.tenantId, async (tx) => {
      const existing = await tx.calendarEvent.findUnique({ where: { id } });
      if (!existing) throw new NotFoundException();
      if (dto.leadId) await this.assertLeadInTenant(tx, dto.leadId);
      if (dto.ownerUserId) await this.assertOwnerInTenant(tx, dto.ownerUserId);

      const nextStartsAt = dto.startsAt ? new Date(dto.startsAt) : existing.startsAt;
      const nextEndsAt = dto.endsAt !== undefined ? (dto.endsAt ? new Date(dto.endsAt) : null) : existing.endsAt;
      if (dto.startsAt !== undefined || dto.endsAt !== undefined) {
        this.assertInterval(nextStartsAt, nextEndsAt);
      }

      const data: Prisma.CalendarEventUpdateInput = {};
      if (dto.leadId !== undefined) data.lead = { connect: { tenantId_id: { tenantId: ctx.tenantId, id: dto.leadId } } };
      if (dto.ownerUserId !== undefined) {
        data.owner = { connect: { tenantId_id: { tenantId: ctx.tenantId, id: dto.ownerUserId } } };
      }
      if (dto.title !== undefined) data.title = dto.title;
      if (dto.description !== undefined) data.description = dto.description;
      if (dto.type !== undefined) data.type = dto.type;
      if (dto.startsAt !== undefined) data.startsAt = nextStartsAt;
      if (dto.endsAt !== undefined) data.endsAt = nextEndsAt;

      const event = await tx.calendarEvent.update({ where: { id }, data, include: CALENDAR_EVENT_INCLUDE });

      await writeAudit(tx, {
        tenantId: ctx.tenantId,
        actorId: ctx.userId,
        action: 'CALENDAR_EVENT_UPDATED',
        entity: 'CalendarEvent',
        entityId: id,
        after: { ...dto },
      });

      return toCalendarEventItem(event);
    });
  }

  /** SCHEDULED -> COMPLETED. Idempotent if already COMPLETED; rejects CANCELED -> COMPLETED. */
  async complete(ctx: TenantContext, id: string): Promise<CalendarEventItem> {
    return this.prisma.runWithTenant(ctx.tenantId, async (tx) => {
      const existing = await tx.calendarEvent.findUnique({ where: { id } });
      if (!existing) throw new NotFoundException();

      if (existing.status === CalendarEventStatus.COMPLETED) {
        const current = await tx.calendarEvent.findUnique({ where: { id }, include: CALENDAR_EVENT_INCLUDE });
        return toCalendarEventItem(current!);
      }
      if (existing.status === CalendarEventStatus.CANCELED) {
        throw new ConflictException('Evento cancelado não pode ser concluído.');
      }

      const event = await tx.calendarEvent.update({
        where: { id },
        data: { status: CalendarEventStatus.COMPLETED },
        include: CALENDAR_EVENT_INCLUDE,
      });

      await writeAudit(tx, {
        tenantId: ctx.tenantId,
        actorId: ctx.userId,
        action: 'CALENDAR_EVENT_COMPLETED',
        entity: 'CalendarEvent',
        entityId: id,
        before: { status: existing.status },
        after: { status: CalendarEventStatus.COMPLETED },
      });

      return toCalendarEventItem(event);
    });
  }

  /** SCHEDULED -> CANCELED. Idempotent if already CANCELED; rejects COMPLETED -> CANCELED. */
  async cancel(ctx: TenantContext, id: string): Promise<CalendarEventItem> {
    return this.prisma.runWithTenant(ctx.tenantId, async (tx) => {
      const existing = await tx.calendarEvent.findUnique({ where: { id } });
      if (!existing) throw new NotFoundException();

      if (existing.status === CalendarEventStatus.CANCELED) {
        const current = await tx.calendarEvent.findUnique({ where: { id }, include: CALENDAR_EVENT_INCLUDE });
        return toCalendarEventItem(current!);
      }
      if (existing.status === CalendarEventStatus.COMPLETED) {
        throw new ConflictException('Evento concluído não pode ser cancelado.');
      }

      const event = await tx.calendarEvent.update({
        where: { id },
        data: { status: CalendarEventStatus.CANCELED },
        include: CALENDAR_EVENT_INCLUDE,
      });

      await writeAudit(tx, {
        tenantId: ctx.tenantId,
        actorId: ctx.userId,
        action: 'CALENDAR_EVENT_CANCELED',
        entity: 'CalendarEvent',
        entityId: id,
        before: { status: existing.status },
        after: { status: CalendarEventStatus.CANCELED },
      });

      return toCalendarEventItem(event);
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

  private assertInterval(startsAt: Date, endsAt: Date | null): void {
    if (endsAt && endsAt < startsAt) {
      throw new BadRequestException('endsAt não pode ser anterior a startsAt.');
    }
  }
}

function toCalendarEventItem(event: CalendarEventWithRelations): CalendarEventItem {
  return {
    id: event.id,
    leadId: event.leadId,
    leadName: event.lead?.contact.name ?? null,
    ownerUserId: event.ownerUserId,
    ownerName: event.owner?.name ?? null,
    title: event.title,
    description: event.description ?? null,
    type: event.type,
    status: event.status,
    startsAt: event.startsAt.toISOString(),
    endsAt: event.endsAt?.toISOString() ?? null,
    createdAt: event.createdAt.toISOString(),
    updatedAt: event.updatedAt.toISOString(),
  };
}
