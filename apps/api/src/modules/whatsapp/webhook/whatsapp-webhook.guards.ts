import { CanActivate, ExecutionContext, Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { AppConfigService } from '../../../config/app-config.service';
import { checkMetaSignature } from './meta-signature';

/**
 * The webhook endpoints exist only while WHATSAPP_CLOUD_ENABLED=true; otherwise
 * they answer 404 exactly like a route that was never registered, so a
 * deployment that has not switched the integration on exposes nothing.
 */
@Injectable()
export class WhatsAppEnabledGuard implements CanActivate {
  constructor(private readonly config: AppConfigService) {}

  canActivate(): boolean {
    if (!this.config.whatsappCloud.enabled) throw new NotFoundException();
    return true;
  }
}

/**
 * Authenticates a webhook notification: X-Hub-Signature-256 must be the
 * HMAC-SHA256, keyed with the Meta App Secret, of the raw bytes received.
 *
 * It runs BEFORE the body is parsed as JSON (the route receives the raw
 * Buffer, see whatsapp-webhook.http.ts), so an unauthenticated caller can make
 * the server do no more than hash a body it will then discard, and learns
 * nothing from the response: every failure is the same generic 401. The
 * specific reason (missing / malformed / mismatch) is only logged, without any
 * header value, body or secret.
 */
@Injectable()
export class MetaSignatureGuard implements CanActivate {
  private readonly logger = new Logger(MetaSignatureGuard.name);

  constructor(private readonly config: AppConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const body: unknown = request.body;
    const check = Buffer.isBuffer(body)
      ? checkMetaSignature(body, request.headers['x-hub-signature-256'], this.config.whatsappCloud.appSecret)
      : ({ valid: false, reason: 'missing' } as const);

    if (!check.valid) {
      this.logger.warn({ event: 'whatsapp.webhook.rejected', reason: check.reason });
      throw new UnauthorizedException();
    }
    return true;
  }
}
