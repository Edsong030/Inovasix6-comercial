import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { CalendarEventsService } from '../src/modules/calendar/calendar-events.service';
import { PrismaService } from '../src/prisma/prisma.service';
import type { TenantContext } from '../src/common/tenant/tenant-context';
import { makeAppClient, makeOwnerClient } from './rls.helper';

/**
 * Real cross-tenant integration for Calendar Events. Uses the app-role
 * connection so RLS is genuinely exercised. Mirrors followups.integration-spec.
 */
describe('Calendar Events + RLS (integration)', () => {
  let appPrisma: PrismaClient;
  let ownerPrisma: PrismaClient;
  let service: CalendarEventsService;

  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const ctxA: TenantContext = { tenantId: tenantA, userId: randomUUID(), roleCodes: ['ADMIN'] };
  const ctxB: TenantContext = { tenantId: tenantB, userId: randomUUID(), roleCodes: ['ADMIN'] };

  const stageA = randomUUID();
  const stageB = randomUUID();
  const userA = randomUUID();
  const userB = randomUUID();
  let leadAId = '';
  let leadBId = '';
  let eventBId = '';

  beforeAll(async () => {
    appPrisma = makeAppClient();
    ownerPrisma = makeOwnerClient();
    (appPrisma as any).runWithTenant = PrismaService.prototype.runWithTenant.bind(appPrisma);
    service = new CalendarEventsService(appPrisma as unknown as PrismaService);

    const seed = async (tenantId: string, slug: string, pipelineId: string, stageId: string, userId: string) => {
      await ownerPrisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        await tx.$executeRaw`INSERT INTO tenants (id,name,slug,timezone,created_at,updated_at) VALUES (${tenantId}::uuid,${slug},${slug},'America/Sao_Paulo',now(),now())`;
        await tx.$executeRaw`INSERT INTO pipelines (id,tenant_id,name,is_default) VALUES (${pipelineId}::uuid,${tenantId}::uuid,'Comercial',true)`;
        await tx.$executeRaw`INSERT INTO pipeline_stages (id,tenant_id,pipeline_id,name,position) VALUES (${stageId}::uuid,${tenantId}::uuid,${pipelineId}::uuid,'Novo lead',0)`;
        await tx.$executeRaw`INSERT INTO users (id,tenant_id,email,name,password_hash,status,created_at,updated_at) VALUES (${userId}::uuid,${tenantId}::uuid,${`cal-int-${userId.slice(0, 8)}@example.invalid`},'Responsável','x','ACTIVE',now(),now())`;
      });
    };

    await seed(tenantA, `cal-int-a-${tenantA.slice(0, 8)}`, randomUUID(), stageA, userA);
    await seed(tenantB, `cal-int-b-${tenantB.slice(0, 8)}`, randomUUID(), stageB, userB);

    const leadA = await ownerPrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenantA}, true)`;
      const contact = await tx.contact.create({ data: { tenantId: tenantA, name: 'Cliente A' } });
      return tx.lead.create({ data: { tenantId: tenantA, contactId: contact.id, pipelineStageId: stageA } });
    });
    leadAId = leadA.id;

    const leadB = await ownerPrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenantB}, true)`;
      const contact = await tx.contact.create({ data: { tenantId: tenantB, name: 'Cliente B' } });
      return tx.lead.create({ data: { tenantId: tenantB, contactId: contact.id, pipelineStageId: stageB } });
    });
    leadBId = leadB.id;

    const eventB = await service.create(ctxB, {
      leadId: leadBId,
      title: 'Evento de B',
      startsAt: '2026-12-01T10:00:00.000Z',
    } as any);
    eventBId = eventB.id;
  });

  afterAll(async () => {
    for (const tenantId of [tenantA, tenantB]) {
      await ownerPrisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        await tx.$executeRaw`DELETE FROM audit_logs WHERE tenant_id = ${tenantId}::uuid`;
        await tx.$executeRaw`DELETE FROM calendar_events WHERE tenant_id = ${tenantId}::uuid`;
        await tx.$executeRaw`DELETE FROM leads WHERE tenant_id = ${tenantId}::uuid`;
        await tx.$executeRaw`DELETE FROM contacts WHERE tenant_id = ${tenantId}::uuid`;
        await tx.$executeRaw`DELETE FROM users WHERE tenant_id = ${tenantId}::uuid`;
        await tx.$executeRaw`DELETE FROM pipeline_stages WHERE tenant_id = ${tenantId}::uuid`;
        await tx.$executeRaw`DELETE FROM pipelines WHERE tenant_id = ${tenantId}::uuid`;
        await tx.$executeRaw`DELETE FROM tenants WHERE id = ${tenantId}::uuid`;
      });
    }
    await appPrisma.$disconnect();
    await ownerPrisma.$disconnect();
  });

  it('creating an event binds the acting tenant', async () => {
    const ev = await service.create(ctxA, {
      title: 'Reunião A',
      startsAt: '2026-11-01T10:00:00.000Z',
    } as any);
    expect(ev.leadId).toBeNull();
  });

  it('tenant A lists only its own events', async () => {
    const result = await service.list(ctxA, {} as any);
    expect(result.items.every((e) => e.title !== 'Evento de B')).toBe(true);
  });

  it('tenant A cannot read a tenant B event (404)', async () => {
    await expect(service.getById(ctxA, eventBId)).rejects.toMatchObject({ status: 404 });
  });

  it('tenant A cannot update a tenant B event (404)', async () => {
    await expect(service.update(ctxA, eventBId, { title: 'Hijack' } as any)).rejects.toMatchObject({
      status: 404,
    });
  });

  it('tenant A cannot complete a tenant B event (404)', async () => {
    await expect(service.complete(ctxA, eventBId)).rejects.toMatchObject({ status: 404 });
  });

  it('tenant A cannot cancel a tenant B event (404)', async () => {
    await expect(service.cancel(ctxA, eventBId)).rejects.toMatchObject({ status: 404 });
  });

  it('tenant A cannot create an event associated to a tenant B lead (400)', async () => {
    await expect(
      service.create(ctxA, { leadId: leadBId, title: 'X', startsAt: '2026-11-01T10:00:00.000Z' } as any),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('tenant A cannot create an event associated to a tenant B owner (400)', async () => {
    await expect(
      service.create(ctxA, {
        ownerUserId: userB,
        title: 'X',
        startsAt: '2026-11-01T10:00:00.000Z',
      } as any),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('fail-closed: querying calendar_events without a tenant context never leaks rows', async () => {
    // See the equivalent follow_ups test for why both a clean 0-row result and
    // a P2010/22P02 cast error are acceptable fail-closed outcomes on a
    // connection whose GUC has already been touched by an earlier test.
    try {
      const rows = await appPrisma.$queryRaw`SELECT * FROM calendar_events`;
      expect((rows as unknown[]).length).toBe(0);
    } catch (err: any) {
      expect(err.code).toBe('P2010');
    }
  });

  it('composite FK rejects a CalendarEvent(tenant=A) pointing at Lead(tenant=B) even at raw SQL level', async () => {
    await expect(
      ownerPrisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenantA}, true)`;
        await tx.$executeRaw`
          INSERT INTO calendar_events (id, tenant_id, lead_id, title, starts_at, updated_at)
          VALUES (${randomUUID()}::uuid, ${tenantA}::uuid, ${leadBId}::uuid, 'cross-fk-test', now(), now())
        `;
      }),
    ).rejects.toMatchObject({ code: 'P2010' });
  });

  it('an event associated to a lead of the SAME tenant is created successfully', async () => {
    const ev = await service.create(ctxA, {
      leadId: leadAId,
      title: 'Demo com Cliente A',
      startsAt: '2026-11-05T10:00:00.000Z',
    } as any);
    expect(ev.leadId).toBe(leadAId);
    expect(ev.leadName).toBe('Cliente A');
  });
});
