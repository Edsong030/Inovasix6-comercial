import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { FollowUpsService } from './followups.service';
import type { TenantContext } from '../../common/tenant/tenant-context';

/**
 * Unit tests for FollowUpsService with an in-memory fake of the tenant
 * transaction. RLS is exercised by the integration suite; here we validate
 * the service logic (status transitions, nextActionAt recompute, cross-tenant
 * 400s, audit calls, mapping) — "cross-tenant" is modelled the same way
 * leads.service.spec.ts does: an id simply absent from the tenant's own map,
 * standing in for what RLS would have hidden in the real database.
 */
function matchesWhere(row: any, where: any): boolean {
  if (where.tenantId !== undefined && row.tenantId !== where.tenantId) return false;
  if (where.status !== undefined && row.status !== where.status) return false;
  if (where.leadId !== undefined && row.leadId !== where.leadId) return false;
  if (where.ownerUserId !== undefined && row.ownerUserId !== where.ownerUserId) return false;
  if (where.scheduledAt !== undefined) {
    const f = where.scheduledAt;
    const t = row.scheduledAt.getTime();
    if (f.gte !== undefined && t < f.gte.getTime()) return false;
    if (f.lte !== undefined && t > f.lte.getTime()) return false;
    if (f.lt !== undefined && t >= f.lt.getTime()) return false;
    if (f.gt !== undefined && t <= f.gt.getTime()) return false;
  }
  return true;
}

describe('FollowUpsService', () => {
  const CTX: TenantContext = { tenantId: 'tenant-a', userId: 'user-a', roleCodes: ['ADMIN'] };

  let leads: Map<string, any>;
  let users: Map<string, any>;
  let followUps: Map<string, any>;
  let audits: any[];

  function attach(row: any) {
    if (!row) return row;
    return {
      ...row,
      lead: leads.get(row.leadId),
      owner: row.ownerUserId ? users.get(row.ownerUserId) ?? null : null,
    };
  }

  function makeTx() {
    return {
      lead: {
        findUnique: jest.fn(async ({ where }: any) => leads.get(where.id) ?? null),
        update: jest.fn(async ({ where, data }: any) => {
          const row = { ...leads.get(where.id), ...data };
          leads.set(where.id, row);
          return row;
        }),
      },
      user: {
        findUnique: jest.fn(async ({ where }: any) => users.get(where.id) ?? null),
      },
      followUp: {
        create: jest.fn(async ({ data }: any) => {
          const id = `fu-${followUps.size + 1}`;
          const row = {
            id,
            tenantId: data.tenantId,
            leadId: data.leadId,
            ownerUserId: data.ownerUserId ?? null,
            title: data.title,
            description: data.description ?? null,
            type: data.type ?? 'OTHER',
            priority: data.priority ?? 'MEDIUM',
            status: 'PENDING',
            scheduledAt: data.scheduledAt,
            completedAt: null,
            canceledAt: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          followUps.set(id, row);
          return attach(row);
        }),
        findUnique: jest.fn(async ({ where }: any) => attach(followUps.get(where.id))),
        findFirst: jest.fn(async ({ where }: any) => {
          const candidates = [...followUps.values()].filter(
            (f) => f.tenantId === where.tenantId && f.leadId === where.leadId && f.status === where.status,
          );
          candidates.sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime());
          return candidates[0] ?? null;
        }),
        findMany: jest.fn(async ({ where }: any) => {
          const rows = [...followUps.values()].filter((f) => matchesWhere(f, where));
          rows.sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime());
          return rows.map(attach);
        }),
        count: jest.fn(async ({ where }: any) => {
          return [...followUps.values()].filter((f) => matchesWhere(f, where)).length;
        }),
        update: jest.fn(async ({ where, data }: any) => {
          const row = { ...followUps.get(where.id) };
          if (data.lead?.connect) row.leadId = data.lead.connect.tenantId_id.id;
          if (data.owner?.connect) row.ownerUserId = data.owner.connect.tenantId_id.id;
          for (const key of [
            'title',
            'description',
            'type',
            'priority',
            'status',
            'scheduledAt',
            'completedAt',
            'canceledAt',
          ]) {
            if (key in data) row[key] = data[key];
          }
          row.updatedAt = new Date();
          followUps.set(where.id, row);
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
  let service: FollowUpsService;

  beforeEach(() => {
    leads = new Map([
      ['lead-a', { id: 'lead-a', tenantId: 'tenant-a', contact: { name: 'Cliente A' }, interest: 'Empresa A', nextActionAt: null }],
      ['lead-a2', { id: 'lead-a2', tenantId: 'tenant-a', contact: { name: 'Cliente A2' }, interest: null, nextActionAt: null }],
    ]);
    users = new Map([['user-a', { id: 'user-a', tenantId: 'tenant-a', name: 'Ana' }]]);
    followUps = new Map();
    audits = [];
    tx = makeTx();
    prisma = { runWithTenant: jest.fn(async (_t: string, work: any) => work(tx)) };
    service = new FollowUpsService(prisma);
  });

  it('creates a follow-up as PENDING and audits it', async () => {
    const fu = await service.create(CTX, {
      leadId: 'lead-a',
      title: 'Retornar sobre proposta',
      scheduledAt: '2026-09-10T10:00:00.000Z',
    } as any);
    expect(fu.status).toBe('PENDING');
    expect(fu.leadName).toBe('Cliente A');
    expect(audits.some((a) => a.action === 'FOLLOW_UP_CREATED')).toBe(true);
  });

  it('rejects creating a follow-up for a lead of another tenant (400)', async () => {
    await expect(
      service.create(CTX, { leadId: 'lead-of-other-tenant', title: 'X', scheduledAt: '2026-09-10T10:00:00.000Z' } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects creating a follow-up with an owner of another tenant (400)', async () => {
    await expect(
      service.create(CTX, {
        leadId: 'lead-a',
        ownerUserId: 'user-of-other-tenant',
        title: 'X',
        scheduledAt: '2026-09-10T10:00:00.000Z',
      } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('returns 404 for a missing/cross-tenant follow-up on detail', async () => {
    await expect(service.getById(CTX, 'nope')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('updates fields and audits, without touching status', async () => {
    const fu = await service.create(CTX, {
      leadId: 'lead-a',
      title: 'Original',
      scheduledAt: '2026-09-10T10:00:00.000Z',
    } as any);
    const updated = await service.update(CTX, fu.id, { title: 'Novo título', priority: 'HIGH' } as any);
    expect(updated.title).toBe('Novo título');
    expect(updated.priority).toBe('HIGH');
    expect(updated.status).toBe('PENDING');
    expect(audits.some((a) => a.action === 'FOLLOW_UP_UPDATED')).toBe(true);
  });

  it('completes a PENDING follow-up: sets completedAt, clears canceledAt, audits', async () => {
    const fu = await service.create(CTX, {
      leadId: 'lead-a',
      title: 'A',
      scheduledAt: '2026-09-10T10:00:00.000Z',
    } as any);
    const completed = await service.complete(CTX, fu.id);
    expect(completed.status).toBe('COMPLETED');
    expect(completed.completedAt).not.toBeNull();
    expect(completed.canceledAt).toBeNull();
    expect(audits.some((a) => a.action === 'FOLLOW_UP_COMPLETED')).toBe(true);
  });

  it('completing an already COMPLETED follow-up is idempotent (no error, no duplicate audit)', async () => {
    const fu = await service.create(CTX, {
      leadId: 'lead-a',
      title: 'A',
      scheduledAt: '2026-09-10T10:00:00.000Z',
    } as any);
    await service.complete(CTX, fu.id);
    const auditCountAfterFirst = audits.length;
    const result = await service.complete(CTX, fu.id);
    expect(result.status).toBe('COMPLETED');
    expect(audits.length).toBe(auditCountAfterFirst);
  });

  it('rejects completing a CANCELED follow-up (invalid transition, 409)', async () => {
    const fu = await service.create(CTX, {
      leadId: 'lead-a',
      title: 'A',
      scheduledAt: '2026-09-10T10:00:00.000Z',
    } as any);
    await service.cancel(CTX, fu.id);
    await expect(service.complete(CTX, fu.id)).rejects.toBeInstanceOf(ConflictException);
  });

  it('cancels a PENDING follow-up: sets canceledAt, clears completedAt, audits', async () => {
    const fu = await service.create(CTX, {
      leadId: 'lead-a',
      title: 'A',
      scheduledAt: '2026-09-10T10:00:00.000Z',
    } as any);
    const canceled = await service.cancel(CTX, fu.id);
    expect(canceled.status).toBe('CANCELED');
    expect(canceled.canceledAt).not.toBeNull();
    expect(canceled.completedAt).toBeNull();
    expect(audits.some((a) => a.action === 'FOLLOW_UP_CANCELED')).toBe(true);
  });

  it('rejects canceling a COMPLETED follow-up (invalid transition, 409)', async () => {
    const fu = await service.create(CTX, {
      leadId: 'lead-a',
      title: 'A',
      scheduledAt: '2026-09-10T10:00:00.000Z',
    } as any);
    await service.complete(CTX, fu.id);
    await expect(service.cancel(CTX, fu.id)).rejects.toBeInstanceOf(ConflictException);
  });

  it('reschedules a PENDING follow-up and audits before/after', async () => {
    const fu = await service.create(CTX, {
      leadId: 'lead-a',
      title: 'A',
      scheduledAt: '2026-09-10T10:00:00.000Z',
    } as any);
    const rescheduled = await service.reschedule(CTX, fu.id, '2026-09-15T10:00:00.000Z');
    expect(rescheduled.scheduledAt).toBe('2026-09-15T10:00:00.000Z');
    const auditEntry = audits.find((a) => a.action === 'FOLLOW_UP_RESCHEDULED');
    expect(auditEntry.before.scheduledAt).toBe('2026-09-10T10:00:00.000Z');
    expect(auditEntry.after.scheduledAt).toBe('2026-09-15T10:00:00.000Z');
  });

  it('rejects rescheduling a non-PENDING follow-up (409)', async () => {
    const fu = await service.create(CTX, {
      leadId: 'lead-a',
      title: 'A',
      scheduledAt: '2026-09-10T10:00:00.000Z',
    } as any);
    await service.complete(CTX, fu.id);
    await expect(service.reschedule(CTX, fu.id, '2026-09-20T10:00:00.000Z')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('marks a PENDING follow-up in the past as overdue', async () => {
    const fu = await service.create(CTX, {
      leadId: 'lead-a',
      title: 'A',
      scheduledAt: '2020-01-01T10:00:00.000Z',
    } as any);
    expect(fu.overdue).toBe(true);
  });

  it('a COMPLETED follow-up is never overdue, even if scheduledAt is in the past', async () => {
    const fu = await service.create(CTX, {
      leadId: 'lead-a',
      title: 'A',
      scheduledAt: '2020-01-01T10:00:00.000Z',
    } as any);
    const completed = await service.complete(CTX, fu.id);
    expect(completed.overdue).toBe(false);
  });

  it('list(overdue=true) returns only PENDING follow-ups scheduled in the past', async () => {
    await service.create(CTX, { leadId: 'lead-a', title: 'Passado', scheduledAt: '2020-01-01T10:00:00.000Z' } as any);
    const future = await service.create(CTX, { leadId: 'lead-a', title: 'Futuro', scheduledAt: '2099-01-01T10:00:00.000Z' } as any);
    const completedPast = await service.create(CTX, { leadId: 'lead-a', title: 'Concluído', scheduledAt: '2020-01-01T10:00:00.000Z' } as any);
    await service.complete(CTX, completedPast.id);

    const result = await service.list(CTX, { overdue: true } as any);

    expect(result.items.map((i) => i.title)).toEqual(['Passado']);
    expect(result.items.some((i) => i.id === future.id)).toBe(false);
  });

  describe('Lead.nextActionAt recompute (compatibility mirror)', () => {
    it('sets nextActionAt to the earliest PENDING follow-up, regardless of creation order', async () => {
      await service.create(CTX, { leadId: 'lead-a', title: 'B (semana que vem)', scheduledAt: '2026-09-20T10:00:00.000Z' } as any);
      await service.create(CTX, { leadId: 'lead-a', title: 'A (amanhã)', scheduledAt: '2026-09-11T10:00:00.000Z' } as any);
      expect(leads.get('lead-a').nextActionAt).toEqual(new Date('2026-09-11T10:00:00.000Z'));
    });

    it('completing the earliest follow-up (A) recomputes nextActionAt to the next one (B), not null', async () => {
      const a = await service.create(CTX, { leadId: 'lead-a', title: 'A (amanhã)', scheduledAt: '2026-09-11T10:00:00.000Z' } as any);
      await service.create(CTX, { leadId: 'lead-a', title: 'B (semana que vem)', scheduledAt: '2026-09-20T10:00:00.000Z' } as any);
      expect(leads.get('lead-a').nextActionAt).toEqual(new Date('2026-09-11T10:00:00.000Z'));

      await service.complete(CTX, a.id);

      expect(leads.get('lead-a').nextActionAt).toEqual(new Date('2026-09-20T10:00:00.000Z'));
    });

    it('canceling the last PENDING follow-up sets nextActionAt to null', async () => {
      const a = await service.create(CTX, { leadId: 'lead-a', title: 'Único', scheduledAt: '2026-09-11T10:00:00.000Z' } as any);
      expect(leads.get('lead-a').nextActionAt).not.toBeNull();

      await service.cancel(CTX, a.id);

      expect(leads.get('lead-a').nextActionAt).toBeNull();
    });

    it('rescheduling recomputes nextActionAt across multiple follow-ups on the same lead', async () => {
      const a = await service.create(CTX, { leadId: 'lead-a', title: 'A', scheduledAt: '2026-09-11T10:00:00.000Z' } as any);
      await service.create(CTX, { leadId: 'lead-a', title: 'B', scheduledAt: '2026-09-20T10:00:00.000Z' } as any);

      // Push A further out than B — B should now become the earliest.
      await service.reschedule(CTX, a.id, '2026-09-25T10:00:00.000Z');

      expect(leads.get('lead-a').nextActionAt).toEqual(new Date('2026-09-20T10:00:00.000Z'));
    });

    it('reassigning a follow-up to another lead recomputes both leads', async () => {
      const fu = await service.create(CTX, { leadId: 'lead-a', title: 'A', scheduledAt: '2026-09-11T10:00:00.000Z' } as any);
      expect(leads.get('lead-a').nextActionAt).not.toBeNull();
      expect(leads.get('lead-a2').nextActionAt).toBeNull();

      await service.update(CTX, fu.id, { leadId: 'lead-a2' } as any);

      expect(leads.get('lead-a').nextActionAt).toBeNull();
      expect(leads.get('lead-a2').nextActionAt).toEqual(new Date('2026-09-11T10:00:00.000Z'));
    });
  });
});
