import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import type { RequestWithTenant } from '../../common/tenant/tenant-context';
import { TokenService } from './token.service';

/** Request augmented with the verified access-token session id. */
export interface RequestWithSession extends RequestWithTenant {
  sessionId?: string;
}

/**
 * Authenticates a request from a verified access-token JWT and populates
 * request.tenantContext (+ sessionId) from the signed claims only.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly tokens: TokenService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request & RequestWithSession>();
    const header = request.headers['authorization'];
    if (!header || Array.isArray(header) || !header.startsWith('Bearer ')) {
      throw new UnauthorizedException();
    }
    const token = header.slice('Bearer '.length).trim();
    try {
      const claims = await this.tokens.verifyAccessToken(token);
      request.tenantContext = {
        tenantId: claims.tenantId,
        userId: claims.sub,
        roleCodes: claims.roleCodes,
      };
      request.sessionId = claims.sessionId;
      return true;
    } catch {
      throw new UnauthorizedException();
    }
  }
}
