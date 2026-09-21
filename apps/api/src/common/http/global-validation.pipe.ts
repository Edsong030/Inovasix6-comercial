import { ValidationPipe } from '@nestjs/common';

/**
 * The application-wide ValidationPipe, defined once so main.ts and the HTTP
 * tests use the exact same options:
 *  - whitelist + forbidNonWhitelisted: unknown properties are rejected with
 *    400, not silently dropped (this is what stops a body from smuggling
 *    tenantId/channel into the inbound endpoint);
 *  - transform: bodies become their DTO class instances.
 */
export function createGlobalValidationPipe(): ValidationPipe {
  return new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
}
