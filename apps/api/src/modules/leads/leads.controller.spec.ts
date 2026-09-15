import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RoleCode } from '@prisma/client';
import { ROLES_KEY } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { LeadsController } from './leads.controller';

const ALL_ROLES = [RoleCode.ADMIN, RoleCode.GESTOR, RoleCode.COMERCIAL, RoleCode.ATENDENTE];
const NO_ATENDENTE = [RoleCode.ADMIN, RoleCode.GESTOR, RoleCode.COMERCIAL];

/** Minimal ExecutionContext: real RolesGuard only reads getHandler/getClass and tenantContext. */
function ctxFor(handler: (...args: any[]) => unknown, roleCodes: RoleCode[]): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ tenantContext: { roleCodes } }) }),
    getHandler: () => handler,
    getClass: () => LeadsController,
  } as unknown as ExecutionContext;
}

describe('LeadsController — RBAC metadata (approved matrix)', () => {
  const reflector = new Reflector();

  it.each([
    ['list (GET /leads)', LeadsController.prototype.list, ALL_ROLES],
    ['getById (GET /leads/:id)', LeadsController.prototype.getById, ALL_ROLES],
    ['create (POST /leads)', LeadsController.prototype.create, ALL_ROLES],
    ['update (PATCH /leads/:id)', LeadsController.prototype.update, NO_ATENDENTE],
    ['moveStage (PATCH /leads/:id/stage)', LeadsController.prototype.moveStage, NO_ATENDENTE],
  ])('%s declares exactly the approved @Roles', (_name, handler, expected) => {
    expect(reflector.get<RoleCode[]>(ROLES_KEY, handler)).toEqual(expected);
  });

  it('update and moveStage do NOT include ATENDENTE', () => {
    expect(reflector.get<RoleCode[]>(ROLES_KEY, LeadsController.prototype.update)).not.toContain(
      RoleCode.ATENDENTE,
    );
    expect(
      reflector.get<RoleCode[]>(ROLES_KEY, LeadsController.prototype.moveStage),
    ).not.toContain(RoleCode.ATENDENTE);
  });
});

describe('LeadsController — real RolesGuard enforcing the real controller metadata', () => {
  const guard = new RolesGuard(new Reflector());

  it.each(ALL_ROLES)('allows %s on GET /leads', (role) => {
    expect(guard.canActivate(ctxFor(LeadsController.prototype.list, [role]))).toBe(true);
  });

  it.each(ALL_ROLES)('allows %s on GET /leads/:id', (role) => {
    expect(guard.canActivate(ctxFor(LeadsController.prototype.getById, [role]))).toBe(true);
  });

  it.each(ALL_ROLES)('allows %s on POST /leads', (role) => {
    expect(guard.canActivate(ctxFor(LeadsController.prototype.create, [role]))).toBe(true);
  });

  it.each(NO_ATENDENTE)('allows %s on PATCH /leads/:id', (role) => {
    expect(guard.canActivate(ctxFor(LeadsController.prototype.update, [role]))).toBe(true);
  });

  it('denies ATENDENTE on PATCH /leads/:id with 403 (Forbidden)', () => {
    expect(() =>
      guard.canActivate(ctxFor(LeadsController.prototype.update, [RoleCode.ATENDENTE])),
    ).toThrow(ForbiddenException);
  });

  it.each(NO_ATENDENTE)('allows %s on PATCH /leads/:id/stage', (role) => {
    expect(guard.canActivate(ctxFor(LeadsController.prototype.moveStage, [role]))).toBe(true);
  });

  it('denies ATENDENTE on PATCH /leads/:id/stage with 403 (Forbidden)', () => {
    expect(() =>
      guard.canActivate(ctxFor(LeadsController.prototype.moveStage, [RoleCode.ATENDENTE])),
    ).toThrow(ForbiddenException);
  });

  it('denies a role with no match at all (fail-closed), not just ATENDENTE', () => {
    expect(() =>
      guard.canActivate(ctxFor(LeadsController.prototype.update, [] as RoleCode[])),
    ).toThrow(ForbiddenException);
  });
});
