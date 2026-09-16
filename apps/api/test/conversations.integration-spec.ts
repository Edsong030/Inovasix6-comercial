import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { BadRequestException, ForbiddenException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ConversationsService } from '../src/modules/conversations/conversations.service';
import { MessagesService } from '../src/modules/messages/messages.service';
import { JwtAuthGuard } from '../src/modules/auth/jwt-auth.guard';
import { PrismaService } from '../src/prisma/prisma.service';
import type { TenantContext } from '../src/common/tenant/tenant-context';
import { makeAppClient, makeOwnerClient, runWithTenant } from './rls.helper';

/**
 * Real cross-tenant integration for Conversations/Messages (Inbox core,
 * STEP 2). Uses the app-role connection so RLS is genuinely exercised, same
 * approach as followups.integration-spec.ts / rls.integration-spec.ts.
 */
describe('Conversations/Messages + RLS (integration)', () => {
  let appPrisma: PrismaClient;
  let ownerPrisma: PrismaClient;
  let conversations: ConversationsService;
  let messages: MessagesService;

  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const userA = randomUUID();
  const userA2 = randomUUID();
  const userB = randomUUID();
  const contactA = randomUUID();
  const contactB = randomUUID();
  const convAId = randomUUID();
  const convBId = randomUUID();

  const ctxA: TenantContext = { tenantId: tenantA, userId: userA, roleCodes: ['ADMIN'] };
  const ctxB: TenantContext = { tenantId: tenantB, userId: userB, roleCodes: ['ADMIN'] };

  beforeAll(async () => {
    appPrisma = makeAppClient();
    ownerPrisma = makeOwnerClient();
    (appPrisma as any).runWithTenant = PrismaService.prototype.runWithTenant.bind(appPrisma);
    conversations = new ConversationsService(appPrisma as unknown as PrismaService);
    messages = new MessagesService(appPrisma as unknown as PrismaService);

    await runWithTenant(ownerPrisma, tenantA, async (tx) => {
      await tx.$executeRaw`INSERT INTO tenants (id,name,slug,timezone,created_at,updated_at) VALUES (${tenantA}::uuid,'A','conv-int-a','America/Sao_Paulo',now(),now())`;
      await tx.$executeRaw`INSERT INTO users (id,tenant_id,email,name,password_hash,status,created_at,updated_at) VALUES (${userA}::uuid,${tenantA}::uuid,'a@conv-int.test','A','x','ACTIVE',now(),now())`;
      await tx.$executeRaw`INSERT INTO users (id,tenant_id,email,name,password_hash,status,created_at,updated_at) VALUES (${userA2}::uuid,${tenantA}::uuid,'a2@conv-int.test','A2','x','ACTIVE',now(),now())`;
      await tx.$executeRaw`INSERT INTO contacts (id,tenant_id,name,phone_e164,email,created_at,updated_at) VALUES (${contactA}::uuid,${tenantA}::uuid,'Contact A','+5511900000001','a-contact@conv-int.test',now(),now())`;
      await tx.$executeRaw`INSERT INTO conversations (id,tenant_id,contact_id,state,created_at,updated_at) VALUES (${convAId}::uuid,${tenantA}::uuid,${contactA}::uuid,'AGUARDANDO_HUMANO',now(),now())`;
    });
    await runWithTenant(ownerPrisma, tenantB, async (tx) => {
      await tx.$executeRaw`INSERT INTO tenants (id,name,slug,timezone,created_at,updated_at) VALUES (${tenantB}::uuid,'B','conv-int-b','America/Sao_Paulo',now(),now())`;
      await tx.$executeRaw`INSERT INTO users (id,tenant_id,email,name,password_hash,status,created_at,updated_at) VALUES (${userB}::uuid,${tenantB}::uuid,'b@conv-int.test','B','x','ACTIVE',now(),now())`;
      await tx.$executeRaw`INSERT INTO contacts (id,tenant_id,name,phone_e164,email,created_at,updated_at) VALUES (${contactB}::uuid,${tenantB}::uuid,'Contact B','+5511900000002','b-contact@conv-int.test',now(),now())`;
      await tx.$executeRaw`INSERT INTO conversations (id,tenant_id,contact_id,state,created_at,updated_at) VALUES (${convBId}::uuid,${tenantB}::uuid,${contactB}::uuid,'AGUARDANDO_HUMANO',now(),now())`;
    });
  });

  afterAll(async () => {
    for (const tenantId of [tenantA, tenantB]) {
      await runWithTenant(ownerPrisma, tenantId, async (tx) => {
        await tx.$executeRaw`DELETE FROM audit_logs WHERE tenant_id = ${tenantId}::uuid`;
        await tx.$executeRaw`DELETE FROM messages WHERE tenant_id = ${tenantId}::uuid`;
        await tx.$executeRaw`DELETE FROM conversations WHERE tenant_id = ${tenantId}::uuid`;
        await tx.$executeRaw`DELETE FROM contacts WHERE tenant_id = ${tenantId}::uuid`;
        await tx.$executeRaw`DELETE FROM users WHERE tenant_id = ${tenantId}::uuid`;
        await tx.$executeRaw`DELETE FROM tenants WHERE id = ${tenantId}::uuid`;
      });
    }
    await appPrisma.$disconnect();
    await ownerPrisma.$disconnect();
  });

  it('1. Tenant A lists only its own conversations', async () => {
    const result = await conversations.list(ctxA, {} as any);
    expect(result.items.some((c) => c.id === convAId)).toBe(true);
    expect(result.items.some((c) => c.id === convBId)).toBe(false);
  });

  it('2. Tenant B cannot read a Tenant A conversation (404)', async () => {
    await expect(conversations.getById(ctxB, convAId)).rejects.toMatchObject({ status: 404 });
    await expect(conversations.getById(ctxB, convAId)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('3. Tenant B cannot list messages of a Tenant A conversation (404)', async () => {
    await expect(messages.list(ctxB, convAId, {} as any)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('4. Creating a message binds the acting tenant correctly', async () => {
    const message = await messages.send(ctxA, convAId, { body: 'Olá do tenant A' } as any);
    expect(message.body).toBe('Olá do tenant A');

    const stored = await runWithTenant(ownerPrisma, tenantA, (tx) =>
      tx.message.findUnique({ where: { id: message.id } }),
    );
    expect(stored?.tenantId).toBe(tenantA);
  });

  it('5. Tenant B cannot create a message on a Tenant A conversation (404, blocked)', async () => {
    await expect(messages.send(ctxB, convAId, { body: 'invasão' } as any)).rejects.toBeInstanceOf(NotFoundException);

    // Confirm nothing was written under Tenant A for this attempt.
    const rows = await runWithTenant(ownerPrisma, tenantA, (tx) =>
      tx.message.findMany({ where: { conversationId: convAId, body: 'invasão' } }),
    );
    expect(rows).toHaveLength(0);
  });

  it('6. Assigning to a user of the SAME tenant works', async () => {
    const result = await conversations.assign(ctxA, convAId, userA);
    expect(result.assignedUserId).toBe(userA);
    expect(result.state).toBe('HUMANO_ATENDENDO');
  });

  it('7. Assigning to a user of ANOTHER tenant is blocked (400)', async () => {
    await expect(conversations.assign(ctxA, convAId, userB)).rejects.toBeInstanceOf(BadRequestException);
  });

  it("7b. ATENDENTE cannot steal a colleague's assigned conversation (403, ownership rule)", async () => {
    // userA2 is a real, seeded user of tenant A — this isolates the ownership
    // check (403) from the "target user must exist in this tenant" check
    // (400), which a never-seeded id would trigger first.
    const intruder: TenantContext = { tenantId: tenantA, userId: userA2, roleCodes: ['ATENDENTE'] };
    await conversations.assign(ctxA, convAId, userA); // owned by userA (ADMIN acting on their behalf)
    await expect(conversations.assign(intruder, convAId, intruder.userId)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('8. A valid state change works (HUMANO_ATENDENDO -> ENCERRADA)', async () => {
    await conversations.assign(ctxA, convAId, userA);
    const result = await conversations.changeState(ctxA, convAId, 'ENCERRADA' as any);
    expect(result.state).toBe('ENCERRADA');

    // Reopen so later tests in this file are not affected by ordering.
    await conversations.changeState(ctxA, convAId, 'AGUARDANDO_HUMANO' as any);
  });

  it('9. lastMessageAt is updated after a new message', async () => {
    const before = await conversations.getById(ctxA, convAId);
    const message = await messages.send(ctxA, convAId, { body: 'atualiza lastMessageAt' } as any);
    const after = await conversations.getById(ctxA, convAId);
    expect(after.lastMessageAt).toBe(message.createdAt);
    expect(after.lastMessageAt).not.toBe(before.lastMessageAt);
  });

  it('10. Requests without authentication are rejected by the same guard protecting these controllers', async () => {
    // ConversationsController/MessagesController both declare @UseGuards(JwtAuthGuard).
    // This exercises the REAL guard class (not a stub) exactly as it runs in
    // front of every route in this spec, with no Authorization header.
    const guard = new JwtAuthGuard({ verifyAccessToken: jest.fn() } as any);
    const ctx = {
      switchToHttp: () => ({ getRequest: () => ({ headers: {} }) }),
    } as any;
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('fail-closed: querying conversations without a tenant context never leaks rows', async () => {
    // Same fail-closed reasoning documented in rls.integration-spec.ts: a
    // pooled connection that already had app.current_tenant_id set at least
    // once resets the GUC to '' (not NULL) once its setting transaction ends,
    // so current_setting(..., true)::uuid throws a cast error instead of
    // comparing against NULL. Both outcomes are fail-closed.
    try {
      const rows = await appPrisma.$queryRaw`SELECT * FROM conversations`;
      expect((rows as unknown[]).length).toBe(0);
    } catch (err: any) {
      expect(err.code).toBe('P2010');
    }
  });
});
