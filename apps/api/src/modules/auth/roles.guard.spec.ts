import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RoleCode } from '@prisma/client';
import { RolesGuard } from './roles.guard';

function ctxWithRoles(roleCodes: RoleCode[]): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ tenantContext: { roleCodes } }) }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
}

describe('RolesGuard', () => {
  it('allows when no roles are required', () => {
    const reflector = { getAllAndOverride: () => undefined } as unknown as Reflector;
    const guard = new RolesGuard(reflector);
    expect(guard.canActivate(ctxWithRoles([]))).toBe(true);
  });

  it('allows when the user has a required role', () => {
    const reflector = {
      getAllAndOverride: () => [RoleCode.ADMIN],
    } as unknown as Reflector;
    const guard = new RolesGuard(reflector);
    expect(guard.canActivate(ctxWithRoles([RoleCode.ADMIN, RoleCode.COMERCIAL]))).toBe(true);
  });

  it('denies when the user lacks the required role', () => {
    const reflector = {
      getAllAndOverride: () => [RoleCode.ADMIN],
    } as unknown as Reflector;
    const guard = new RolesGuard(reflector);
    expect(() => guard.canActivate(ctxWithRoles([RoleCode.ATENDENTE]))).toThrow(ForbiddenException);
  });
});
