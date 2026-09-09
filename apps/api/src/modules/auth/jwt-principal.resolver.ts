import { Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { PrincipalResolver } from '../../common/tenant/principal.resolver';
import type { TenantContext } from '../../common/tenant/tenant-context';
import { TokenService } from './token.service';

/**
 * Concrete PrincipalResolver: builds the TenantContext exclusively from a
 * verified access-token JWT in the Authorization: Bearer header.
 *
 * tenantId/userId/roleCodes come from the SIGNED token claims only — never from
 * the request body, query, params, or an arbitrary header. A missing/invalid
 * token yields null (not authenticated).
 */
@Injectable()
export class JwtPrincipalResolver extends PrincipalResolver {
  constructor(private readonly tokens: TokenService) {
    super();
  }

  async resolve(request: Request): Promise<TenantContext | null> {
    const header = request.headers['authorization'];
    if (!header || Array.isArray(header) || !header.startsWith('Bearer ')) {
      return null;
    }
    const token = header.slice('Bearer '.length).trim();
    if (!token) return null;

    try {
      const claims = await this.tokens.verifyAccessToken(token);
      return {
        tenantId: claims.tenantId,
        userId: claims.sub,
        roleCodes: claims.roleCodes,
      };
    } catch {
      return null;
    }
  }
}
