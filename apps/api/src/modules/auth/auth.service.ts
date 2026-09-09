import { Injectable, UnauthorizedException } from '@nestjs/common';
import { Prisma, RoleCode, UserStatus } from '@prisma/client';
import { Logger } from 'nestjs-pino';
import { PrismaService, TenantTx } from '../../prisma/prisma.service';
import { AuthAuditAction } from './auth-audit';
import type { IssuedTokens } from './auth.types';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';

/** Result of a successful authentication, plus the resolved principal. */
export interface AuthResult extends IssuedTokens {
  userId: string;
  tenantId: string;
  roleCodes: RoleCode[];
}

interface LoginLookupRow {
  tenant_id: string;
  user_id: string;
  password_hash: string;
  status: UserStatus;
  role_codes: string[];
}

export interface RequestMeta {
  ip?: string;
  userAgent?: string;
}

/** Generic message for every login failure (anti-enumeration). */
const INVALID_CREDENTIALS = 'Credenciais inválidas.';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly logger: Logger,
  ) {}

  /**
   * Authenticate by (slug, email, password). The tenant is derived server-side
   * from the slug via the SECURITY DEFINER lookup — never from client input.
   * Every failure path returns the same generic error and audits LOGIN_FAILED
   * without leaking which check failed.
   */
  async login(
    slug: string,
    email: string,
    password: string,
    meta: RequestMeta,
  ): Promise<AuthResult> {
    const rows = await this.prisma.$queryRaw<LoginLookupRow[]>`
      SELECT tenant_id, user_id, password_hash, status, role_codes
      FROM auth_lookup_login(${slug}, ${email})
    `;
    const row = rows[0];

    // Unknown tenant/email: still spend time verifying against a dummy hash to
    // reduce timing signal, then fail generically.
    if (!row) {
      await this.passwords.verify(
        '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$3g2Z1p6b3JhbmRvbWhhc2h2YWx1ZQ',
        password,
      );
      this.logger.warn({ action: AuthAuditAction.LOGIN_FAILED, reason: 'no_match' });
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    const passwordOk = await this.passwords.verify(row.password_hash, password);
    if (!passwordOk) {
      await this.audit(row.tenant_id, row.user_id, AuthAuditAction.LOGIN_FAILED, {
        reason: 'bad_password',
      });
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    // Status policy: only ACTIVE may log in. INVITED must accept the invite and
    // set a password first; SUSPENDED is denied. Both fail with the same generic
    // message to avoid leaking account state.
    if (row.status !== UserStatus.ACTIVE) {
      await this.audit(row.tenant_id, row.user_id, AuthAuditAction.LOGIN_FAILED, {
        reason: `status_${row.status.toLowerCase()}`,
      });
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    const roleCodes = row.role_codes.filter((c): c is RoleCode =>
      (Object.values(RoleCode) as string[]).includes(c),
    );

    // Opportunistic rehash if the stored hash uses weaker params.
    if (this.passwords.needsRehash(row.password_hash)) {
      const newHash = await this.passwords.hash(password);
      await this.prisma.runWithTenant(row.tenant_id, (tx) =>
        tx.user.update({ where: { id: row.user_id }, data: { passwordHash: newHash } }),
      );
    }

    const issued = await this.createSession(row.tenant_id, row.user_id, roleCodes, meta);
    await this.audit(row.tenant_id, row.user_id, AuthAuditAction.LOGIN_SUCCESS, {
      sessionId: issued.sessionId,
    });

    return {
      userId: row.user_id,
      tenantId: row.tenant_id,
      roleCodes,
      accessToken: issued.accessToken,
      refreshToken: issued.refreshToken,
      accessTokenExpiresInSec: issued.accessTokenExpiresInSec,
      refreshTokenExpiresInSec: issued.refreshTokenExpiresInSec,
    };
  }

  /**
   * Refresh with rotation + reuse detection.
   * - Verifies the refresh JWT signature/expiry.
   * - Loads the session; if missing/revoked/expired => 401.
   * - If the presented token's hash does NOT match the stored current hash, the
   *   token was already rotated (replay/theft) => revoke the session and 401.
   * - Otherwise rotate: issue a new refresh token, store its hash, update the
   *   session, and issue a fresh access token.
   */
  async refresh(rawRefreshToken: string, meta: RequestMeta): Promise<AuthResult> {
    let claims;
    try {
      claims = await this.tokens.verifyRefreshToken(rawRefreshToken);
    } catch {
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    const presentedHash = this.tokens.hashRefreshToken(rawRefreshToken);

    return this.prisma.runWithTenant(claims.tenantId, async (tx) => {
      const session = await tx.authSession.findUnique({ where: { id: claims.sessionId } });

      if (!session || session.userId !== claims.sub || session.tenantId !== claims.tenantId) {
        throw new UnauthorizedException(INVALID_CREDENTIALS);
      }
      if (session.revokedAt || session.expiresAt.getTime() <= Date.now()) {
        throw new UnauthorizedException(INVALID_CREDENTIALS);
      }

      // Reuse detection: presented token is not the current one for this session.
      if (session.refreshTokenHash !== presentedHash) {
        await tx.authSession.update({
          where: { id: session.id },
          data: { revokedAt: new Date() },
        });
        await this.auditTx(tx, claims.tenantId, claims.sub, AuthAuditAction.SESSION_REVOKED, {
          reason: 'refresh_reuse_detected',
          sessionId: session.id,
        });
        throw new UnauthorizedException(INVALID_CREDENTIALS);
      }

      const roleCodes = await this.loadRoleCodes(tx, claims.sub);

      // Rotate the refresh token in place.
      const newRefreshToken = await this.tokens.signRefreshToken({
        sub: claims.sub,
        tenantId: claims.tenantId,
        sessionId: session.id,
      });
      const newRefreshHash = this.tokens.hashRefreshToken(newRefreshToken);
      const refreshTtl = this.tokensRefreshTtl();

      await tx.authSession.update({
        where: { id: session.id },
        data: {
          refreshTokenHash: newRefreshHash,
          lastUsedAt: new Date(),
          expiresAt: new Date(Date.now() + refreshTtl * 1000),
          ip: meta.ip ?? session.ip,
          userAgent: meta.userAgent ?? session.userAgent,
        },
      });

      const accessToken = await this.tokens.signAccessToken({
        sub: claims.sub,
        tenantId: claims.tenantId,
        roleCodes,
        sessionId: session.id,
      });

      await this.auditTx(tx, claims.tenantId, claims.sub, AuthAuditAction.TOKEN_REFRESH, {
        sessionId: session.id,
      });

      return {
        userId: claims.sub,
        tenantId: claims.tenantId,
        roleCodes,
        accessToken,
        refreshToken: newRefreshToken,
        accessTokenExpiresInSec: this.tokensAccessTtl(),
        refreshTokenExpiresInSec: refreshTtl,
      };
    });
  }

  /** Revoke a single session (logout). Idempotent. */
  async logout(tenantId: string, userId: string, sessionId: string): Promise<void> {
    await this.prisma.runWithTenant(tenantId, async (tx) => {
      const result = await tx.authSession.updateMany({
        where: { id: sessionId, userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (result.count > 0) {
        await this.auditTx(tx, tenantId, userId, AuthAuditAction.LOGOUT, { sessionId });
      }
    });
  }

  /** Revoke every active session of the user within the tenant. */
  async logoutAll(tenantId: string, userId: string): Promise<number> {
    return this.prisma.runWithTenant(tenantId, async (tx) => {
      const result = await tx.authSession.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await this.auditTx(tx, tenantId, userId, AuthAuditAction.LOGOUT_ALL, {
        revoked: result.count,
      });
      return result.count;
    });
  }

  // -- helpers ---------------------------------------------------------------

  private async createSession(
    tenantId: string,
    userId: string,
    roleCodes: RoleCode[],
    meta: RequestMeta,
  ): Promise<IssuedTokens & { sessionId: string }> {
    const refreshTtl = this.tokensRefreshTtl();

    return this.prisma.runWithTenant(tenantId, async (tx) => {
      const session = await tx.authSession.create({
        data: {
          tenantId,
          userId,
          refreshTokenHash: 'pending',
          expiresAt: new Date(Date.now() + refreshTtl * 1000),
          ip: meta.ip,
          userAgent: meta.userAgent,
          lastUsedAt: new Date(),
        },
      });

      const refreshToken = await this.tokens.signRefreshToken({
        sub: userId,
        tenantId,
        sessionId: session.id,
      });
      await tx.authSession.update({
        where: { id: session.id },
        data: { refreshTokenHash: this.tokens.hashRefreshToken(refreshToken) },
      });

      const accessToken = await this.tokens.signAccessToken({
        sub: userId,
        tenantId,
        roleCodes,
        sessionId: session.id,
      });

      return {
        sessionId: session.id,
        accessToken,
        refreshToken,
        accessTokenExpiresInSec: this.tokensAccessTtl(),
        refreshTokenExpiresInSec: refreshTtl,
      };
    });
  }

  private async loadRoleCodes(tx: TenantTx, userId: string): Promise<RoleCode[]> {
    const rows = await tx.userRole.findMany({
      where: { userId },
      include: { role: true },
    });
    return rows.map((r) => r.role.code);
  }

  private async audit(
    tenantId: string,
    userId: string | null,
    action: AuthAuditAction,
    after: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.runWithTenant(tenantId, (tx) =>
      this.auditTx(tx, tenantId, userId, action, after),
    );
  }

  private async auditTx(
    tx: TenantTx,
    tenantId: string,
    userId: string | null,
    action: AuthAuditAction,
    after: Record<string, unknown>,
  ): Promise<void> {
    await tx.auditLog.create({
      data: {
        tenantId,
        actorId: userId,
        action,
        entity: 'AuthSession',
        after: after as Prisma.InputJsonValue,
      },
    });
  }

  private tokensAccessTtl(): number {
    return this.tokens.accessTtlSec;
  }

  private tokensRefreshTtl(): number {
    return this.tokens.refreshTtlSec;
  }
}
