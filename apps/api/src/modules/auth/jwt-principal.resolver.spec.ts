import type { Request } from 'express';
import { JwtPrincipalResolver } from './jwt-principal.resolver';
import { TokenService } from './token.service';

describe('JwtPrincipalResolver', () => {
  function makeResolver(verify: jest.Mock) {
    const tokens = { verifyAccessToken: verify } as unknown as TokenService;
    return new JwtPrincipalResolver(tokens);
  }

  it('derives TenantContext from verified access-token claims', async () => {
    const verify = jest.fn().mockResolvedValue({
      sub: 'user-1',
      tenantId: 'tenant-1',
      roleCodes: ['ADMIN'],
      sessionId: 'sess-1',
    });
    const resolver = makeResolver(verify);
    const req = { headers: { authorization: 'Bearer good.token' } } as unknown as Request;

    const ctx = await resolver.resolve(req);
    expect(ctx).toEqual({ tenantId: 'tenant-1', userId: 'user-1', roleCodes: ['ADMIN'] });
  });

  it('returns null when the Authorization header is missing', async () => {
    const resolver = makeResolver(jest.fn());
    const req = { headers: {} } as unknown as Request;
    expect(await resolver.resolve(req)).toBeNull();
  });

  it('returns null when the token is invalid (never trusts body/query/header)', async () => {
    const verify = jest.fn().mockRejectedValue(new Error('bad signature'));
    const resolver = makeResolver(verify);
    const req = {
      headers: { authorization: 'Bearer tampered' },
      body: { tenantId: 'attacker-tenant' },
      query: { tenantId: 'attacker-tenant' },
    } as unknown as Request;
    expect(await resolver.resolve(req)).toBeNull();
  });
});
