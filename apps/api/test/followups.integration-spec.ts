import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { FollowUpsService } from '../src/modules/followups/followups.service';
import { PrismaService } from '../src/prisma/prisma.service';
import type { TenantContext } from '../src/common/tenant/tenant-context';
import { makeAppClient, makeOwnerClient } from './rls.helper';

/**
 * Real cross-tenant integration for Follow-ups. Uses the app-role connection
 * so RLS is genuinely exercised. BLOCKER-level guarantees:
 *  - tenant A sees/touches only its own follow-ups;
 *  - tenant A cannot read/update/complete/cancel/reschedule a tenant B
 *    follow-up (404 / no effect);
 *  - a follow-up can never be created against a lead or owner of another
 *    tenant (composite FK + app-level 400);
 *  - Lead.nextActionAt is recomputed to the earliest PENDING follow-up.
 */
describe('Follow-ups + RLS (integration)', () => {
  let appPrisma: PrismaClient;
  let ownerPrisma: PrismaClient;
  let service: FollowUpsService;

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
  let followUpBId = '';

  beforeAll(async () => {
    appPrisma = makeAppClient();
    ownerPrisma = makeOwnerClient();
    (appPrisma as any).runWithTenant = PrismaService.prototype.runWithTenant.bind(appPrisma);
    service = new FollowUpsService(appPrisma as unknown as PrismaService);

    const seed = async (tenantId: string, slug: string, pipelineId: string, stageId: string, userId: string) => {
      await ownerPrisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        await tx.$executeRaw`INSERT INTO tenants (id,name,slug,timezone,created_at,updated_at) VALUES (${tenantId}::uuid,${slug},${slug},'America/Sao_Paulo',now(),now())`;
        await tx.$executeRaw`INSERT INTO pipelines (id,tenant_id,name,is_default) VALUES (${pipelineId}::uuid,${tenantId}::uuid,'Comercial',true)`;
        await tx.$executeRaw`INSERT INTO pipeline_stages (id,tenant_id,pipeline_id,name,position) VALUES (${stageId}::uuid,${tenantId}::uuid,${pipelineId}::uuid,'Novo lead',0)`;
        await tx.$executeRaw`INSERT INTO users (id,tenant_id,email,name,password_hash,status,created_at,updated_at) VALUES (${userId}::uuid,${tenantId}::uuid,${`fu-int-${userId.slice(0, 8)}@example.invalid`},'Responsável', 'x','ACTIVE',now(),now())`;
      });
    };

    await seed(tenantA, `fu-int-a-${tenantA.slice(0, 8)}`, randomUUID(), stageA, userA);
    await seed(tenantB, `fu-int-b-${tenantB.slice(0, 8)}`, randomUUID(), stageB, userB);

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

    const followUpB = await service.create(ctxB, {
      leadId: leadBId,
      title: 'Follow-up de B',
      scheduledAt: '2026-12-01T10:00:00.000Z',
    } as any);
    followUpBId = followUpB.id;
  });

  afterAll(async () => {
    for (const tenantId of [tenantA, tenantB]) {
      await ownerPrisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        await tx.$executeRaw`DELETE FROM audit_logs WHERE tenant_id = ${tenantId}::uuid`;
        await tx.$executeRaw`DELETE FROM follow_ups WHERE tenant_id = ${tenantId}::uuid`;
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

  it('creating a follow-up binds the acting tenant and recomputes Lead.nextActionAt', async () => {
    const fu = await service.create(ctxA, {
      leadId: leadAId,
      title: 'Retomar contato',
      scheduledAt: '2026-11-01T10:00:00.000Z',
    } as any);
    expect(fu.leadId).toBe(leadAId);

    const lead = await ownerPrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenantA}, true)`;
      return tx.lead.findUnique({ where: { id: leadAId } });
    });
    expect(lead?.nextActionAt?.toISOString()).toBe('2026-11-01T10:00:00.000Z');
  });

  it('tenant A lists only its own follow-ups', async () => {
    const result = await service.list(ctxA, {} as any);
    expect(result.items.every((f) => f.title !== 'Follow-up de B')).toBe(true);
  });

  it('tenant A cannot read a tenant B follow-up (404)', async () => {
    await expect(service.getById(ctxA, followUpBId)).rejects.toMatchObject({ status: 404 });
  });

  it('tenant A cannot update a tenant B follow-up (404)', async () => {
    await expect(service.update(ctxA, followUpBId, { title: 'Hijack' } as any)).rejects.toMatchObject({
      status: 404,
    });
  });

  it('tenant A cannot complete a tenant B follow-up (404)', async () => {
    await expect(service.complete(ctxA, followUpBId)).rejects.toMatchObject({ status: 404 });
  });

  it('tenant A cannot cancel a tenant B follow-up (404)', async () => {
    await expect(service.cancel(ctxA, followUpBId)).rejects.toMatchObject({ status: 404 });
  });

  it('tenant A cannot reschedule a tenant B follow-up (404)', async () => {
    await expect(
      service.reschedule(ctxA, followUpBId, '2027-01-01T10:00:00.000Z'),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('tenant A cannot create a follow-up associated to a tenant B lead (400)', async () => {
    await expect(
      service.create(ctxA, { leadId: leadBId, title: 'X', scheduledAt: '2026-11-01T10:00:00.000Z' } as any),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('tenant A cannot create a follow-up associated to a tenant B owner (400)', async () => {
    await expect(
      service.create(ctxA, {
        leadId: leadAId,
        ownerUserId: userB,
        title: 'X',
        scheduledAt: '2026-11-01T10:00:00.000Z',
      } as any),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('fail-closed: querying follow_ups without a tenant context never leaks rows', async () => {
    // On a pooled connection that has ALREADY had app.current_tenant_id set at
    // least once (every earlier test in this file does, via runWithTenant),
    // Postgres resets a touched custom GUC to '' rather than NULL once the
    // setting transaction ends — so current_setting(..., true)::uuid in the
    // RLS policy throws a cast error (22P02) instead of comparing against
    // NULL. Both outcomes are fail-closed (no cross-tenant row is ever
    // returned); only a virgin, never-touched connection sees NULL and 0 rows
    // cleanly. Assert the safe outcome either way.
    try {
      const rows = await appPrisma.$queryRaw`SELECT * FROM follow_ups`;
      expect((rows as unknown[]).length).toBe(0);
    } catch (err: any) {
      expect(err.code).toBe('P2010');
    }
  });

  it('composite FK rejects a FollowUp(tenant=A) pointing at Lead(tenant=B) even at raw SQL level', async () => {
    await expect(
      ownerPrisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenantA}, true)`;
        await tx.$executeRaw`
          INSERT INTO follow_ups (id, tenant_id, lead_id, title, scheduled_at, updated_at)
          VALUES (${randomUUID()}::uuid, ${tenantA}::uuid, ${leadBId}::uuid, 'cross-fk-test', now(), now())
        `;
      }),
    ).rejects.toMatchObject({ code: 'P2010' });
  });

  it('nextActionAt reflects the earliest PENDING follow-up: completing the sooner one advances it to the next', async () => {
    // Dedicated lead so this test's outcome does not depend on state left by
    // earlier tests in this file (order-independent).
    const dedicatedLead = await ownerPrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenantA}, true)`;
      const contact = await tx.contact.create({ data: { tenantId: tenantA, name: 'Cliente A2' } });
      return tx.lead.create({ data: { tenantId: tenantA, contactId: contact.id, pipelineStageId: stageA } });
    });

    const soon = await service.create(ctxA, {
      leadId: dedicatedLead.id,
      title: 'Amanhã',
      scheduledAt: '2026-10-01T10:00:00.000Z',
    } as any);
    await service.create(ctxA, {
      leadId: dedicatedLead.id,
      title: 'Semana que vem',
      scheduledAt: '2026-10-08T10:00:00.000Z',
    } as any);

    await service.complete(ctxA, soon.id);

    const lead = await ownerPrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenantA}, true)`;
      return tx.lead.findUnique({ where: { id: dedicatedLead.id } });
    });
    expect(lead?.nextActionAt?.toISOString()).toBe('2026-10-08T10:00:00.000Z');
  });
});
