import type { Request } from 'express';
import type { TenantContext } from './tenant-context';

/**
 * Contract for turning an incoming request into a trusted TenantContext.
 *
 * The concrete implementation (delivered with the auth module in a later Step)
 * verifies the JWT access token signature and expiry, then derives tenantId,
 * userId and roleCodes from the *token claims* — not from any client-controlled
 * request field. Returning null means "not authenticated".
 */
export abstract class PrincipalResolver {
  abstract resolve(request: Request): Promise<TenantContext | null>;
}

/** DI token for the resolver implementation. */
export const PRINCIPAL_RESOLVER = Symbol('PRINCIPAL_RESOLVER');
