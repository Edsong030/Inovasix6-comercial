/** Shapes mirrored from the API contract in apps/api/docs/auth.md. */

export type RoleCode = 'ADMIN' | 'GESTOR' | 'COMERCIAL' | 'ATENDENTE';

/** Body of POST /api/auth/login and POST /api/auth/refresh. */
export interface TokenResponse {
  accessToken: string;
  expiresIn: number;
  tokenType: string;
}

/** Body of GET /api/auth/me. */
export interface MeResponse {
  userId: string;
  tenantId: string;
  roles: RoleCode[];
}

/** `me` plus the client-side display fields derived from it. */
export interface SessionUser extends MeResponse {
  /** Company slug the user authenticated with. */
  slug: string;
  /** Human-readable company name derived from the slug. */
  companyName: string;
  /** Display name derived from the e-mail local part. */
  displayName: string;
  /** E-mail typed at login, when known for this browser session. */
  email: string | null;
  /** Portuguese label for the highest-ranking role. */
  roleLabel: string;
  /** Two-letter avatar initials. */
  initials: string;
}

export type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}
