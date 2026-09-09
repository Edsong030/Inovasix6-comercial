import { INestApplication, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * The transaction-scoped Prisma client handed to work running inside
 * runWithTenant(). Business code receives THIS, never the root client, so every
 * query executes with `app.current_tenant_id` set on the same transaction.
 */
export type TenantTx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

/**
 * Centralized Prisma client. This is the ONLY place a PrismaClient is
 * instantiated; modules inject this service and never construct their own.
 *
 * Lifecycle:
 *  - connects on module init
 *  - disconnects on module destroy (wired through app.enableShutdownHooks())
 *
 * RLS: runWithTenant() runs a callback inside a single interactive transaction
 * and issues `SET LOCAL app.current_tenant_id` on that SAME connection first,
 * so the tenant setting and the protected queries share one connection/txn.
 * This avoids the failure mode where the SET LOCAL lands on a different pooled
 * connection than the queries.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /** Optional explicit hook for non-Nest contexts (e.g. scripts, tests). */
  async enableShutdownHooks(app: INestApplication): Promise<void> {
    process.on('beforeExit', () => {
      void app.close();
    });
  }

  /**
   * Execute work scoped to a tenant with RLS active on the same transaction.
   * Application-level tenant predicates remain mandatory; this is defense in depth.
   */
  async runWithTenant<T>(
    tenantId: string,
    work: (tx: TenantTx) => Promise<T>,
  ): Promise<T> {
    return this.$transaction(async (tx) => {
      // Parameterized to prevent injection; set_config(..., true) => transaction-local.
      await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
      return work(tx);
    });
  }
}
