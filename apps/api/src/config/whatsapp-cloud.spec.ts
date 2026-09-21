import type { ConfigService } from '@nestjs/config';
import { inspect } from 'node:util';
import { randomBytes, randomUUID } from 'node:crypto';
import { AppConfigService } from './app-config.service';
import { envValidationOptions, envValidationSchema } from './env.validation';
import {
  DEFAULT_GRAPH_API_BASE_URL,
  DEFAULT_GRAPH_API_VERSION,
  DEFAULT_WHATSAPP_HTTP_TIMEOUT_MS,
  WhatsAppCloudAccount,
  WhatsAppCloudConfigError,
  baseUrlProblem,
  parseWhatsAppCloudAccounts,
} from './whatsapp-cloud';

const secret = () => randomBytes(24).toString('hex');
const token = () => `EAAG${randomBytes(40).toString('hex')}`;
const account = (over: Record<string, unknown> = {}) => ({ tenantId: randomUUID(), phoneNumberId: '109876543210987', accessToken: token(), ...over });
const json = (entries: unknown[]) => JSON.stringify(entries);

describe('WhatsApp Cloud API configuration', () => {
  describe('WHATSAPP_CLOUD_ACCOUNTS', () => {
    it('is empty when unset or blank', () => {
      expect(parseWhatsAppCloudAccounts(undefined)).toEqual([]);
      expect(parseWhatsAppCloudAccounts('')).toEqual([]);
      expect(parseWhatsAppCloudAccounts('  [] ')).toEqual([]);
    });

    it('maps each phone_number_id to its tenant, one account per tenant', () => {
      const a = account({ tenantId: randomUUID(), phoneNumberId: '100000000000001' });
      const b = account({ tenantId: randomUUID(), phoneNumberId: '100000000000002' });

      const parsed = parseWhatsAppCloudAccounts(json([a, b]));

      expect(parsed.map((p) => [p.tenantId, p.phoneNumberId])).toEqual([
        [a.tenantId, a.phoneNumberId],
        [b.tenantId, b.phoneNumberId],
      ]);
      expect(parsed[0].accessToken).toBe(a.accessToken);
    });

    it('lower-cases the tenant id so lookups are not case-sensitive by accident', () => {
      const id = randomUUID();
      expect(parseWhatsAppCloudAccounts(json([account({ tenantId: id.toUpperCase() })]))[0].tenantId).toBe(id);
    });

    it('allows the same token for several tenants (a business token can span several WABAs)', () => {
      const shared = token();
      expect(() => parseWhatsAppCloudAccounts(json([account({ accessToken: shared }), account({ accessToken: shared, phoneNumberId: '100000000000002' })]))).not.toThrow();
    });

    it.each([
      ['not JSON', '{oops', /not valid JSON/],
      ['not an array', '{"a":1}', /must be a JSON array/],
      ['an entry that is not an object', '[1]', /must be an object/],
      ['a bad tenant id', json([account({ tenantId: 'not-a-uuid' })]), /tenantId must be a UUID/],
      ['a non numeric phone_number_id', json([account({ phoneNumberId: 'abc' })]), /phoneNumberId must be the numeric/],
      ['a short token', json([account({ accessToken: 'short' })]), /at least 20/],
      ['a token with spaces', json([account({ accessToken: `${token()} x` })]), /visible ASCII/],
      ['a placeholder token', json([account({ accessToken: 'replace_with_your_real_token_here' })]), /placeholder/],
      ['an unknown field (e.g. an attempt to pass a tenant override)', json([{ ...account(), channel: 'WHATSAPP' }]), /unknown field/],
      ['a missing token', json([{ tenantId: randomUUID(), phoneNumberId: '109876543210987' }]), /accessToken must be a string/],
    ])('rejects %s', (_name, raw, message) => {
      expect(() => parseWhatsAppCloudAccounts(raw)).toThrow(WhatsAppCloudConfigError);
      expect(() => parseWhatsAppCloudAccounts(raw)).toThrow(message);
    });

    it('rejects two accounts for the same tenant, and one phone_number_id claimed by two tenants', () => {
      const tenantId = randomUUID();
      expect(() => parseWhatsAppCloudAccounts(json([account({ tenantId }), account({ tenantId, phoneNumberId: '100000000000002' })]))).toThrow(/tenantId is duplicated/);
      expect(() => parseWhatsAppCloudAccounts(json([account(), account()]))).toThrow(/phoneNumberId is duplicated/);
    });

    it('never puts a token, tenant or phone number in an error message', () => {
      const t = token();
      const tenantId = randomUUID();
      for (const raw of [json([{ tenantId, phoneNumberId: 'x', accessToken: t }]), `[{"accessToken":"${t}"`, json([{ tenantId, phoneNumberId: '109876543210987', accessToken: t, extra: 1 }])]) {
        try {
          parseWhatsAppCloudAccounts(raw);
          throw new Error('should have thrown');
        } catch (error) {
          const text = `${(error as Error).message} ${JSON.stringify((error as WhatsAppCloudConfigError).problems)}`;
          expect(text).not.toContain(t);
          expect(text).not.toContain(tenantId);
        }
      }
    });
  });

  describe('WhatsAppCloudAccount keeps its token out of every implicit serialization', () => {
    const t = token();
    const acc = new WhatsAppCloudAccount(randomUUID(), '109876543210987', t);

    it('JSON, util.inspect, string conversion and template literals show a redaction', () => {
      for (const rendered of [JSON.stringify(acc), JSON.stringify({ nested: [acc] }), inspect(acc, { depth: 5 }), String(acc), `${acc}`, inspect({ acc })]) {
        expect(rendered).not.toContain(t);
      }
      expect(JSON.stringify(acc)).toContain('[REDACTED]');
    });

    it('an object that ends up in a log line or a Jest diff cannot leak it either', () => {
      expect(JSON.stringify(Object.entries(acc))).not.toContain(t);
      expect(Object.keys(acc)).not.toContain('accessToken');
      expect({ ...acc }).not.toHaveProperty('accessToken', t);
    });

    it('the token is still available to the one caller that builds the Authorization header', () => {
      expect(acc.accessToken).toBe(t);
    });
  });

  describe('base URL', () => {
    it.each([
      ['https://graph.facebook.com', false, null],
      ['http://127.0.0.1:4010', false, null],
      ['http://127.0.0.1:4010', true, 'must use https'],
      ['ftp://x.com', false, 'must use http(s)'],
      ['https://user:pw@graph.facebook.com', false, 'origin only'],
      ['https://graph.facebook.com/v1', false, 'origin only'],
      ['https://graph.facebook.com/?a=1', false, 'origin only'],
      ['not a url', false, 'valid URL'],
    ])('%s (production=%s)', (url, production, problem) => {
      const result = baseUrlProblem(url, production);
      if (problem === null) expect(result).toBeNull();
      else expect(result).toContain(problem);
    });
  });

  describe('AppConfigService.whatsappCloud', () => {
    const configWith = (values: Record<string, unknown>) => new AppConfigService({ get: (key: string) => values[key] } as unknown as ConfigService);

    it('is OFF by default, with documented defaults (Graph API v25.0, https://graph.facebook.com, 10 s)', () => {
      const settings = configWith({}).whatsappCloud;

      expect(settings.enabled).toBe(false);
      expect(settings).toMatchObject({ graphApiVersion: DEFAULT_GRAPH_API_VERSION, graphApiBaseUrl: DEFAULT_GRAPH_API_BASE_URL, httpTimeoutMs: DEFAULT_WHATSAPP_HTTP_TIMEOUT_MS, accounts: [] });
      expect(DEFAULT_GRAPH_API_VERSION).toBe('v25.0');
    });

    it('only an explicit true enables it', () => {
      for (const value of [undefined, false, 'false', '', 'yes', 1, 'TRUE']) expect(configWith({ WHATSAPP_CLOUD_ENABLED: value }).whatsappCloud.enabled).toBe(false);
      expect(configWith({ WHATSAPP_CLOUD_ENABLED: true }).whatsappCloud.enabled).toBe(true);
      expect(configWith({ WHATSAPP_CLOUD_ENABLED: 'true' }).whatsappCloud.enabled).toBe(true);
    });

    it('exposes the configured accounts, and the token stays redacted inside the settings object', () => {
      const a = account();
      const settings = configWith({ WHATSAPP_CLOUD_ENABLED: true, WHATSAPP_CLOUD_ACCOUNTS: json([a]), WHATSAPP_GRAPH_API_VERSION: 'v26.0', WHATSAPP_HTTP_TIMEOUT_MS: '7000' }).whatsappCloud;

      expect(settings.accounts).toHaveLength(1);
      expect(settings.graphApiVersion).toBe('v26.0');
      expect(settings.httpTimeoutMs).toBe(7000);
      expect(JSON.stringify(settings.accounts)).not.toContain(a.accessToken);
    });
  });

  describe('env validation', () => {
    const base = (): Record<string, string> => ({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/db?schema=public',
      REDIS_URL: 'redis://localhost:6379',
      WEB_ORIGIN: 'http://localhost:3000',
      JWT_ACCESS_SECRET: 'a_sufficiently_long_access_secret',
      JWT_REFRESH_SECRET: 'a_sufficiently_long_refresh_secret',
    });
    const enabledEnv = (over: Record<string, string> = {}) => ({
      WHATSAPP_CLOUD_ENABLED: 'true',
      WHATSAPP_META_APP_SECRET: secret(),
      WHATSAPP_WEBHOOK_VERIFY_TOKEN: secret(),
      WHATSAPP_CLOUD_ACCOUNTS: json([account()]),
      ...over,
    });
    const validate = (extra: Record<string, string>) => envValidationSchema.validate({ ...base(), ...extra }, envValidationOptions);

    it('needs nothing while the integration is off, and defaults to off', () => {
      const { error, value } = validate({});

      expect(error).toBeUndefined();
      expect(value.WHATSAPP_CLOUD_ENABLED).toBe(false);
      expect(value.WHATSAPP_GRAPH_API_VERSION).toBe('v25.0');
      expect(value.WHATSAPP_GRAPH_API_BASE_URL).toBe('https://graph.facebook.com');
      expect(value.WHATSAPP_CLOUD_ACCOUNTS).toBe('[]');
    });

    it('does not demand secrets when explicitly off, even if some variables are present', () => {
      expect(validate({ WHATSAPP_CLOUD_ENABLED: 'false', WHATSAPP_CLOUD_ACCOUNTS: json([account()]) }).error).toBeUndefined();
    });

    it('accepts a complete enabled configuration', () => {
      expect(validate(enabledEnv()).error).toBeUndefined();
    });

    it.each([
      ['no app secret', { WHATSAPP_META_APP_SECRET: '' }, 'WHATSAPP_META_APP_SECRET is required'],
      ['a short app secret', { WHATSAPP_META_APP_SECRET: 'short' }, 'WHATSAPP_META_APP_SECRET must have at least'],
      ['a placeholder app secret', { WHATSAPP_META_APP_SECRET: 'replace_with_the_app_secret' }, 'looks like a placeholder'],
      ['no verify token', { WHATSAPP_WEBHOOK_VERIFY_TOKEN: '' }, 'WHATSAPP_WEBHOOK_VERIFY_TOKEN is required'],
      ['a verify token with spaces', { WHATSAPP_WEBHOOK_VERIFY_TOKEN: 'has some spaces in the token' }, 'visible ASCII'],
      ['no accounts', { WHATSAPP_CLOUD_ACCOUNTS: '[]' }, 'must list at least one account'],
      ['a send timeout not below the delivery timeout', { WHATSAPP_HTTP_TIMEOUT_MS: '20000' }, 'WHATSAPP_HTTP_TIMEOUT_MS must be lower than OUTBOUND_SEND_TIMEOUT_MS'],
    ])('enabled with %s fails the boot', (_name, over, message) => {
      expect(validate(enabledEnv(over)).error?.message).toContain(message);
    });

    it('a malformed account list fails the boot with the parser message, and never echoes a value', () => {
      const t = token();
      const { error } = validate({ WHATSAPP_CLOUD_ACCOUNTS: json([{ tenantId: 'x', phoneNumberId: '1', accessToken: t }]) });

      expect(error?.message).toContain('WHATSAPP_CLOUD_ACCOUNTS is invalid');
      expect(error?.message).not.toContain(t);
    });

    it('a malformed account list while enabled reports the field, not a crash', () => {
      expect(validate(enabledEnv({ WHATSAPP_CLOUD_ACCOUNTS: '{oops' })).error?.message).toContain('not valid JSON');
    });

    it.each([
      ['WHATSAPP_GRAPH_API_VERSION', 'latest'],
      ['WHATSAPP_GRAPH_API_VERSION', '25'],
      ['WHATSAPP_GRAPH_API_BASE_URL', 'graph.facebook.com'],
      ['WHATSAPP_GRAPH_API_BASE_URL', 'https://graph.facebook.com/v25.0'],
      ['WHATSAPP_HTTP_TIMEOUT_MS', '10'],
      ['WHATSAPP_HTTP_TIMEOUT_MS', 'fast'],
      ['WHATSAPP_CLOUD_ENABLED', 'maybe'],
    ])('rejects %s=%s', (key, value) => {
      expect(validate({ [key]: value }).error?.message).toContain(key);
    });

    it('never echoes the secrets of an invalid configuration in the error', () => {
      const appSecret = 'short';
      const tokenValue = 'has some spaces in the token';
      const { error } = validate(enabledEnv({ WHATSAPP_META_APP_SECRET: appSecret, WHATSAPP_WEBHOOK_VERIFY_TOKEN: tokenValue }));

      expect(error?.message).toBeDefined();
      expect(error?.message).not.toContain(tokenValue);
    });
  });
});
