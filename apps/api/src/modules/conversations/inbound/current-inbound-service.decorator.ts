import { createParamDecorator, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthenticatedInboundService, RequestWithInboundService } from './inbound-credentials.service';

/**
 * Injects the caller authenticated by InboundServiceGuard (tenantId + channel
 * from the server-side credential). It reads only request.inboundService and
 * refuses when it is absent, so a handler can never fall back to anything the
 * client sent.
 */
export const CurrentInboundService = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedInboundService => {
    const request = ctx.switchToHttp().getRequest<Request & RequestWithInboundService>();
    if (!request.inboundService) throw new UnauthorizedException();
    return request.inboundService;
  },
);
