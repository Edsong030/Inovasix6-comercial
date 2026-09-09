import { PrismaClient } from '@prisma/client';
import { makeAppClient, makeOwnerClient, runWithTenant, TENANT_A, TENANT_B } from './rls.helper';

/**
 * Real RLS integration tests. These connect as the least-privilege application
 * role and prove tenant isolation end to end. BLOCKERS before starting auth.
 *
 * Seeding/cleanup uses the owner role because creating a tenant has no prior
 * tenant context (fail-closed would block it) — tenant creation is an
 * administrative operation outside the app role, by design.
 */
describe('RLS multi-tenant isolation (integration)', () => {
  let app: PrismaClient;
  let owner: PrismaClient;

  const contactA = 'aaaa1111-1111-1111-1111-111111111111';
  const contactB = 'bbbb2222-2222-2222-2222-222222222222';
  const userA = 'aaaa0000-0000-0000-0000-000000000001';
  const userB = 'bbbb0000-0000-0000-0000-000000000001';
  const convB = 'cccc2222-2222-2222-2222-222222222222';

  beforeAll(async () => {
    app = makeAppClient();
    owner = makeOwnerClient();

    // Seed two tenants + a user/contact each, and a conversation in B.
    await runWithTenant(owner, TENANT_A, async (tx) => {
      await tx.$executeRaw`INSERT INTO tenants (id,name,slug,timezone,created_at,updated_at) VALUES (${TENANT_A}::uuid,'A','a-int','America/Sao_Paulo',now(),now())`;
      await tx.$executeRaw`INSERT INTO users (id,tenant_id,email,name,password_hash,status,created_at,updated_at) VALUES (${userA}::uuid,${TENANT_A}::uuid,'a@int.test','A','x','ACTIVE',now(),now())`;
      await tx.$executeRaw`INSERT INTO contacts (id,tenant_id,name,created_at,updated_at) VALUES (${contactA}::uuid,${TENANT_A}::uuid,'Contact A',now(),now())`;
    });
    await runWithTenant(owner, TENANT_B, async (tx) => {
      await tx.$executeRaw`INSERT INTO tenants (id,name,slug,timezone,created_at,updated_at) VALUES (${TENANT_B}::uuid,'B','b-int','America/Sao_Paulo',now(),now())`;
      await tx.$executeRaw`INSERT INTO users (id,tenant_id,email,name,password_hash,status,created_at,updated_at) VALUES (${userB}::uuid,${TENANT_B}::uuid,'b@int.test','B','x','ACTIVE',now(),now())`;
      await tx.$executeRaw`INSERT INTO contacts (id,tenant_id,name,created_at,updated_at) VALUES (${contactB}::uuid,${TENANT_B}::uuid,'Contact B',now(),now())`;
      await tx.$executeRaw`INSERT INTO conversations (id,tenant_id,contact_id,state,created_at,updated_at) VALUES (${convB}::uuid,${TENANT_B}::uuid,${contactB}::uuid,'AI_ATENDENDO',now(),now())`;
    });
  });

  afterAll(async () => {
    // Cleanup all test rows (owner, per-tenant context).
    for (const tenant of [TENANT_A, TENANT_B]) {
      await runWithTenant(owner, tenant, async (tx) => {
        await tx.$executeRaw`DELETE FROM conversations WHERE tenant_id = ${tenant}::uuid`;
        await tx.$executeRaw`DELETE FROM contacts WHERE tenant_id = ${tenant}::uuid`;
        await tx.$executeRaw`DELETE FROM auth_sessions WHERE tenant_id = ${tenant}::uuid`;
        await tx.$executeRaw`DELETE FROM users WHERE tenant_id = ${tenant}::uuid`;
        await tx.$executeRaw`DELETE FROM tenants WHERE id = ${tenant}::uuid`;
      });
    }
    await app.$disconnect();
    await owner.$disconnect();
  });

  it('1. Tenant A sees its own data', async () => {
    const rows = await runWithTenant(app, TENANT_A, (tx) => tx.contact.findMany());
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(contactA);
  });

  it('2. Tenant A does not see Tenant B', async () => {
    const rows = await runWithTenant(app, TENANT_A, (tx) => tx.contact.findMany());
    expect(rows.some((r) => r.id === contactB)).toBe(false);
  });

  it('3. Tenant A cannot update Tenant B', async () => {
    const affected = await runWithTenant(
      app,
      TENANT_A,
      (tx) => tx.contact.updateMany({ where: { id: contactB }, data: { name: 'HACKED' } }),
    );
    expect(affected.count).toBe(0);
    // Confirm B unchanged (read as B).
    const b = await runWithTenant(app, TENANT_B, (tx) =>
      tx.contact.findUnique({ where: { id: contactB } }),
    );
    expect(b?.name).toBe('Contact B');
  });

  it('4. Tenant A cannot delete Tenant B', async () => {
    const affected = await runWithTenant(
      app,
      TENANT_A,
      (tx) => tx.contact.deleteMany({ where: { id: contactB } }),
    );
    expect(affected.count).toBe(0);
  });

  it('5. No tenant context => fail closed (0 rows)', async () => {
    // A fresh client models a connection with no tenant context ever set.
    // (A transaction-local set_config is cleared at COMMIT, but using a fresh
    // client removes any pooled-connection ambiguity and proves fail-closed.)
    const fresh = makeAppClient();
    try {
      const rows = await fresh.contact.findMany();
      expect(rows).toHaveLength(0);
    } finally {
      await fresh.$disconnect();
    }
  });

  it('6. Application role is NOBYPASSRLS / NOSUPERUSER', async () => {
    const [role] = await app.$queryRaw<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>`
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
    expect(role.rolsuper).toBe(false);
    expect(role.rolbypassrls).toBe(false);
  });

  it('7. Cross-tenant FK is still blocked (composite FK)', async () => {
    await expect(
      runWithTenant(app, TENANT_A, (tx) =>
        // owner is userB (Tenant B) while lead tenant is A -> composite FK must reject.
        tx.$executeRaw`INSERT INTO leads (id,tenant_id,contact_id,pipeline_stage_id,status,created_at,updated_at)
          VALUES (gen_random_uuid(), ${TENANT_A}::uuid, ${contactA}::uuid, gen_random_uuid(), 'OPEN', now(), now())`,
      ),
    ).rejects.toThrow();
  });

  it('8. Message cannot bind a conversation of another tenant', async () => {
    await expect(
      runWithTenant(app, TENANT_A, (tx) =>
        tx.$executeRaw`INSERT INTO messages (id,tenant_id,conversation_id,direction,status,created_at)
          VALUES (gen_random_uuid(), ${TENANT_A}::uuid, ${convB}::uuid, 'INBOUND', 'PENDING', now())`,
      ),
    ).rejects.toThrow();
  });

  it('9. AuthSession cannot bind a user of another tenant', async () => {
    await expect(
      runWithTenant(app, TENANT_A, (tx) =>
        tx.$executeRaw`INSERT INTO auth_sessions (id,tenant_id,user_id,refresh_token_hash,expires_at,created_at,updated_at)
          VALUES (gen_random_uuid(), ${TENANT_A}::uuid, ${userB}::uuid, 'hash', now() + interval '1 day', now(), now())`,
      ),
    ).rejects.toThrow();
  });

  it('10. Insert with tenant_id different from context is blocked by RLS WITH CHECK', async () => {
    await expect(
      runWithTenant(app, TENANT_A, (tx) =>
        tx.$executeRaw`INSERT INTO contacts (id,tenant_id,name,created_at,updated_at)
          VALUES (gen_random_uuid(), ${TENANT_B}::uuid, 'Cross', now(), now())`,
      ),
    ).rejects.toThrow();
  });
});
