import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { LeadsService } from '../src/modules/leads/leads.service';
import { UsersService } from '../src/modules/users/users.service';
import { PrismaService } from '../src/prisma/prisma.service';
import type { TenantContext } from '../src/common/tenant/tenant-context';
import { makeAppClient, makeOwnerClient } from './rls.helper';

/**
 * Real cross-tenant integration for the "Cadastro de cliente durante o fluxo"
 * feature. Uses the app-role connection so RLS is genuinely exercised.
 *
 * BLOCKER-level guarantees:
 *  - a Lead created during a flow binds the AUTHENTICATED tenant (never a
 *    client-supplied tenantId);
 *  - the "Atendente responsável" source (GET /api/users/assignable) lists only
 *    ACTIVE users of the acting tenant and never another tenant's users;
 *  - a Conversation can link to a Lead of the SAME tenant;
 *  - a Conversation can NEVER link to a Lead of ANOTHER tenant (composite FK).
 */
describe('Cadastro de cliente durante o fluxo — Users + Conversation↔Lead + RLS (integration)', () => {
  let appPrisma: PrismaClient;
  let ownerPrisma: PrismaClient;
  let leadsService: LeadsService;
  let usersService: UsersService;

  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const ctxA: TenantContext = { tenantId: tenantA, userId: randomUUID(), roleCodes: ['ADMIN'] };
  const ctxB: TenantContext = { tenantId: tenantB, userId: randomUUID(), roleCodes: ['ADMIN'] };

  const stageA = randomUUID();
  const stageB = randomUUID();
  const activeUserA = randomUUID();
  const invitedUserA = randomUUID();
  const activeUserB = randomUUID();

  const contactA = randomUUID();
  const contactB = randomUUID();
  let leadBId = '';

  beforeAll(async () => {
    appPrisma = makeAppClient();
    ownerPrisma = makeOwnerClient();
    (appPrisma as any).runWithTenant = PrismaService.prototype.runWithTenant.bind(appPrisma);
    leadsService = new LeadsService(appPrisma as unknown as PrismaService);
    usersService = new UsersService(appPrisma as unknown as PrismaService);

    const seedTenant = async (
      tenantId: string,
      slug: string,
      pipelineId: string,
      stageId: string,
      contactId: string,
    ) => {
      await ownerPrisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        await tx.$executeRaw`INSERT INTO tenants (id,name,slug,timezone,created_at,updated_at) VALUES (${tenantId}::uuid,${slug},${slug},'America/Sao_Paulo',now(),now())`;
        await tx.$executeRaw`INSERT INTO pipelines (id,tenant_id,name,is_default) VALUES (${pipelineId}::uuid,${tenantId}::uuid,'Comercial',true)`;
        await tx.$executeRaw`INSERT INTO pipeline_stages (id,tenant_id,pipeline_id,name,position) VALUES (${stageId}::uuid,${tenantId}::uuid,${pipelineId}::uuid,'Novo lead',0)`;
        await tx.$executeRaw`INSERT INTO contacts (id,tenant_id,name,created_at,updated_at) VALUES (${contactId}::uuid,${tenantId}::uuid,'Contato base',now(),now())`;
      });
    };

    const seedUser = async (tenantId: string, id: string, name: string, status: string) => {
      await ownerPrisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        await tx.$executeRaw`INSERT INTO users (id,tenant_id,email,name,password_hash,status,created_at,updated_at) VALUES (${id}::uuid,${tenantId}::uuid,${`u-${id.slice(0, 8)}@example.invalid`},${name},'x',${status}::"UserStatus",now(),now())`;
      });
    };

    await seedTenant(tenantA, `usr-int-a-${tenantA.slice(0, 8)}`, randomUUID(), stageA, contactA);
    await seedTenant(tenantB, `usr-int-b-${tenantB.slice(0, 8)}`, randomUUID(), stageB, contactB);

    await seedUser(tenantA, activeUserA, 'Edson (A ativo)', 'ACTIVE');
    await seedUser(tenantA, invitedUserA, 'Convidado (A)', 'INVITED');
    await seedUser(tenantB, activeUserB, 'Bruno (B ativo)', 'ACTIVE');

    // A lead in tenant B, created through the service in B's context.
    const leadB = await leadsService.create(ctxB, { name: 'Cliente B', stageId: stageB });
    leadBId = leadB.id;
  });

  afterAll(async () => {
    for (const tenantId of [tenantA, tenantB]) {
      await ownerPrisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        await tx.$executeRaw`DELETE FROM audit_logs WHERE tenant_id = ${tenantId}::uuid`;
        await tx.$executeRaw`DELETE FROM conversations WHERE tenant_id = ${tenantId}::uuid`;
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

  // -- Quick lead creation binds the acting tenant ---------------------------

  it('a lead created during a flow binds the ACTING tenant (never a client tenantId)', async () => {
    const lead = await leadsService.create(ctxA, { name: 'Novo cliente em fluxo', stageId: stageA });
    expect(lead.stageId).toBe(stageA);

    // It is visible to tenant A...
    const listed = await leadsService.list(ctxA, {});
    expect(listed.items.some((l) => l.id === lead.id)).toBe(true);

    // ...and NOT to tenant B (cross-tenant read yields 404 under RLS).
    await expect(leadsService.getById(ctxB, lead.id)).rejects.toMatchObject({ status: 404 });
  });

  // -- Atendente responsável source (users) ----------------------------------

  it('listAssignable returns only ACTIVE users of the acting tenant', async () => {
    const usersA = await usersService.listAssignable(ctxA);
    const ids = usersA.map((u) => u.id);
    expect(ids).toContain(activeUserA);
    // INVITED user of the same tenant is not eligible.
    expect(ids).not.toContain(invitedUserA);
    // Never leaks another tenant's user.
    expect(ids).not.toContain(activeUserB);
  });

  it('a tenant never sees another tenant users through listAssignable', async () => {
    const usersB = await usersService.listAssignable(ctxB);
    const ids = usersB.map((u) => u.id);
    expect(ids).toContain(activeUserB);
    expect(ids).not.toContain(activeUserA);
    expect(ids).not.toContain(invitedUserA);
  });

  it('the projection never exposes the passwordHash', async () => {
    const usersA = await usersService.listAssignable(ctxA);
    for (const u of usersA) {
      expect((u as any).passwordHash).toBeUndefined();
    }
  });

  // -- Conversation ↔ Lead relationship, tenant-bounded ----------------------

  it('a Conversation can link to a Lead of the SAME tenant', async () => {
    const leadA = await leadsService.create(ctxA, { name: 'Cliente para conversa', stageId: stageA });

    const created = await ownerPrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenantA}, true)`;
      return tx.conversation.create({
        data: { tenantId: tenantA, contactId: contactA, leadId: leadA.id },
      });
    });
    expect(created.leadId).toBe(leadA.id);
  });

  it('a Conversation can NEVER link to a Lead of ANOTHER tenant (composite FK rejects it)', async () => {
    await expect(
      ownerPrisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenantA}, true)`;
        // Conversation in tenant A pointing at a tenant B lead.
        await tx.$executeRaw`
          INSERT INTO conversations (id, tenant_id, contact_id, lead_id, state, channel, created_at, updated_at)
          VALUES (${randomUUID()}::uuid, ${tenantA}::uuid, ${contactA}::uuid, ${leadBId}::uuid, 'AI_ATENDENDO', 'MANUAL', now(), now())
        `;
      }),
    ).rejects.toMatchObject({ code: 'P2010' });
  });
});
