import { Injectable } from '@nestjs/common';
import { PrismaService, TenantTx } from './prisma.service';
import type { TenantContext } from '../common/tenant/tenant-context';

/**
 * Base class for tenant-scoped data access.
 *
 * CONVENTION (to avoid accidentally bypassing RLS):
 *  - Business modules do NOT inject PrismaService directly and do NOT call
 *    `prisma.user.findMany()` etc. on the root client.
 *  - Instead they extend this repository and run every query through
 *    `withTenant(ctx, tx => ...)`, which delegates to
 *    PrismaService.runWithTenant(). The callback receives a TenantTx that
 *    already has `app.current_tenant_id` set on its transaction.
 *
 * This makes the tenant transaction the ONLY ergonomic path to the database,
 * so forgetting the tenant scope becomes the harder thing to do, not the
 * default. An ESLint rule additionally flags direct `prisma.<model>` access in
 * src/modules/** as a backstop.
 */
@Injectable()
export abstract class TenantAwareRepository {
  constructor(protected readonly prisma: PrismaService) {}

  /** Run data access inside the caller's tenant scope (RLS-enabled transaction). */
  protected withTenant<T>(ctx: TenantContext, work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.prisma.runWithTenant(ctx.tenantId, work);
  }
}
