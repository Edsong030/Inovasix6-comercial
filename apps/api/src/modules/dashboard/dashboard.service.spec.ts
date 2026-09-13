import { LeadStatus } from '@prisma/client';
import { DashboardService } from './dashboard.service';
import type { TenantContext } from '../../common/tenant/tenant-context';

/**
 * Unit tests for DashboardService. A fake tx returns controlled numbers so we
 * can assert the documented business rules (conversion, pipeline value, monthly
 * sales, funnel percent, and — since the Follow-ups/Agenda phase — that
 * followUpsToday/agendaToday/scheduledMeetings read FollowUp/CalendarEvent
 * instead of Lead.nextActionAt) rather than the DB.
 */
describe('DashboardService', () => {
  const CTX: TenantContext = { tenantId: 'tenant-a', userId: 'user-a', roleCodes: ['ADMIN'] };

  function buildService(overrides: {
    newLeads: number;
    pipelineSum: number | null;
    scheduledMeetings: number;
    monthlySalesSum: number | null;
    won: number;
    created: number;
    stages: Array<{ id: string; name: string; position: number }>;
    grouped: Array<{ pipelineStageId: string; _count: { _all: number } }>;
    followUpRows?: any[];
    agendaRows?: any[];
  }) {
    let countCall = 0;
    let aggCall = 0;
    const tx = {
      lead: {
        // count is called in order: newLeads, wonThisMonth, createdThisMonth
        count: jest.fn(async () => {
          const order = [overrides.newLeads, overrides.won, overrides.created];
          return order[countCall++] ?? 0;
        }),
        // aggregate order: pipelineValue(OPEN), monthlySales(WON)
        aggregate: jest.fn(async () => {
          const order = [
            { _sum: { amountCents: overrides.pipelineSum } },
            { _sum: { amountCents: overrides.monthlySalesSum } },
          ];
          return order[aggCall++];
        }),
        groupBy: jest.fn(async () => overrides.grouped),
      },
      calendarEvent: {
        count: jest.fn(async () => overrides.scheduledMeetings),
        findMany: jest.fn(async () => overrides.agendaRows ?? []),
      },
      followUp: {
        findMany: jest.fn(async () => overrides.followUpRows ?? []),
      },
      pipelineStage: { findMany: jest.fn(async () => overrides.stages) },
      auditLog: { findMany: jest.fn(async () => []) },
    };
    const prisma = { runWithTenant: jest.fn(async (_t: string, work: any) => work(tx)) };
    return { service: new DashboardService(prisma as any), tx };
  }

  it('computes pipeline value and monthly sales from sums', async () => {
    const { service } = buildService({
      newLeads: 10,
      pipelineSum: 2630000,
      scheduledMeetings: 3,
      monthlySalesSum: 370000,
      won: 1,
      created: 10,
      stages: [],
      grouped: [],
    });
    const summary = await service.summary(CTX);
    expect(summary.metrics.pipelineValue).toBe(2630000);
    expect(summary.metrics.monthlySales).toBe(370000);
    expect(summary.metrics.newLeads).toBe(10);
    expect(summary.metrics.scheduledMeetings).toBe(3);
  });

  it('conversion = won / created * 100 (rounded to 1 decimal)', async () => {
    const { service } = buildService({
      newLeads: 8,
      pipelineSum: 0,
      scheduledMeetings: 0,
      monthlySalesSum: 0,
      won: 1,
      created: 8,
      stages: [],
      grouped: [],
    });
    const summary = await service.summary(CTX);
    expect(summary.metrics.conversionRate).toBe(12.5);
  });

  it('conversion is 0 when no leads were created in the period', async () => {
    const { service } = buildService({
      newLeads: 0,
      pipelineSum: null,
      scheduledMeetings: 0,
      monthlySalesSum: null,
      won: 0,
      created: 0,
      stages: [],
      grouped: [],
    });
    const summary = await service.summary(CTX);
    expect(summary.metrics.conversionRate).toBe(0);
    expect(summary.metrics.pipelineValue).toBe(0);
  });

  it('BUG-001: builds funnel percentages relative to the first stage (top of funnel)', async () => {
    const { service } = buildService({
      newLeads: 0,
      pipelineSum: 0,
      scheduledMeetings: 0,
      monthlySalesSum: 0,
      won: 0,
      created: 0,
      stages: [
        { id: 's1', name: 'Novo lead', position: 0 },
        { id: 's2', name: 'Em atendimento', position: 1 },
        { id: 's3', name: 'Qualificado', position: 2 },
      ],
      grouped: [
        { pipelineStageId: 's1', _count: { _all: 10 } },
        { pipelineStageId: 's2', _count: { _all: 8 } },
        { pipelineStageId: 's3', _count: { _all: 5 } },
      ],
    });
    const summary = await service.summary(CTX);
    expect(summary.funnel[0]).toMatchObject({ label: 'Novo lead', count: 10, percent: 100 });
    expect(summary.funnel[1]).toMatchObject({ label: 'Em atendimento', count: 8, percent: 80 });
    expect(summary.funnel[2]).toMatchObject({ label: 'Qualificado', count: 5, percent: 50 });
  });

  it('funnel percent is 0 for every stage when the first stage has no leads (avoids division by zero)', async () => {
    const { service } = buildService({
      newLeads: 0,
      pipelineSum: 0,
      scheduledMeetings: 0,
      monthlySalesSum: 0,
      won: 0,
      created: 0,
      stages: [
        { id: 's1', name: 'Novo lead', position: 0 },
        { id: 's2', name: 'Em atendimento', position: 1 },
      ],
      grouped: [
        { pipelineStageId: 's1', _count: { _all: 0 } },
        { pipelineStageId: 's2', _count: { _all: 4 } },
      ],
    });
    const summary = await service.summary(CTX);
    expect(summary.funnel[0]).toMatchObject({ label: 'Novo lead', count: 0, percent: 0 });
    expect(summary.funnel[1]).toMatchObject({ label: 'Em atendimento', count: 4, percent: 0 });
    expect(Number.isFinite(summary.funnel[1].percent)).toBe(true);
  });

  it('does not cap an intermediate stage at 100% just because it outgrew the first stage', async () => {
    const { service } = buildService({
      newLeads: 0,
      pipelineSum: 0,
      scheduledMeetings: 0,
      monthlySalesSum: 0,
      won: 0,
      created: 0,
      stages: [
        { id: 's1', name: 'Novo lead', position: 0 },
        { id: 's2', name: 'Em atendimento', position: 1 },
      ],
      grouped: [
        { pipelineStageId: 's1', _count: { _all: 2 } },
        { pipelineStageId: 's2', _count: { _all: 3 } },
      ],
    });
    const summary = await service.summary(CTX);
    expect(summary.funnel[0]).toMatchObject({ label: 'Novo lead', count: 2, percent: 100 });
    // 3/2 = 150% — accurate business signal (more leads stalled downstream than
    // entering today), not clamped to 100 by the old "largest stage" rule.
    expect(summary.funnel[1]).toMatchObject({ label: 'Em atendimento', count: 3, percent: 150 });
  });

  it('references LeadStatus.WON for the sales rule (guard against enum drift)', () => {
    expect(LeadStatus.WON).toBe('WON');
  });

  describe('Follow-ups + Agenda (real entities, not Lead.nextActionAt)', () => {
    it('followUpsToday is built from FollowUp rows, using the title as the reason', async () => {
      const { service, tx } = buildService({
        newLeads: 0,
        pipelineSum: 0,
        scheduledMeetings: 0,
        monthlySalesSum: 0,
        won: 0,
        created: 0,
        stages: [],
        grouped: [],
        followUpRows: [
          {
            id: 'fu-1',
            title: 'Retornar sobre proposta',
            scheduledAt: new Date('2026-09-09T09:00:00.000Z'),
            lead: { contact: { name: 'Maria Silva' }, interest: 'Silva & Cia' },
          },
        ],
      });
      const summary = await service.summary(CTX);
      expect(summary.followUpsToday).toEqual([
        { id: 'fu-1', name: 'Maria Silva', company: 'Silva & Cia', time: expect.any(String), reason: 'Retornar sobre proposta' },
      ]);
      // Queried directly against FollowUp, not derived from Lead.nextActionAt.
      expect(tx.followUp.findMany).toHaveBeenCalled();
    });

    it('agendaToday is built from CalendarEvent rows, independently of followUpsToday', async () => {
      const { service, tx } = buildService({
        newLeads: 0,
        pipelineSum: 0,
        scheduledMeetings: 0,
        monthlySalesSum: 0,
        won: 0,
        created: 0,
        stages: [],
        grouped: [],
        followUpRows: [
          {
            id: 'fu-1',
            title: 'Follow-up qualquer',
            scheduledAt: new Date('2026-09-09T09:00:00.000Z'),
            lead: { contact: { name: 'Maria Silva' }, interest: null },
          },
        ],
        agendaRows: [{ id: 'ev-1', title: 'Demonstração da plataforma', startsAt: new Date('2026-09-09T11:00:00.000Z') }],
      });
      const summary = await service.summary(CTX);
      expect(summary.agendaToday).toEqual([{ id: 'ev-1', name: 'Demonstração da plataforma', time: expect.any(String) }]);
      // agendaToday no longer mirrors followUpsToday 1:1.
      expect(summary.agendaToday.map((a) => a.id)).not.toEqual(summary.followUpsToday.map((f) => f.id));
      expect(tx.calendarEvent.findMany).toHaveBeenCalled();
    });

    it('scheduledMeetings queries CalendarEvent filtered to type=MEETING and status=SCHEDULED', async () => {
      const { service, tx } = buildService({
        newLeads: 0,
        pipelineSum: 0,
        scheduledMeetings: 5,
        monthlySalesSum: 0,
        won: 0,
        created: 0,
        stages: [],
        grouped: [],
      });
      const summary = await service.summary(CTX);
      expect(summary.metrics.scheduledMeetings).toBe(5);
      const args = (tx.calendarEvent.count.mock.calls[0] as any[])[0];
      expect(args.where.type).toBe('MEETING');
      expect(args.where.status).toBe('SCHEDULED');
    });
  });
});
