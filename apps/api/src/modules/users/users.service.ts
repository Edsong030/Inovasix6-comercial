import { Injectable } from '@nestjs/common';
import { UserStatus } from '@prisma/client';
import type { TenantContext } from '../../common/tenant/tenant-context';
import { PrismaService } from '../../prisma/prisma.service';

/** Minimal user projection safe to expose to the client (never the passwordHash). */
export interface AssignableUserItem {
  id: string;
  name: string;
  email: string;
  status: UserStatus;
  roleCodes: string[];
}

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Lists users eligible to be an "Atendente responsável" for the CURRENT
   * tenant. Runs inside runWithTenant so RLS guarantees a user of tenant A can
   * never see users of tenant B — the tenantId comes from the verified token,
   * never from the client. Only ACTIVE users are returned (INVITED users have
   * not accepted yet; SUSPENDED users must not receive new assignments).
   */
  async listAssignable(ctx: TenantContext): Promise<AssignableUserItem[]> {
    return this.prisma.runWithTenant(ctx.tenantId, async (tx) => {
      const rows = await tx.user.findMany({
        where: { tenantId: ctx.tenantId, status: UserStatus.ACTIVE },
        orderBy: { name: 'asc' },
        include: { userRoles: { include: { role: true } } },
      });

      return rows.map((user) => ({
        id: user.id,
        name: user.name,
        email: user.email,
        status: user.status,
        roleCodes: user.userRoles.map((ur) => ur.role.code as string),
      }));
    });
  }
}
