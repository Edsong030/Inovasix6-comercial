import { CanActivate, ExecutionContext, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { InboundCredentialsService, RequestWithInboundService } from './inbound-credentials.service';

/** Same text for every failure: missing, malformed, unknown keyId, wrong secret. */
export const INVALID_SERVICE_CREDENTIAL_MESSAGE = 'Credencial de serviço inválida.';

const MAX_AUTHORIZATION_LENGTH = 1024;
const BASIC = /^Basic\s+([A-Za-z0-9+/_-]+={0,2})$/i;

/**
 * Machine-to-machine authentication for the inbound endpoint.
 *
 * Credentials travel as HTTP Basic: `Authorization: Basic base64(keyId:secret)`.
 * Basic is the standard carrier for a key id + secret pair (curl -u, every HTTP
 * client, Swagger UI), and Authorization is the header logs, proxies and APM
 * tools already scrub, unlike a custom X-... header. It is NOT the user JWT
 * (Bearer): a Bearer token is rejected here like any malformed credential.
 *
 * On success it sets request.inboundService = { tenantId, channel, keyId } from
 * the server-side credential. Nothing in the body/query/headers can change it.
 * Every failure is the same 401 with the same message, so an attacker cannot
 * tell an unknown keyId from a wrong secret. Failures log the client IP only
 * (never the presented keyId or secret).
 */
@Injectable()
export class InboundServiceGuard implements CanActivate {
  private readonly logger = new Logger(InboundServiceGuard.name);

  constructor(private readonly credentials: InboundCredentialsService) {}

  canActivate(context: ExecutionContext): boolean {
    const http = context.switchToHttp();
    const request = http.getRequest<Request & RequestWithInboundService>();
    const response = http.getResponse<Response>();

    const presented = parseBasicCredentials(request.headers['authorization']);
    const caller = presented ? this.credentials.authenticate(presented.keyId, presented.secret) : null;

    if (!caller) {
      this.logger.warn({ event: 'inbound.auth_failed', ip: request.ip });
      response.setHeader('WWW-Authenticate', 'Basic realm="inovasix-inbound", charset="UTF-8"');
      throw new UnauthorizedException(INVALID_SERVICE_CREDENTIAL_MESSAGE);
    }

    request.inboundService = caller;
    return true;
  }
}

/** Decodes `Basic base64(keyId:secret)`; null for anything that is not exactly that. */
export function parseBasicCredentials(
  header: string | string[] | undefined,
): { keyId: string; secret: string } | null {
  if (typeof header !== 'string' || header.length > MAX_AUTHORIZATION_LENGTH) return null;
  const match = BASIC.exec(header);
  if (!match) return null;

  const decoded = Buffer.from(match[1], 'base64').toString('utf8');
  const separator = decoded.indexOf(':'); // keyId cannot contain ":", the secret may
  if (separator <= 0 || separator === decoded.length - 1) return null;
  return { keyId: decoded.slice(0, separator), secret: decoded.slice(separator + 1) };
}
