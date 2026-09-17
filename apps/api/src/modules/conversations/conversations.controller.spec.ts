import { ConversationsController } from './conversations.controller';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

/**
 * Guard wiring check: every handler must require authentication (the actual
 * "unauthenticated request is rejected with 401" BEHAVIOUR is already proven
 * generically by jwt-auth.guard.spec.ts — this just proves the controller
 * actually applies the guard, so that proof is not vacuous).
 *
 * '__guards__' mirrors Nest's own GUARDS_METADATA constant (@nestjs/common):
 * https://github.com/nestjs/nest — used directly rather than deep-importing
 * a non-public subpath.
 *
 * No @Roles()/RolesGuard here by design — see the comment atop
 * ConversationsController: authorization for assign/unassign/state depends on
 * conversation data (who it's assigned to), not just the caller's role, so
 * it lives in ConversationsService instead of controller metadata.
 */
describe('ConversationsController — guard wiring', () => {
  it('requires JwtAuthGuard at the controller level', () => {
    const guards = Reflect.getMetadata('__guards__', ConversationsController) ?? [];
    expect(guards).toContain(JwtAuthGuard);
  });
});
