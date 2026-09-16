import { UserStatus } from '@prisma/client';
import { UsersService } from './users.service';
import type { TenantContext } from '../../common/tenant/tenant-context';

/**
 * Unit tests for UsersService.listAssignable. A fake tx returns controlled rows
 * so we can assert the business rules of the "Atendente responsável" source:
 *  - runs scoped to the acting tenant (runWithTenant + tenantId predicate);
 *  - only ACTIVE users are eligible;
 *  - the passwordHash is never projected to the client;
 *  - roleCodes are flattened from userRoles.
 */
describe('UsersService', () => {
  const CTX: TenantContext = { tenantId: 'tenant-a', userId: 'user-a', roleCodes: ['ADMIN'] };

  function buildService(rows: any[]) {
    const tx = {
      user: { findMany: jest.fn(async () => rows) },
    };
    const prisma = { runWithTenant: jest.fn(async (_t: string, work: any) => work(tx)) };
    return { service: new UsersService(prisma as any), tx, prisma };
  }

  it('scopes the query to the acting tenant and filters to ACTIVE users', async () => {
    const { service, tx, prisma } = buildService([]);
    await service.listAssignable(CTX);

    expect(prisma.runWithTenant).toHaveBeenCalledWith('tenant-a', expect.any(Function));
    const args = (tx.user.findMany.mock.calls[0] as any[])[0];
    expect(args.where.tenantId).toBe('tenant-a');
    expect(args.where.status).toBe(UserStatus.ACTIVE);
  });

  it('projects only client-safe fields and never the passwordHash', async () => {
    const { service } = buildService([
      {
        id: 'u1',
        name: 'Edson',
        email: 'edson@demo.local',
        status: UserStatus.ACTIVE,
        passwordHash: 'super-secret-hash',
        userRoles: [{ role: { code: 'ADMIN' } }, { role: { code: 'GESTOR' } }],
      },
    ]);

    const result = await service.listAssignable(CTX);

    expect(result).toEqual([
      { id: 'u1', name: 'Edson', email: 'edson@demo.local', status: UserStatus.ACTIVE, roleCodes: ['ADMIN', 'GESTOR'] },
    ]);
    // Explicitly guard against leaking the credential.
    expect((result[0] as any).passwordHash).toBeUndefined();
  });

  it('returns an empty list without error when the tenant has no eligible users', async () => {
    const { service } = buildService([]);
    await expect(service.listAssignable(CTX)).resolves.toEqual([]);
  });
});
