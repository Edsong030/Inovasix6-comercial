import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PRINCIPAL_RESOLVER } from '../../common/tenant/principal.resolver';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { JwtPrincipalResolver } from './jwt-principal.resolver';
import { PasswordService } from './password.service';
import { RolesGuard } from './roles.guard';
import { TokenService } from './token.service';

/**
 * Authentication module: password hashing, JWT tokens, session lifecycle,
 * guards, and the JWT-based PrincipalResolver used to derive TenantContext from
 * verified access tokens.
 */
@Module({
  imports: [JwtModule.register({})],
  controllers: [AuthController],
  providers: [
    AuthService,
    PasswordService,
    TokenService,
    JwtAuthGuard,
    RolesGuard,
    JwtPrincipalResolver,
    { provide: PRINCIPAL_RESOLVER, useExisting: JwtPrincipalResolver },
  ],
  exports: [AuthService, TokenService, JwtAuthGuard, RolesGuard, PRINCIPAL_RESOLVER],
})
export class AuthModule {}
