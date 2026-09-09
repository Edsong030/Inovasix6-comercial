/** Audit action codes for authentication events. Never store secrets/tokens. */
export enum AuthAuditAction {
  LOGIN_SUCCESS = 'LOGIN_SUCCESS',
  LOGIN_FAILED = 'LOGIN_FAILED',
  TOKEN_REFRESH = 'TOKEN_REFRESH',
  LOGOUT = 'LOGOUT',
  LOGOUT_ALL = 'LOGOUT_ALL',
  SESSION_REVOKED = 'SESSION_REVOKED',
}
