import { ExecutionContext, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { createHmac, randomBytes } from 'node:crypto';
import type { AppConfigService } from '../../../config/app-config.service';
import { MetaSignatureGuard, WhatsAppEnabledGuard } from './whatsapp-webhook.guards';

const APP_SECRET = randomBytes(16).toString('hex');
const sign = (body: Buffer, secret = APP_SECRET) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
const configWith = (whatsappCloud: Record<string, unknown>) => ({ whatsappCloud }) as unknown as AppConfigService;
const contextOf = (request: unknown) => ({ switchToHttp: () => ({ getRequest: () => request }) }) as unknown as ExecutionContext;

describe('WhatsAppEnabledGuard', () => {
  it('lets requests through only while the integration is enabled', () => {
    expect(new WhatsAppEnabledGuard(configWith({ enabled: true })).canActivate()).toBe(true);
  });

  it('answers 404, like a route that does not exist, while it is disabled', () => {
    expect(() => new WhatsAppEnabledGuard(configWith({ enabled: false })).canActivate()).toThrow(NotFoundException);
  });
});

describe('MetaSignatureGuard', () => {
  const logs: unknown[] = [];
  const guard = () => new MetaSignatureGuard(configWith({ enabled: true, appSecret: APP_SECRET }));
  const body = Buffer.from('{"object":"whatsapp_business_account","entry":[]}');
  const request = (overrides: { body?: unknown; signature?: string | string[] } = {}) => ({
    body: 'body' in overrides ? overrides.body : body,
    headers: { 'x-hub-signature-256': 'signature' in overrides ? overrides.signature : sign(body) },
  });

  beforeEach(() => {
    logs.length = 0;
    for (const level of ['log', 'warn', 'error', 'debug'] as const) jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => void logs.push(args[0]));
  });
  afterEach(() => jest.restoreAllMocks());

  it('accepts a correctly signed raw body', () => {
    expect(guard().canActivate(contextOf(request()))).toBe(true);
  });

  it.each([
    ['no signature header', { signature: undefined }, 'missing'],
    ['a wrong signature', { signature: sign(body, 'another-secret-entirely') }, 'mismatch'],
    ['a malformed signature', { signature: 'sha256=abc' }, 'malformed'],
    ['a signature for a different payload', { signature: sign(Buffer.from('{}')) }, 'mismatch'],
    ['a body that was already parsed (not raw bytes): nothing could have been verified', { body: { object: 'whatsapp_business_account' } }, 'missing'],
    ['no body at all', { body: undefined }, 'missing'],
  ])('rejects %s with a generic 401, logging only the reason', (_name, overrides, reason) => {
    expect(() => guard().canActivate(contextOf(request(overrides)))).toThrow(UnauthorizedException);

    expect(logs).toEqual([{ event: 'whatsapp.webhook.rejected', reason }]);
  });

  it('the 401 says nothing about why (no oracle for an attacker)', () => {
    const reasons = [{ signature: undefined }, { signature: 'sha256=abc' }, { signature: sign(body, 'x') }].map((over) => {
      try {
        guard().canActivate(contextOf(request(over)));
      } catch (error) {
        return JSON.stringify((error as UnauthorizedException).getResponse());
      }
      return 'accepted';
    });

    expect(new Set(reasons).size).toBe(1);
  });

  it('never logs the signature, the body or the secret', () => {
    const signature = sign(body, 'attacker-guess');
    expect(() => guard().canActivate(contextOf(request({ signature })))).toThrow();

    const everything = JSON.stringify(logs);
    for (const secret of [signature, APP_SECRET, 'whatsapp_business_account']) expect(everything).not.toContain(secret);
  });

  it('is checked over the bytes as received, so a body altered by one byte fails', () => {
    const altered = Buffer.from(body.toString().replace('entry', 'entrz'));

    expect(() => guard().canActivate(contextOf(request({ body: altered, signature: sign(body) })))).toThrow(UnauthorizedException);
  });
});
