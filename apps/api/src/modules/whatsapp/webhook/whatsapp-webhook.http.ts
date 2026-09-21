import type { INestApplication } from '@nestjs/common';
import { raw } from 'express';
import type { NextFunction, Request, Response } from 'express';

/**
 * HTTP plumbing the webhook needs that Nest's defaults do not give it.
 *
 * RAW BODY. Meta's signature is over the exact bytes it sent, so the route must
 * receive those bytes: Nest's JSON parser would hand back a parsed object and
 * re-serializing it (JSON.stringify) can change whitespace, key order or unicode
 * escaping, breaking a valid signature or, worse, verifying something other
 * than what was signed. So this one route gets express.raw (req.body is a
 * Buffer) and the JSON is parsed by the service only AFTER the signature check.
 * It is mounted on this route alone: every other endpoint keeps its parser and
 * its default body limit, untouched.
 *
 *  - limit 3 MB: the maximum webhook size Meta documents (larger => 413);
 *  - any content type: the signature, not the header, is the authentication;
 *  - inflate off: no compressed bodies (decompression bombs), Meta does not send them.
 *
 * It must be registered BEFORE app.init() (main.ts, and the test bootstrap) so
 * it runs before Nest's own JSON parser, which then skips a body already read.
 */
export const WHATSAPP_WEBHOOK_ROUTE = '/api/webhooks/whatsapp';
export const WHATSAPP_WEBHOOK_MAX_BYTES = 3 * 1024 * 1024;

export function configureWhatsAppWebhookBodyParser(app: INestApplication, enabled: boolean): void {
  // Integration off: register nothing, so a disabled deployment does not even buffer up to 3 MB
  // for a route that answers 404 (Nest's default parser and its small limit apply).
  if (!enabled) return;
  const parser = raw({ type: () => true, limit: WHATSAPP_WEBHOOK_MAX_BYTES, inflate: false });

  app.use(
    WHATSAPP_WEBHOOK_ROUTE,
    (request: Request, response: Response, next: NextFunction) => (request.method === 'POST' ? parser(request, response, next) : next()),
    // Body-parser errors (too large, unsupported encoding) reach Express' default handler, which in
    // development prints a stack trace: answer them here with a plain JSON error instead.
    (error: { status?: number; statusCode?: number } | undefined, _request: Request, response: Response, next: NextFunction) => {
      if (!error) return next();
      const status = error.status ?? error.statusCode ?? 400;
      const message = status === 413 ? 'Payload too large' : 'Invalid request body';
      response.status(status >= 400 && status < 500 ? status : 400).json({ statusCode: status, message });
    },
  );
}

/**
 * pino-http serializer for the request log line. The webhook verification puts
 * the verify token in the QUERY STRING (`?hub.verify_token=...`), and the
 * default serializer logs the full URL and the parsed query: that would write
 * the secret to the log on every handshake. For this route the query string is
 * dropped from both; every other route is logged exactly as before.
 */
export function webhookSafeRequestSerializer<T extends { url?: string; query?: unknown }>(req: T): T {
  if (typeof req.url !== 'string' || !req.url.startsWith(WHATSAPP_WEBHOOK_ROUTE)) return req;
  const [path] = req.url.split('?');
  return { ...req, url: path, query: undefined };
}
