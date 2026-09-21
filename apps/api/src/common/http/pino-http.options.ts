import { webhookSafeRequestSerializer } from '../../modules/whatsapp/webhook/whatsapp-webhook.http';

/**
 * Options of the HTTP request logger (pino-http through nestjs-pino), kept in
 * one exported place so a test can exercise the REAL redaction rules instead of
 * a copy of them.
 */
export const pinoHttpOptions = {
  // The WhatsApp verify token travels in the query string of the GET handshake: drop it from the URL
  // and query of that route's log line (other routes are logged exactly as before).
  serializers: { req: webhookSafeRequestSerializer },
  redact: [
    'req.headers.authorization',
    'req.headers.cookie',
    // Meta's webhook signature: not a key, but no reason to keep it in logs.
    'req.headers["x-hub-signature-256"]',
    'password',
    'passwordHash',
    'accessToken',
    'refreshToken',
    'refreshTokenHash',
    'JWT_ACCESS_SECRET',
    'JWT_REFRESH_SECRET',
    'DATABASE_URL',
    'REDIS_URL',
  ],
};
