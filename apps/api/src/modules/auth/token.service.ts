import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes } from 'node:crypto';
import { AppConfigService } from '../../config/app-config.service';
import type { AccessTokenClaims, RefreshTokenClaims } from './auth.types';

/**
 * Signs/verifies JWTs and derives the storable hash of a refresh token.
 *
 * - Access token: short-lived, signed with JWT_ACCESS_SECRET, carries
 *   sub/tenantId/roleCodes/sessionId.
 * - Refresh token: longer-lived, signed with JWT_REFRESH_SECRET, carries
 *   sub/tenantId/sessionId plus a random jti so each issued token is unique
 *   (enables rotation + reuse detection). Only its SHA-256 hash is persisted.
 */
@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: AppConfigService,
  ) {}

  async signAccessToken(claims: AccessTokenClaims): Promise<string> {
    return this.jwt.signAsync(
      { tenantId: claims.tenantId, roleCodes: claims.roleCodes, sessionId: claims.sessionId },
      {
        subject: claims.sub,
        secret: this.config.jwtAccessSecret,
        expiresIn: this.config.accessTokenTtlSec,
      },
    );
  }

  async signRefreshToken(claims: RefreshTokenClaims): Promise<string> {
    return this.jwt.signAsync(
      { tenantId: claims.tenantId, sessionId: claims.sessionId, jti: randomBytes(16).toString('hex') },
      {
        subject: claims.sub,
        secret: this.config.jwtRefreshSecret,
        expiresIn: this.config.refreshTokenTtlSec,
      },
    );
  }

  async verifyAccessToken(token: string): Promise<AccessTokenClaims> {
    const payload = await this.jwt.verifyAsync<{
      sub: string;
      tenantId: string;
      roleCodes: string[];
      sessionId: string;
    }>(token, { secret: this.config.jwtAccessSecret });
    return {
      sub: payload.sub,
      tenantId: payload.tenantId,
      roleCodes: payload.roleCodes ?? [],
      sessionId: payload.sessionId,
    };
  }

  async verifyRefreshToken(token: string): Promise<RefreshTokenClaims> {
    const payload = await this.jwt.verifyAsync<{
      sub: string;
      tenantId: string;
      sessionId: string;
    }>(token, { secret: this.config.jwtRefreshSecret });
    return { sub: payload.sub, tenantId: payload.tenantId, sessionId: payload.sessionId };
  }

  /** Stable, non-reversible fingerprint of a refresh token for storage/comparison. */
  hashRefreshToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  get accessTtlSec(): number {
    return this.config.accessTokenTtlSec;
  }

  get refreshTtlSec(): number {
    return this.config.refreshTokenTtlSec;
  }
}
