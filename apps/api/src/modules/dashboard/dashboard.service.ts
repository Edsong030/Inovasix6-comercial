import { Injectable } from '@nestjs/common';
import { CalendarEventStatus, CalendarEventType, FollowUpStatus, LeadStatus } from '@prisma/client';
import type { TenantContext } from '../../common/tenant/tenant-context';
import { PrismaService, TenantTx } from '../../prisma/prisma.service';

export interface DashboardSummary {
  metrics: {
    newLeads: number;
    pipelineValue: number;
    scheduledMeetings: number;
    monthlySales: number;
    conversionRate: number;
  };
  funnel: Array<{ id: string; label: string; count: number; percent: number }>;
  followUpsToday: Array<{ id: string; name: string; company: string | null; time: string; reason: string }>;
  agendaToday: Array<{ id: string; name: string; time: string }>;
  recentActivity: Array<{ id: string; action: string; entity: string; entityId: string | null; time: string }>;
}

/**
 * Read-only dashboard aggregates, all tenant-scoped via runWithTenant (RLS).
 *
 * Business rules (documented per the spec):
 *  - newLeads: leads created in the current month.
 *  - pipelineValue: sum(amountCents) of OPEN leads (not yet won/lost).
 *  - scheduledMeetings: CalendarEvent rows with status=SCHEDULED, type=MEETING,
 *    startsAt >= now. Filtered to MEETING specifically because the card is
 *    labelled "Reuniões agendadas" — a CALL/TASK/OTHER event is not a meeting.
 *  - monthlySales: sum(amountCents) of leads WON with updatedAt in this month.
 *  - conversionRate: leadsWonThisMonth / leadsCreatedThisMonth * 100.
 *  - followUpsToday: FollowUp rows with status=PENDING, scheduledAt today.
 *  - agendaToday: CalendarEvent rows with status=SCHEDULED, startsAt today.
 *
 * followUpsToday/agendaToday/scheduledMeetings now read FollowUp/CalendarEvent
 * (real entities) instead of Lead.nextActionAt. Lead.nextActionAt is kept as a
 * compatibility mirror for the CRM/Leads screens (see FollowUpsService); it is
 * no longer read by this service. funnel/pipelineValue/monthlySales/
 * conversionRate/newLeads/recentActivity are unchanged.
 *
 * TIMEZONE DEBT: dayStart/monthStart use the Node process's local timezone
 * (`new Date(y, m, d)`), not the tenant's configured timezone (Tenant.timezone
 * exists but isn't consulted). This is pre-existing behaviour, unchanged here
 * — a formal per-tenant timezone strategy is future work.
 */
@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async summary(ctx: TenantContext): Promise<DashboardSummary> {
    return this.prisma.runWithTenant(ctx.tenantId, async (tx) => {
      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

      const [
        newLeads,
        pipelineAgg,
        scheduledMeetings,
        monthlySalesAgg,
        wonThisMonth,
        createdThisMonth,
        funnel,
        followUpRows,
        agendaRows,
        activity,
      ] = await Promise.all([
        tx.lead.count({ where: { createdAt: { gte: monthStart } } }),
        tx.lead.aggregate({ _sum: { amountCents: true }, where: { status: LeadStatus.OPEN } }),
        tx.calendarEvent.count({
          where: { status: CalendarEventStatus.SCHEDULED, type: CalendarEventType.MEETING, startsAt: { gte: now } },
        }),
        tx.lead.aggregate({
          _sum: { amountCents: true },
          where: { status: LeadStatus.WON, updatedAt: { gte: monthStart } },
        }),
        tx.lead.count({ where: { status: LeadStatus.WON, updatedAt: { gte: monthStart } } }),
        tx.lead.count({ where: { createdAt: { gte: monthStart } } }),
        this.buildFunnel(tx),
        tx.followUp.findMany({
          where: { status: FollowUpStatus.PENDING, scheduledAt: { gte: dayStart, lt: dayEnd } },
          include: { lead: { include: { contact: true } } },
          orderBy: { scheduledAt: 'asc' },
          take: 8,
        }),
        tx.calendarEvent.findMany({
          where: { status: CalendarEventStatus.SCHEDULED, startsAt: { gte: dayStart, lt: dayEnd } },
          orderBy: { startsAt: 'asc' },
          take: 8,
        }),
        tx.auditLog.findMany({ orderBy: { createdAt: 'desc' }, take: 6 }),
      ]);

      const conversionRate =
        createdThisMonth > 0 ? Math.round((wonThisMonth / createdThisMonth) * 1000) / 10 : 0;

      const followUpsToday = followUpRows.map((fu) => ({
        id: fu.id,
        name: fu.lead.contact.name ?? 'Sem nome',
        company: fu.lead.interest ?? null,
        time: formatTime(fu.scheduledAt),
        reason: fu.title,
      }));

      const agendaToday = agendaRows.map((ev) => ({
        id: ev.id,
        name: ev.title,
        time: formatTime(ev.startsAt),
      }));

      return {
        metrics: {
          newLeads,
          pipelineValue: pipelineAgg._sum.amountCents ?? 0,
          scheduledMeetings,
          monthlySales: monthlySalesAgg._sum.amountCents ?? 0,
          conversionRate,
        },
        funnel,
        followUpsToday,
        agendaToday,
        recentActivity: activity.map((a) => ({
          id: a.id,
          action: a.action,
          entity: a.entity,
          entityId: a.entityId,
          time: a.createdAt.toISOString(),
        })),
      };
    });
  }

  /** Funnel: count of leads per stage of the default pipeline, ordered. */
  private async buildFunnel(tx: TenantTx) {
    const stages = await tx.pipelineStage.findMany({
      orderBy: [{ pipeline: { isDefault: 'desc' } }, { position: 'asc' }],
    });

    // One grouped count instead of N per-stage queries (avoids N+1).
    const grouped = await tx.lead.groupBy({
      by: ['pipelineStageId'],
      _count: { _all: true },
    });
    const countByStage = new Map(grouped.map((g) => [g.pipelineStageId, g._count._all]));

    // Percent is relative to the top of the funnel (first stage), not the
    // largest stage — an intermediate stage accumulating more leads than the
    // entry stage should not read as 100%.
    const first = stages[0] ? countByStage.get(stages[0].id) ?? 0 : 0;

    return stages.map((s) => {
      const count = countByStage.get(s.id) ?? 0;
      return {
        id: s.id,
        label: s.name,
        count,
        percent: first > 0 ? Math.round((count / first) * 100) : 0,
      };
    });
  }
}

function formatTime(date: Date | null): string {
  if (!date) return '';
  return date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}
