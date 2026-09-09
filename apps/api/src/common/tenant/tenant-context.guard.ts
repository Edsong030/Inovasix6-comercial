import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { PRINCIPAL_RESOLVER, PrincipalResolver } from './principal.resolver';
import type { RequestWithTenant } from './tenant-context';

/**
 * Establishes the server-resolved TenantContext on the request.
 *
 * It delegates identity resolution to a PrincipalResolver (which reads verified
 * token claims). It does NOT read tenantId from the body/query/params/headers.
 * A plain per-request property is used instead of a request-scoped provider to
 * avoid the cost of rebuilding the DI subtree on every request.
 */
@Injectable()
export class TenantContextGuard implements CanActivate {
  constructor(
    @Inject(PRINCIPAL_RESOLVER) private readonly principalResolver: PrincipalResolver,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request & RequestWithTenant>();
    const tenantContext = await this.principalResolver.resolve(request);
    if (!tenantContext) {
      throw new UnauthorizedException();
    }
    request.tenantContext = tenantContext;
    return true;
  }
}
