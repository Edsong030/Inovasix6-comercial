import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard, type RequestWithSession } from './jwt-auth.guard';
import { TokenService } from './token.service';

function ctxFor(request: Partial<Request & RequestWithSession>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('JwtAuthGuard', () => {
  it('throws 401 when the Authorization header is missing', async () => {
    const verify = jest.fn();
    const guard = new JwtAuthGuard({ verifyAccessToken: verify } as unknown as TokenService);

    await expect(guard.canActivate(ctxFor({ headers: {} }))).rejects.toThrow(
      UnauthorizedException,
    );
    expect(verify).not.toHaveBeenCalled();
  });

  it('throws 401 when the header is not a Bearer token', async () => {
    const guard = new JwtAuthGuard({ verifyAccessToken: jest.fn() } as unknown as TokenService);

    await expect(
      guard.canActivate(ctxFor({ headers: { authorization: 'Basic dXNlcjpwYXNz' } })),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('throws 401 when the token fails signature/expiry verification', async () => {
    const verify = jest.fn().mockRejectedValue(new Error('invalid signature'));
    const guard = new JwtAuthGuard({ verifyAccessToken: verify } as unknown as TokenService);

    await expect(
      guard.canActivate(ctxFor({ headers: { authorization: 'Bearer tampered' } })),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('populates tenantContext/sessionId from verified claims and allows the request through', async () => {
    const claims = {
      sub: 'user-1',
      tenantId: 'tenant-1',
      roleCodes: ['ADMIN'],
      sessionId: 'sess-1',
    };
    const verify = jest.fn().mockResolvedValue(claims);
    const guard = new JwtAuthGuard({ verifyAccessToken: verify } as unknown as TokenService);
    const request: Partial<Request & RequestWithSession> = {
      headers: { authorization: 'Bearer good.token' },
    };

    await expect(guard.canActivate(ctxFor(request))).resolves.toBe(true);
    expect(request.tenantContext).toEqual({
      tenantId: 'tenant-1',
      userId: 'user-1',
      roleCodes: ['ADMIN'],
    });
    expect(request.sessionId).toBe('sess-1');
  });
});
