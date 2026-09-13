import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { LeadsService } from '../src/modules/leads/leads.service';
import { PrismaService } from '../src/prisma/prisma.service';
import type { TenantContext } from '../src/common/tenant/tenant-context';
import { makeAppClient, makeOwnerClient } from './rls.helper';

/**
 * Real cross-tenant integration for the leads/CRM feature. Uses the app-role
 * connection so RLS is genuinely exercised. BLOCKER-level guarantees:
 *  - tenant A sees only its own leads;
 *  - tenant A cannot read/move a tenant B lead (404 / no effect);
 *  - creating a lead binds the correct tenant.
 */
describe('Leads + RLS (integration)', () => {
  let appPrisma: PrismaClient;
  let ownerPrisma: PrismaClient;
  let service: LeadsService;

  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const ctxA: TenantContext = { tenantId: tenantA, userId: randomUUID(), roleCodes: ['ADMIN'] };
  const ctxB: TenantContext = { tenantId: tenantB, userId: randomUUID(), roleCodes: ['ADMIN'] };

  const stageA = randomUUID();
  const stageA2 = randomUUID();
  const stageB = randomUUID();
  let leadBId = '';

  beforeAll(async () => {
    appPrisma = makeAppClient();
    ownerPrisma = makeOwnerClient();
    (appPrisma as any).runWithTenant = PrismaService.prototype.runWithTenant.bind(appPrisma);
    service = new LeadsService(appPrisma as unknown as PrismaService);

    const seed = async (
      tenantId: string,
      slug: string,
      pipelineId: string,
      stageId: string,
      extraStageId: string | null,
    ) => {
      await ownerPrisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        await tx.$executeRaw`INSERT INTO tenants (id,name,slug,timezone,created_at,updated_at) VALUES (${tenantId}::uuid,${slug},${slug},'America/Sao_Paulo',now(),now())`;
        await tx.$executeRaw`INSERT INTO pipelines (id,tenant_id,name,is_default) VALUES (${pipelineId}::uuid,${tenantId}::uuid,'Comercial',true)`;
        await tx.$executeRaw`INSERT INTO pipeline_stages (id,tenant_id,pipeline_id,name,position) VALUES (${stageId}::uuid,${tenantId}::uuid,${pipelineId}::uuid,'Novo lead',0)`;
        if (extraStageId) {
          await tx.$executeRaw`INSERT INTO pipeline_stages (id,tenant_id,pipeline_id,name,position) VALUES (${extraStageId}::uuid,${tenantId}::uuid,${pipelineId}::uuid,'Contato',1)`;
        }
      });
    };

    await seed(tenantA, `lead-int-a-${tenantA.slice(0, 8)}`, randomUUID(), stageA, stageA2);
    await seed(tenantB, `lead-int-b-${tenantB.slice(0, 8)}`, randomUUID(), stageB, null);

    // A lead in tenant B, created through the service in B's context.
    const leadB = await service.create(ctxB, { name: 'Cliente B', stageId: stageB });
    leadBId = leadB.id;
  });

  afterAll(async () => {
    for (const tenantId of [tenantA, tenantB]) {
      await ownerPrisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        await tx.$executeRaw`DELETE FROM audit_logs WHERE tenant_id = ${tenantId}::uuid`;
        await tx.$executeRaw`DELETE FROM leads WHERE tenant_id = ${tenantId}::uuid`;
        await tx.$executeRaw`DELETE FROM contacts WHERE tenant_id = ${tenantId}::uuid`;
        await tx.$executeRaw`DELETE FROM pipeline_stages WHERE tenant_id = ${tenantId}::uuid`;
        await tx.$executeRaw`DELETE FROM pipelines WHERE tenant_id = ${tenantId}::uuid`;
        await tx.$executeRaw`DELETE FROM tenants WHERE id = ${tenantId}::uuid`;
      });
    }
    await appPrisma.$disconnect();
    await ownerPrisma.$disconnect();
  });

  it('creating a lead binds the acting tenant', async () => {
    const lead = await service.create(ctxA, { name: 'Cliente A', stageId: stageA, amountCents: 12345 });
    expect(lead.stageId).toBe(stageA);
    expect(lead.amountCents).toBe(12345);
  });

  it('tenant A lists only its own leads', async () => {
    const result = await service.list(ctxA, {});
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items.every((l) => l.name !== 'Cliente B')).toBe(true);
  });

  it('tenant A cannot read a tenant B lead (404)', async () => {
    await expect(service.getById(ctxA, leadBId)).rejects.toMatchObject({ status: 404 });
  });

  it('tenant A cannot move a tenant B lead (404)', async () => {
    await expect(service.moveStage(ctxA, leadBId, stageA2)).rejects.toMatchObject({ status: 404 });
  });

  it('tenant A cannot move its lead into a tenant B stage (400)', async () => {
    const lead = await service.create(ctxA, { name: 'Guarded', stageId: stageA });
    await expect(service.moveStage(ctxA, lead.id, stageB)).rejects.toMatchObject({ status: 400 });
  });

  it('tenant A can move its lead within its own pipeline', async () => {
    const lead = await service.create(ctxA, { name: 'Mover A', stageId: stageA });
    const moved = await service.moveStage(ctxA, lead.id, stageA2);
    expect(moved.stageId).toBe(stageA2);
  });
});
