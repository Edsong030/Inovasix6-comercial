import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RoleCode } from '@prisma/client';
import type { Request } from 'express';
import type { RequestWithTenant } from '../../common/tenant/tenant-context';
import { ROLES_KEY } from './roles.decorator';

/**
 * Authorizes based on the role codes in the verified TenantContext (set by
 * JwtAuthGuard). Must run AFTER JwtAuthGuard. Authorization considers the
 * tenant-scoped roles carried in the signed token.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<RoleCode[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const request = context.switchToHttp().getRequest<Request & RequestWithTenant>();
    const roleCodes = request.tenantContext?.roleCodes ?? [];
    const allowed = required.some((r) => roleCodes.includes(r));
    if (!allowed) throw new ForbiddenException();
    return true;
  }
}
