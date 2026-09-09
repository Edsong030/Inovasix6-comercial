import { JwtService } from '@nestjs/jwt';
import { PrismaClient, RoleCode } from '@prisma/client';
import * as argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
import { AppConfigService } from '../src/config/app-config.service';
import { AuthService } from '../src/modules/auth/auth.service';
import { PasswordService } from '../src/modules/auth/password.service';
import { TokenService } from '../src/modules/auth/token.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { makeAppClient, makeOwnerClient } from './rls.helper';

/**
 * Real auth + RLS integration. Connects the AuthService to Postgres through the
 * least-privilege app role and proves cross-tenant isolation end to end.
 */
describe('Auth + RLS (integration)', () => {
  const slugA = 'auth-int-a';
  const slugB = 'auth-int-b';
  const emailA = 'a@authint.local';
  const emailB = 'b@authint.local';
  const password = 'CorrectHorseBatteryStaple1';

  let tenantAId: string;
  let tenantBId: string;

  let appPrisma: PrismaClient;
  let ownerPrisma: PrismaClient;
  let auth: AuthService;
  let tokens: TokenService;

  const config = {
    jwtAccessSecret: 'test-access-secret-1234567890-abc',
    jwtRefreshSecret: 'test-refresh-secret-1234567890-xyz',
    accessTokenTtlSec: 900,
    refreshTokenTtlSec: 604800,
    isProduction: false,
  } as unknown as AppConfigService;

  beforeAll(async () => {
    appPrisma = makeAppClient();
    ownerPrisma = makeOwnerClient();

    tokens = new TokenService(new JwtService({}), config);
    auth = new AuthService(
      appPrisma as unknown as PrismaService,
      new PasswordService(),
      tokens,
      { warn: jest.fn(), log: jest.fn(), error: jest.fn() } as any,
    );
    // PrismaService.runWithTenant is used by AuthService; the plain client has
    // $transaction/$queryRaw/$executeRaw, so we attach the method.
    (appPrisma as any).runWithTenant = PrismaService.prototype.runWithTenant.bind(appPrisma);

    tenantAId = randomUUID();
    tenantBId = randomUUID();
    const hash = await argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
    });

    const seed = async (tenantId: string, slug: string, email: string) => {
      await ownerPrisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        await tx.$executeRaw`INSERT INTO tenants (id,name,slug,timezone,created_at,updated_at) VALUES (${tenantId}::uuid,${slug},${slug},'America/Sao_Paulo',now(),now())`;
        const userId = randomUUID();
        await tx.$executeRaw`INSERT INTO users (id,tenant_id,email,name,password_hash,status,created_at,updated_at) VALUES (${userId}::uuid,${tenantId}::uuid,${email},'X',${hash},'ACTIVE'::"UserStatus",now(),now())`;
        const roleId = randomUUID();
        await tx.$executeRaw`INSERT INTO roles (id,tenant_id,code,name,created_at) VALUES (${roleId}::uuid,${tenantId}::uuid,'ADMIN'::"RoleCode",'Admin',now())`;
        await tx.$executeRaw`INSERT INTO user_roles (tenant_id,user_id,role_id) VALUES (${tenantId}::uuid,${userId}::uuid,${roleId}::uuid)`;
      });
    };
    await seed(tenantAId, slugA, emailA);
    await seed(tenantBId, slugB, emailB);
  });

  afterAll(async () => {
    for (const tenantId of [tenantAId, tenantBId]) {
      await ownerPrisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        await tx.$executeRaw`DELETE FROM auth_sessions WHERE tenant_id = ${tenantId}::uuid`;
        await tx.$executeRaw`DELETE FROM audit_logs WHERE tenant_id = ${tenantId}::uuid`;
        await tx.$executeRaw`DELETE FROM user_roles WHERE tenant_id = ${tenantId}::uuid`;
        await tx.$executeRaw`DELETE FROM roles WHERE tenant_id = ${tenantId}::uuid`;
        await tx.$executeRaw`DELETE FROM users WHERE tenant_id = ${tenantId}::uuid`;
        await tx.$executeRaw`DELETE FROM tenants WHERE id = ${tenantId}::uuid`;
      });
    }
    await appPrisma.$disconnect();
    await ownerPrisma.$disconnect();
  });

  it('1. User A cannot authenticate against Tenant B (wrong slug)', async () => {
    // Email A does not exist under slug B => generic failure.
    await expect(auth.login(slugB, emailA, password, {})).rejects.toThrow();
  });

  it('2. Token A yields TenantContext A', async () => {
    const res = await auth.login(slugA, emailA, password, {});
    expect(res.tenantId).toBe(tenantAId);
    const claims = await tokens.verifyAccessToken(res.accessToken);
    expect(claims.tenantId).toBe(tenantAId);
    expect(claims.roleCodes).toContain(RoleCode.ADMIN);
  });

  it('3. Token A context cannot read Tenant B data (RLS)', async () => {
    const rows = await (appPrisma as any).runWithTenant(tenantAId, (tx: PrismaClient) =>
      tx.tenant.findMany(),
    );
    expect(rows.every((r: { id: string }) => r.id === tenantAId)).toBe(true);
    expect(rows.some((r: { id: string }) => r.id === tenantBId)).toBe(false);
  });

  it('4. A refresh session of Tenant A does not work under Tenant B claims', async () => {
    const res = await auth.login(slugA, emailA, password, {});
    // Forge a refresh token that claims tenant B but references A's session.
    const forged = await tokens.signRefreshToken({
      sub: 'someone',
      tenantId: tenantBId,
      sessionId: (await tokens.verifyAccessToken(res.accessToken)).sessionId,
    });
    await expect(auth.refresh(forged, {})).rejects.toThrow();
  });

  it('5. Login persists an AuthSession that respects the composite FK (same tenant)', async () => {
    const res = await auth.login(slugA, emailA, password, {});
    const claims = await tokens.verifyAccessToken(res.accessToken);
    const session = await (appPrisma as any).runWithTenant(tenantAId, (tx: PrismaClient) =>
      tx.authSession.findUnique({ where: { id: claims.sessionId } }),
    );
    expect(session.tenantId).toBe(tenantAId);
  });

  it('6. RLS still enforced after auth: no context => 0 rows', async () => {
    const fresh = makeAppClient();
    try {
      expect(await fresh.user.findMany()).toHaveLength(0);
    } finally {
      await fresh.$disconnect();
    }
  });
});
