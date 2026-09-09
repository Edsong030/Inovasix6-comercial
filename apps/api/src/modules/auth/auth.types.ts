/** Verified access-token claims. tenantId here is authoritative (came from a signed JWT). */
export interface AccessTokenClaims {
  sub: string; // userId
  tenantId: string;
  roleCodes: string[];
  sessionId: string;
}

/** Verified refresh-token claims. The raw token also encodes the session it belongs to. */
export interface RefreshTokenClaims {
  sub: string; // userId
  tenantId: string;
  sessionId: string;
}

/** Tokens returned to the caller. The refresh token travels in an HttpOnly cookie. */
export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresInSec: number;
  refreshTokenExpiresInSec: number;
}
