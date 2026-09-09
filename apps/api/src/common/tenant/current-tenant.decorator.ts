import { createParamDecorator, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import type { RequestWithTenant, TenantContext } from './tenant-context';

/**
 * Injects the server-resolved TenantContext into a handler.
 *
 * The context is read only from request.tenantContext, which is populated by
 * the authentication layer from a verified token. If it is absent, the request
 * is not properly authenticated and we refuse rather than trust any client
 * input. Controllers never receive a tenantId from the request payload.
 */
export const CurrentTenant = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): TenantContext => {
    const request = ctx.switchToHttp().getRequest<Request & RequestWithTenant>();
    const tenantContext = request.tenantContext;
    if (!tenantContext) {
      throw new UnauthorizedException();
    }
    return tenantContext;
  },
);
