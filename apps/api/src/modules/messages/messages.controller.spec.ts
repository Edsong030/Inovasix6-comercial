import { MessagesController } from './messages.controller';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

/**
 * Guard wiring check — see conversations.controller.spec.ts for rationale.
 */
describe('MessagesController — guard wiring', () => {
  it('requires JwtAuthGuard at the controller level', () => {
    const guards = Reflect.getMetadata('__guards__', MessagesController) ?? [];
    expect(guards).toContain(JwtAuthGuard);
  });
});
