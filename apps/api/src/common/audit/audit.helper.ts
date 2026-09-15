import { Prisma } from '@prisma/client';
import type { TenantTx } from '../../prisma/prisma.service';

/**
 * Writes an audit_logs row inside the caller's tenant transaction. Never store
 * secrets. `after`/`before` hold small JSON snapshots of the change.
 */
export async function writeAudit(
  tx: TenantTx,
  params: {
    tenantId: string;
    actorId: string | null;
    action: string;
    entity: string;
    entityId?: string | null;
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown> | null;
  },
): Promise<void> {
  await tx.auditLog.create({
    data: {
      tenantId: params.tenantId,
      actorId: params.actorId,
      action: params.action,
      entity: params.entity,
      entityId: params.entityId ?? null,
      before: (params.before ?? undefined) as Prisma.InputJsonValue | undefined,
      after: (params.after ?? undefined) as Prisma.InputJsonValue | undefined,
    },
  });
}
