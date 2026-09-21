import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Response } from 'express';

/**
 * Error mapping for the webhook routes only. HttpExceptions (401, 400, 403,
 * 404, 503, ...) keep their status and body; anything else becomes a generic 500
 * and is logged as error NAME (and Prisma code) only, because Nest's default
 * handler would log the whole error and a Prisma message can quote the data
 * being written, i.e. a customer's text or phone number.
 */
@Catch()
export class WhatsAppWebhookExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('WhatsAppWebhook');

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      response.status(status).json(typeof body === 'string' ? { statusCode: status, message: body } : body);
      return;
    }

    const error = exception as { name?: unknown; code?: unknown } | null;
    this.logger.error({
      event: 'whatsapp.webhook.error',
      errorName: typeof error?.name === 'string' ? error.name : 'UnknownError',
      code: typeof error?.code === 'string' ? error.code : undefined,
    });
    response.status(500).json({ statusCode: 500, message: 'Internal server error' });
  }
}
