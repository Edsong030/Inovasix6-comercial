import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { RequestWithInboundService } from './inbound-credentials.service';

/**
 * Error mapping for the inbound endpoint only.
 *
 * - HttpException (400 validation/phone, 401, 409, 429, ...) keeps its status
 *   and body exactly like Nest's default handler.
 * - Anything else becomes a generic 500 and is logged as error NAME (and Prisma
 *   code) only. Nest's default handler would log the whole error, and a Prisma
 *   error message can quote the query and the data being written, i.e. the
 *   customer's message and phone.
 */
@Catch()
export class InboundExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('ConversationInbound');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request & RequestWithInboundService>();
    const response = http.getResponse<Response>();
    const caller = request.inboundService;
    const context = caller ? { keyId: caller.keyId, tenantId: caller.tenantId, channel: caller.channel } : {};

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      if (caller && status >= 400) this.logger.warn({ event: 'inbound.rejected', status, ...context });
      const body = exception.getResponse();
      response.status(status).json(typeof body === 'string' ? { statusCode: status, message: body } : body);
      return;
    }

    const error = exception as { name?: unknown; code?: unknown } | null;
    this.logger.error({
      event: 'inbound.error',
      errorName: typeof error?.name === 'string' ? error.name : 'UnknownError',
      code: typeof error?.code === 'string' ? error.code : undefined,
      ...context,
    });
    response.status(500).json({ statusCode: 500, message: 'Internal server error' });
  }
}
