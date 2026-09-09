import { UnauthorizedException } from '@nestjs/common';
import { RoleCode, UserStatus } from '@prisma/client';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';

/**
 * Unit tests for AuthService with an in-memory fake of the tenant transaction.
 * These validate the auth decision logic without a real database.
 */
describe('AuthService', () => {
  const TENANT = 'tenant-a';
  const USER = 'user-a';

  let sessions: Map<string, any>;
  let users: Map<string, any>;
  let lookupRow: any;

  let passwords: jest.Mocked<Pick<PasswordService, 'verify' | 'hash' | 'needsRehash'>>;
  let tokens: jest.Mocked<
    Pick<
      TokenService,
      | 'signAccessToken'
      | 'signRefreshToken'
      | 'verifyRefreshToken'
      | 'hashRefreshToken'
      | 'accessTtlSec'
      | 'refreshTtlSec'
    >
  >;
  let prisma: any;
  let service: AuthService;

  function makeTx() {
    return {
      authSession: {
        create: jest.fn(async ({ data }: any) => {
          const id = data.id ?? `sess-${sessions.size + 1}`;
          const row = { id, ...data };
          sessions.set(id, row);
          return row;
        }),
        findUnique: jest.fn(async ({ where }: any) => sessions.get(where.id) ?? null),
        update: jest.fn(async ({ where, data }: any) => {
          const row = { ...sessions.get(where.id), ...data };
          sessions.set(where.id, row);
          return row;
        }),
        updateMany: jest.fn(async ({ where, data }: any) => {
          let count = 0;
          for (const row of sessions.values()) {
            const matchId = where.id ? row.id === where.id : true;
            const matchUser = where.userId ? row.userId === where.userId : true;
            const matchActive = where.revokedAt === null ? !row.revokedAt : true;
            if (matchId && matchUser && matchActive) {
              Object.assign(row, data);
              count++;
            }
          }
          return { count };
        }),
      },
      user: {
        update: jest.fn(async ({ where, data }: any) => {
          const row = { ...users.get(where.id), ...data };
          users.set(where.id, row);
          return row;
        }),
      },
      userRole: {
        findMany: jest.fn(async () => [{ role: { code: RoleCode.ADMIN } }]),
      },
      auditLog: { create: jest.fn(async () => ({})) },
    };
  }

  beforeEach(() => {
    sessions = new Map();
    users = new Map([[USER, { id: USER, passwordHash: 'stored-hash' }]]);
    lookupRow = {
      tenant_id: TENANT,
      user_id: USER,
      password_hash: 'stored-hash',
      status: UserStatus.ACTIVE,
      role_codes: [RoleCode.ADMIN],
    };

    passwords = {
      verify: jest.fn().mockResolvedValue(true),
      hash: jest.fn().mockResolvedValue('new-hash'),
      needsRehash: jest.fn().mockReturnValue(false),
    };

    let refreshCounter = 0;
    tokens = {
      signAccessToken: jest.fn().mockResolvedValue('access.jwt'),
      signRefreshToken: jest.fn().mockImplementation(async () => `refresh.jwt.${++refreshCounter}`),
      verifyRefreshToken: jest.fn(),
      hashRefreshToken: jest.fn().mockImplementation((t: string) => `hash(${t})`),
      accessTtlSec: 900,
      refreshTtlSec: 604800,
    };

    const tx = makeTx();
    prisma = {
      $queryRaw: jest.fn(async () => (lookupRow ? [lookupRow] : [])),
      runWithTenant: jest.fn(async (_tenant: string, work: any) => work(tx)),
      _tx: tx,
    };

    service = new AuthService(
      prisma,
      passwords as unknown as PasswordService,
      tokens as unknown as TokenService,
      { warn: jest.fn(), log: jest.fn(), error: jest.fn() } as any,
    );
  });

  it('logs in with valid credentials and returns tokens + context', async () => {
    const res = await service.login('inovasix-demo', 'edson@demo.local', 'pw', {});
    expect(res.userId).toBe(USER);
    expect(res.tenantId).toBe(TENANT);
    expect(res.roleCodes).toEqual([RoleCode.ADMIN]);
    expect(res.accessToken).toBe('access.jwt');
    expect(res.refreshToken).toMatch(/^refresh\.jwt\./);
  });

  it('rejects an invalid password with generic error', async () => {
    passwords.verify.mockResolvedValue(false);
    await expect(service.login('s', 'e', 'bad', {})).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a nonexistent user/tenant with the same generic error', async () => {
    lookupRow = null;
    await expect(service.login('nope', 'ghost@x', 'pw', {})).rejects.toThrow(UnauthorizedException);
    // Still calls verify against a dummy hash to reduce timing signal.
    expect(passwords.verify).toHaveBeenCalled();
  });

  it('denies a SUSPENDED user', async () => {
    lookupRow.status = UserStatus.SUSPENDED;
    await expect(service.login('s', 'e', 'pw', {})).rejects.toThrow(UnauthorizedException);
  });

  it('denies an INVITED user (must accept invite first)', async () => {
    lookupRow.status = UserStatus.INVITED;
    await expect(service.login('s', 'e', 'pw', {})).rejects.toThrow(UnauthorizedException);
  });

  it('rehashes the password when params are outdated', async () => {
    passwords.needsRehash.mockReturnValue(true);
    await service.login('s', 'e', 'pw', {});
    expect(passwords.hash).toHaveBeenCalledWith('pw');
    expect(prisma._tx.user.update).toHaveBeenCalled();
  });

  it('refreshes with a valid token and rotates it', async () => {
    const login = await service.login('s', 'e', 'pw', {});
    const sessionId = [...sessions.keys()][0];
    tokens.verifyRefreshToken.mockResolvedValue({ sub: USER, tenantId: TENANT, sessionId });
    // The stored hash must match the presented token hash.
    const stored = sessions.get(sessionId);
    tokens.hashRefreshToken.mockImplementation((t: string) =>
      t === 'presented' ? stored.refreshTokenHash : `hash(${t})`,
    );

    const res = await service.refresh('presented', {});
    expect(res.accessToken).toBe('access.jwt');
    expect(res.refreshToken).toMatch(/^refresh\.jwt\./);
    // Stored hash changed (rotation).
    expect(sessions.get(sessionId).refreshTokenHash).not.toBe(stored.refreshTokenHash);
    expect(login.refreshToken).not.toBe(res.refreshToken);
  });

  it('rejects an invalid refresh token', async () => {
    tokens.verifyRefreshToken.mockRejectedValue(new Error('bad'));
    await expect(service.refresh('garbage', {})).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a refresh for an expired session', async () => {
    await service.login('s', 'e', 'pw', {});
    const sessionId = [...sessions.keys()][0];
    sessions.get(sessionId).expiresAt = new Date(Date.now() - 1000);
    tokens.verifyRefreshToken.mockResolvedValue({ sub: USER, tenantId: TENANT, sessionId });
    await expect(service.refresh('x', {})).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a refresh for a revoked session', async () => {
    await service.login('s', 'e', 'pw', {});
    const sessionId = [...sessions.keys()][0];
    sessions.get(sessionId).revokedAt = new Date();
    tokens.verifyRefreshToken.mockResolvedValue({ sub: USER, tenantId: TENANT, sessionId });
    await expect(service.refresh('x', {})).rejects.toThrow(UnauthorizedException);
  });

  it('detects refresh reuse and revokes the session', async () => {
    await service.login('s', 'e', 'pw', {});
    const sessionId = [...sessions.keys()][0];
    tokens.verifyRefreshToken.mockResolvedValue({ sub: USER, tenantId: TENANT, sessionId });
    // Presented hash does NOT match stored current hash => reuse.
    tokens.hashRefreshToken.mockReturnValue('some-old-hash');
    await expect(service.refresh('old-token', {})).rejects.toThrow(UnauthorizedException);
    expect(sessions.get(sessionId).revokedAt).toBeInstanceOf(Date);
  });

  it('logout revokes the session so the old token no longer works', async () => {
    await service.login('s', 'e', 'pw', {});
    const sessionId = [...sessions.keys()][0];
    await service.logout(TENANT, USER, sessionId);
    expect(sessions.get(sessionId).revokedAt).toBeInstanceOf(Date);

    // A refresh against the revoked session must now fail.
    tokens.verifyRefreshToken.mockResolvedValue({ sub: USER, tenantId: TENANT, sessionId });
    await expect(service.refresh('x', {})).rejects.toThrow(UnauthorizedException);
  });

  it('logout-all revokes every active session of the user', async () => {
    await service.login('s', 'e', 'pw', {});
    await service.login('s', 'e', 'pw', {});
    const revoked = await service.logoutAll(TENANT, USER);
    expect(revoked).toBe(2);
    for (const row of sessions.values()) {
      expect(row.revokedAt).toBeInstanceOf(Date);
    }
  });
});
