import { ExecutionContext, Logger, UnauthorizedException } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import type { AppConfigService } from '../../../config/app-config.service';
import { CurrentInboundService } from './current-inbound-service.decorator';
import { InboundCredentialsService } from './inbound-credentials.service';
import { INVALID_SERVICE_CREDENTIAL_MESSAGE, InboundServiceGuard, parseBasicCredentials } from './inbound-service.guard';

/** Test-only random secret; nothing here is a real credential. */
const secret = randomBytes(32).toString('hex');
const tenantId = randomUUID();
const KEY_ID = 'test-tenant-a-whatsapp';

const basic = (keyId: string, pass: string) => `Basic ${Buffer.from(`${keyId}:${pass}`).toString('base64')}`;

function contextFor(headers: Record<string, unknown>) {
  const request: Record<string, any> = { headers, ip: '203.0.113.9' };
  const response = { setHeader: jest.fn() };
  const context = {
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
  } as unknown as ExecutionContext;
  return { request, response, context };
}

describe('InboundServiceGuard', () => {
  let guard: InboundServiceGuard;
  let logged: string[];

  beforeEach(() => {
    const config = {
      inboundServiceCredentialsRaw: JSON.stringify([{ keyId: KEY_ID, tenantId, channel: 'WHATSAPP', secret }]),
    } as AppConfigService;
    guard = new InboundServiceGuard(new InboundCredentialsService(config));
    logged = [];
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
        logged.push(JSON.stringify(args));
      });
    }
  });

  afterEach(() => jest.restoreAllMocks());

  const failure = (headers: Record<string, unknown>): UnauthorizedException => {
    const { context } = contextFor(headers);
    try {
      guard.canActivate(context);
    } catch (error) {
      return error as UnauthorizedException;
    }
    throw new Error('expected the guard to reject');
  };

  it('a valid credential sets the tenant and channel of the credential on the request', () => {
    const { context, request } = contextFor({ authorization: basic(KEY_ID, secret) });

    expect(guard.canActivate(context)).toBe(true);
    expect(request.inboundService).toEqual({ tenantId, channel: 'WHATSAPP', keyId: KEY_ID });
  });

  it('accepts the "Basic" scheme in any case', () => {
    const { context } = contextFor({ authorization: basic(KEY_ID, secret).replace('Basic', 'bAsIc') });

    expect(guard.canActivate(context)).toBe(true);
  });

  it('6. a missing credential is 401', () => {
    const error = failure({});

    expect(error).toBeInstanceOf(UnauthorizedException);
    expect(error.getStatus()).toBe(401);
  });

  it('5. an unknown keyId and 4. a wrong secret are 401 with the SAME response', () => {
    const unknownKey = failure({ authorization: basic('nope-nope', secret) });
    const wrongSecret = failure({ authorization: basic(KEY_ID, randomBytes(32).toString('hex')) });

    expect(unknownKey.getStatus()).toBe(401);
    expect(wrongSecret.getStatus()).toBe(401);
    expect(unknownKey.getResponse()).toEqual(wrongSecret.getResponse());
    expect(unknownKey.message).toBe(INVALID_SERVICE_CREDENTIAL_MESSAGE);
  });

  it.each([
    ['Bearer scheme (a user JWT)', 'Bearer eyJhbGciOiJIUzI1NiJ9.e30.abc'],
    ['no scheme', Buffer.from(`${KEY_ID}:x`).toString('base64')],
    ['not base64', 'Basic !!!not-base64!!!'],
    ['no separator', `Basic ${Buffer.from('justonepart').toString('base64')}`],
    ['empty keyId', `Basic ${Buffer.from(':secretonly').toString('base64')}`],
    ['empty secret', `Basic ${Buffer.from(`${KEY_ID}:`).toString('base64')}`],
    ['empty value', 'Basic '],
    ['oversized header', `Basic ${'A'.repeat(5000)}`],
  ])('a malformed credential (%s) is 401', (_name, authorization) => {
    expect(failure({ authorization }).getStatus()).toBe(401);
  });

  it('a repeated/array authorization header is 401', () => {
    expect(failure({ authorization: [basic(KEY_ID, secret), basic(KEY_ID, secret)] }).getStatus()).toBe(401);
  });

  it('the secret may contain ":" (only the first one separates keyId from secret)', () => {
    expect(parseBasicCredentials(basic('k-1234', 'a:b:c'))).toEqual({ keyId: 'k-1234', secret: 'a:b:c' });
  });

  it('challenges with WWW-Authenticate on failure', () => {
    const { context, response } = contextFor({});

    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
    expect(response.setHeader).toHaveBeenCalledWith('WWW-Authenticate', expect.stringMatching(/^Basic realm=/));
  });

  it('17. neither the secret nor the presented keyId ever appear in an exception or a log line', () => {
    const wrong = randomBytes(32).toString('hex');
    const attempts = [
      { authorization: basic(KEY_ID, wrong) },
      { authorization: basic('attacker-key', secret) },
      { authorization: basic(secret, secret) }, // a secret pasted into the keyId slot
      { authorization: 'Bearer something' },
    ];

    for (const headers of attempts) {
      const error = failure(headers);
      const surface = JSON.stringify([error.message, error.getResponse(), error.stack?.split('\n')[0]]);
      for (const sensitive of [secret, wrong, KEY_ID, 'attacker-key']) expect(surface).not.toContain(sensitive);
    }
    // the success path does not log credentials either
    guard.canActivate(contextFor({ authorization: basic(KEY_ID, secret) }).context);

    expect(logged.length).toBeGreaterThan(0); // failures ARE logged...
    for (const line of logged) {
      for (const sensitive of [secret, wrong, KEY_ID, 'attacker-key', 'Basic ']) expect(line).not.toContain(sensitive);
    }
  });
});

describe('CurrentInboundService', () => {
  // Extract the factory the decorator registers, as Nest would call it.
  const factory = (() => {
    class Probe {
      handler(@CurrentInboundService() _service: unknown): void {
        void _service;
      }
    }
    const metadata = Reflect.getMetadata('__routeArguments__', Probe, 'handler') as Record<string, { factory: (data: unknown, ctx: unknown) => unknown }>;
    return Object.values(metadata)[0].factory;
  })();

  it('returns the caller set by the guard', () => {
    const inboundService = { tenantId, channel: 'WHATSAPP', keyId: KEY_ID };
    const ctx = { switchToHttp: () => ({ getRequest: () => ({ inboundService }) }) };

    expect(factory(undefined, ctx)).toBe(inboundService);
  });

  it('refuses (401) when the guard did not run, instead of falling back to anything', () => {
    const ctx = { switchToHttp: () => ({ getRequest: () => ({ body: { tenantId: 'x' }, headers: { 'x-tenant-id': 'x' } }) }) };

    expect(() => factory(undefined, ctx)).toThrow(UnauthorizedException);
  });
});
