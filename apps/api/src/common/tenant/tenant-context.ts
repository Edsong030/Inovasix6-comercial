/**
 * Server-resolved tenant/identity context.
 *
 * SECURITY INVARIANT: this is built exclusively from a trusted authenticated
 * principal (the verified JWT access token). It must NEVER be constructed from
 * a client-supplied value — not from the request body, query string, route
 * param, nor an arbitrary header. The frontend cannot choose its own tenantId.
 */
export interface TenantContext {
  readonly tenantId: string;
  readonly userId: string;
  readonly roleCodes: readonly string[];
}

/** Shape attached to the request once an authenticated principal is resolved. */
export interface RequestWithTenant {
  tenantContext?: TenantContext;
}
