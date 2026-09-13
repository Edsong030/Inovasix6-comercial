import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { CalendarEventsService } from './calendar-events.service';
import type { TenantContext } from '../../common/tenant/tenant-context';

/**
 * Unit tests for CalendarEventsService, mirroring the FollowUpsService suite.
 * "Cross-tenant" is modelled as an id absent from the tenant's own map,
 * standing in for what RLS would have hidden in the real database.
 */
describe('CalendarEventsService', () => {
  const CTX: TenantContext = { tenantId: 'tenant-a', userId: 'user-a', roleCodes: ['ADMIN'] };

  let leads: Map<string, any>;
  let users: Map<string, any>;
  let events: Map<string, any>;
  let audits: any[];

  function attach(row: any) {
    if (!row) return row;
    return {
      ...row,
      lead: row.leadId ? leads.get(row.leadId) : null,
      owner: row.ownerUserId ? users.get(row.ownerUserId) ?? null : null,
    };
  }

  function matchesWhere(row: any, where: any): boolean {
    if (where.tenantId !== undefined && row.tenantId !== where.tenantId) return false;
    if (where.status !== undefined && row.status !== where.status) return false;
    if (where.leadId !== undefined && row.leadId !== where.leadId) return false;
    if (where.ownerUserId !== undefined && row.ownerUserId !== where.ownerUserId) return false;
    if (where.startsAt !== undefined) {
      const f = where.startsAt;
      const t = row.startsAt.getTime();
      if (f.gte !== undefined && t < f.gte.getTime()) return false;
      if (f.lte !== undefined && t > f.lte.getTime()) return false;
    }
    return true;
  }

  function makeTx() {
    return {
      lead: {
        findUnique: jest.fn(async ({ where }: any) => leads.get(where.id) ?? null),
      },
      user: {
        findUnique: jest.fn(async ({ where }: any) => users.get(where.id) ?? null),
      },
      calendarEvent: {
        create: jest.fn(async ({ data }: any) => {
          const id = `ev-${events.size + 1}`;
          const row = {
            id,
            tenantId: data.tenantId,
            leadId: data.leadId ?? null,
            ownerUserId: data.ownerUserId ?? null,
            title: data.title,
            description: data.description ?? null,
            type: data.type ?? 'MEETING',
            status: 'SCHEDULED',
            startsAt: data.startsAt,
            endsAt: data.endsAt ?? null,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          events.set(id, row);
          return attach(row);
        }),
        findUnique: jest.fn(async ({ where }: any) => attach(events.get(where.id))),
        findMany: jest.fn(async ({ where }: any) => {
          const rows = [...events.values()].filter((e) => matchesWhere(e, where));
          rows.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
          return rows.map(attach);
        }),
        count: jest.fn(async ({ where }: any) => [...events.values()].filter((e) => matchesWhere(e, where)).length),
        update: jest.fn(async ({ where, data }: any) => {
          const row = { ...events.get(where.id) };
          if (data.lead?.connect) row.leadId = data.lead.connect.tenantId_id.id;
          if (data.owner?.connect) row.ownerUserId = data.owner.connect.tenantId_id.id;
          for (const key of ['title', 'description', 'type', 'status', 'startsAt', 'endsAt']) {
            if (key in data) row[key] = data[key];
          }
          row.updatedAt = new Date();
          events.set(where.id, row);
          return attach(row);
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
  let service: CalendarEventsService;

  beforeEach(() => {
    leads = new Map([['lead-a', { id: 'lead-a', tenantId: 'tenant-a', contact: { name: 'Cliente A' }, interest: 'Empresa A' }]]);
    users = new Map([['user-a', { id: 'user-a', tenantId: 'tenant-a', name: 'Ana' }]]);
    events = new Map();
    audits = [];
    tx = makeTx();
    prisma = { runWithTenant: jest.fn(async (_t: string, work: any) => work(tx)) };
    service = new CalendarEventsService(prisma);
  });

  it('creates an event as SCHEDULED and audits it', async () => {
    const ev = await service.create(CTX, {
      title: 'Reunião comercial',
      startsAt: '2026-09-10T10:00:00.000Z',
    } as any);
    expect(ev.status).toBe('SCHEDULED');
    expect(ev.leadId).toBeNull();
    expect(audits.some((a) => a.action === 'CALENDAR_EVENT_CREATED')).toBe(true);
  });

  it('creates an event without a lead (lead is optional)', async () => {
    const ev = await service.create(CTX, { title: 'Bloqueio interno', startsAt: '2026-09-10T10:00:00.000Z' } as any);
    expect(ev.leadId).toBeNull();
    expect(ev.leadName).toBeNull();
  });

  it('associates a lead of the same tenant', async () => {
    const ev = await service.create(CTX, {
      leadId: 'lead-a',
      title: 'Demo',
      startsAt: '2026-09-10T10:00:00.000Z',
    } as any);
    expect(ev.leadName).toBe('Cliente A');
  });

  it('rejects a lead of another tenant (400)', async () => {
    await expect(
      service.create(CTX, { leadId: 'lead-of-other-tenant', title: 'X', startsAt: '2026-09-10T10:00:00.000Z' } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an owner of another tenant (400)', async () => {
    await expect(
      service.create(CTX, {
        ownerUserId: 'user-of-other-tenant',
        title: 'X',
        startsAt: '2026-09-10T10:00:00.000Z',
      } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an endsAt before startsAt (400)', async () => {
    await expect(
      service.create(CTX, {
        title: 'X',
        startsAt: '2026-09-10T10:00:00.000Z',
        endsAt: '2026-09-10T09:00:00.000Z',
      } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('returns 404 for a missing/cross-tenant event on detail', async () => {
    await expect(service.getById(CTX, 'nope')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('updates fields and re-validates the interval when startsAt/endsAt change', async () => {
    const ev = await service.create(CTX, {
      title: 'Original',
      startsAt: '2026-09-10T10:00:00.000Z',
      endsAt: '2026-09-10T11:00:00.000Z',
    } as any);
    const updated = await service.update(CTX, ev.id, { title: 'Atualizado' } as any);
    expect(updated.title).toBe('Atualizado');
    expect(audits.some((a) => a.action === 'CALENDAR_EVENT_UPDATED')).toBe(true);

    await expect(
      service.update(CTX, ev.id, { startsAt: '2026-09-10T12:00:00.000Z' } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('completes a SCHEDULED event and audits it', async () => {
    const ev = await service.create(CTX, { title: 'X', startsAt: '2026-09-10T10:00:00.000Z' } as any);
    const completed = await service.complete(CTX, ev.id);
    expect(completed.status).toBe('COMPLETED');
    expect(audits.some((a) => a.action === 'CALENDAR_EVENT_COMPLETED')).toBe(true);
  });

  it('completing an already COMPLETED event is idempotent', async () => {
    const ev = await service.create(CTX, { title: 'X', startsAt: '2026-09-10T10:00:00.000Z' } as any);
    await service.complete(CTX, ev.id);
    const auditCount = audits.length;
    const result = await service.complete(CTX, ev.id);
    expect(result.status).toBe('COMPLETED');
    expect(audits.length).toBe(auditCount);
  });

  it('rejects completing a CANCELED event (409)', async () => {
    const ev = await service.create(CTX, { title: 'X', startsAt: '2026-09-10T10:00:00.000Z' } as any);
    await service.cancel(CTX, ev.id);
    await expect(service.complete(CTX, ev.id)).rejects.toBeInstanceOf(ConflictException);
  });

  it('cancels a SCHEDULED event and audits it', async () => {
    const ev = await service.create(CTX, { title: 'X', startsAt: '2026-09-10T10:00:00.000Z' } as any);
    const canceled = await service.cancel(CTX, ev.id);
    expect(canceled.status).toBe('CANCELED');
    expect(audits.some((a) => a.action === 'CALENDAR_EVENT_CANCELED')).toBe(true);
  });

  it('rejects canceling a COMPLETED event (409)', async () => {
    const ev = await service.create(CTX, { title: 'X', startsAt: '2026-09-10T10:00:00.000Z' } as any);
    await service.complete(CTX, ev.id);
    await expect(service.cancel(CTX, ev.id)).rejects.toBeInstanceOf(ConflictException);
  });
});
