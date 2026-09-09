import { Injectable, NotFoundException } from '@nestjs/common';

export interface TenantResource {
  id: string;
  tenantId: string;
}

/**
 * Foundation for tenant-scoped resource lookups with IDOR protection.
 *
 * Anti-enumeration rule: from the outside, a resource that does not exist and a
 * resource that belongs to a *different* tenant must be INDISTINGUISHABLE. Both
 * yield 404 Not Found. We deliberately do NOT return 403 for cross-tenant
 * access, because a 403 would confirm the id exists somewhere.
 */
@Injectable()
export class TenantResourceService {
  assertBelongsToTenant<T extends TenantResource>(
    resource: T | null | undefined,
    tenantId: string,
  ): T {
    if (!resource || resource.tenantId !== tenantId) {
      // Same observable outcome for "missing" and "other tenant".
      throw new NotFoundException();
    }
    return resource;
  }
}
