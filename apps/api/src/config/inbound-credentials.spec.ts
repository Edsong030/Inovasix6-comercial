import { randomBytes, randomUUID } from 'node:crypto';
import { envValidationOptions, envValidationSchema } from './env.validation';
import {
  InboundCredentialsConfigError,
  MIN_SECRET_LENGTH,
  parseInboundCredentials,
  sha256,
} from './inbound-credentials';

/** Random, test-only secrets: nothing here is a real credential. */
const fakeSecret = () => randomBytes(32).toString('hex');
const entry = (over: Record<string, unknown> = {}) => ({
  keyId: `key-${randomBytes(4).toString('hex')}`,
  tenantId: randomUUID(),
  channel: 'WHATSAPP',
  secret: fakeSecret(),
  ...over,
});
const raw = (...entries: unknown[]) => JSON.stringify(entries);

function problemsOf(value: string): string {
  try {
    parseInboundCredentials(value);
  } catch (error) {
    expect(error).toBeInstanceOf(InboundCredentialsConfigError);
    return (error as Error).message;
  }
  throw new Error('expected parseInboundCredentials to throw');
}

describe('parseInboundCredentials', () => {
  it('parses several tenants and channels', () => {
    const a = entry({ channel: 'WHATSAPP' });
    const b = entry({ channel: 'WEBCHAT' });
    const c = entry({ channel: 'INSTAGRAM', tenantId: a.tenantId }); // same tenant, other channel

    const parsed = parseInboundCredentials(raw(a, b, c));

    expect(parsed.map((p) => [p.keyId, p.tenantId, p.channel])).toEqual([
      [a.keyId, a.tenantId, 'WHATSAPP'],
      [b.keyId, b.tenantId, 'WEBCHAT'],
      [c.keyId, c.tenantId, 'INSTAGRAM'],
    ]);
  });

  it('keeps only a digest of the secret, never the plaintext', () => {
    const e = entry();

    const [parsed] = parseInboundCredentials(raw(e));

    expect(parsed.secretDigest.equals(sha256(e.secret))).toBe(true);
    expect(JSON.stringify(parsed)).not.toContain(e.secret);
    expect(Object.values(parsed)).not.toContain(e.secret);
  });

  it.each([undefined, null, '', '   ', '[]'])('treats %p as "no credentials"', (value) => {
    expect(parseInboundCredentials(value as any)).toEqual([]);
  });

  it('allows several keys for one tenant+channel (rotation)', () => {
    const tenantId = randomUUID();

    expect(parseInboundCredentials(raw(entry({ tenantId }), entry({ tenantId })))).toHaveLength(2);
  });

  it('20. rejects an invalid or non-external channel', () => {
    expect(problemsOf(raw(entry({ channel: 'TELEGRAM' })))).toMatch(/credential #1: channel must be one of/);
    expect(problemsOf(raw(entry({ channel: 'MANUAL' })))).toMatch(/channel must be one of/);
    expect(problemsOf(raw(entry({ channel: 'whatsapp' })))).toMatch(/channel must be one of/);
    expect(problemsOf(raw(entry({ channel: undefined })))).toMatch(/channel must be one of/);
  });

  it('19. rejects a duplicated keyId', () => {
    const a = entry();

    expect(problemsOf(raw(a, entry({ keyId: a.keyId })))).toMatch(/credential #2: keyId is duplicated/);
  });

  it('rejects a secret shorter than the minimum', () => {
    expect(problemsOf(raw(entry({ secret: 'a'.repeat(MIN_SECRET_LENGTH - 1) })))).toMatch(/at least 32 characters/);
    expect(parseInboundCredentials(raw(entry({ secret: 'k'.repeat(MIN_SECRET_LENGTH) })))).toHaveLength(1);
  });

  it('rejects secrets with spaces/non-ASCII, absurdly long ones, and obvious placeholders', () => {
    expect(problemsOf(raw(entry({ secret: `${fakeSecret()} with space` })))).toMatch(/visible ASCII/);
    expect(problemsOf(raw(entry({ secret: `${fakeSecret()}ação` })))).toMatch(/visible ASCII/);
    expect(problemsOf(raw(entry({ secret: 'x'.repeat(257) })))).toMatch(/at most 256/);
    expect(problemsOf(raw(entry({ secret: `replace_with_a_long_random_${fakeSecret()}` })))).toMatch(/placeholder/);
  });

  it('rejects a secret reused by two credentials', () => {
    const secret = fakeSecret();

    expect(problemsOf(raw(entry({ secret }), entry({ secret })))).toMatch(/credential #2: secret is reused/);
  });

  it('validates keyId and tenantId shape (keyId cannot contain ":" - it separates keyId:secret in HTTP Basic)', () => {
    expect(problemsOf(raw(entry({ keyId: 'has:colon' })))).toMatch(/keyId must be/);
    expect(problemsOf(raw(entry({ keyId: 'ab' })))).toMatch(/keyId must be/);
    expect(problemsOf(raw(entry({ keyId: 'has space' })))).toMatch(/keyId must be/);
    expect(problemsOf(raw(entry({ tenantId: 'tenant-a' })))).toMatch(/tenantId must be a UUID/);
  });

  it('rejects unknown fields (typos like "secrett"), non-objects and non-arrays', () => {
    expect(problemsOf(raw({ ...entry(), secrett: 'x' }))).toMatch(/unknown field/);
    expect(problemsOf(raw('nope'))).toMatch(/must be an object/);
    expect(problemsOf('{}')).toMatch(/must be a JSON array/);
  });

  it('reports every problem, by entry number', () => {
    const message = problemsOf(raw(entry({ channel: 'X' }), entry(), entry({ tenantId: 'bad' })));

    expect(message).toMatch(/credential #1: channel/);
    expect(message).toMatch(/credential #3: tenantId/);
    expect(message).not.toMatch(/credential #2/);
  });

  it('18. never puts a secret (or any value) in an error message', () => {
    const leaky = fakeSecret();
    const cases = [
      `not json ${leaky}`, // JSON.parse would quote part of this in ITS message
      `[{"keyId":"k1","secret":"${leaky}" oops}]`,
      raw(entry({ secret: leaky, channel: 'X' })),
      raw({ ...entry({ secret: leaky }), extra: leaky }),
      raw(entry({ secret: leaky.slice(0, 10) })),
      raw(entry({ secret: leaky, keyId: 'bad:key' })),
    ];

    for (const value of cases) {
      const message = problemsOf(value);
      expect(message).not.toContain(leaky);
      expect(message).not.toContain(leaky.slice(0, 10));
    }
  });
});

describe('env validation of INBOUND_SERVICE_CREDENTIALS', () => {
  const baseEnv = (): Record<string, string> => ({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/db?schema=public',
    REDIS_URL: 'redis://localhost:6379',
    WEB_ORIGIN: 'http://localhost:3000',
    JWT_ACCESS_SECRET: 'a_sufficiently_long_access_secret',
    JWT_REFRESH_SECRET: 'a_sufficiently_long_refresh_secret',
  });
  const validate = (env: Record<string, string>) => envValidationSchema.validate(env, envValidationOptions);

  it('is optional and defaults to no credentials', () => {
    const { error, value } = validate(baseEnv());

    expect(error).toBeUndefined();
    expect(value.INBOUND_SERVICE_CREDENTIALS).toBe('[]');
  });

  it('accepts an empty value and a valid list', () => {
    expect(validate({ ...baseEnv(), INBOUND_SERVICE_CREDENTIALS: '' }).error).toBeUndefined();
    expect(validate({ ...baseEnv(), INBOUND_SERVICE_CREDENTIALS: raw(entry()) }).error).toBeUndefined();
  });

  it('18. rejects an invalid configuration at startup, without echoing any secret', () => {
    const secret = fakeSecret();
    const weakSecret = secret.slice(0, 12);

    const badChannel = validate({ ...baseEnv(), INBOUND_SERVICE_CREDENTIALS: raw(entry({ secret, channel: 'X' })) });
    const weak = validate({ ...baseEnv(), INBOUND_SERVICE_CREDENTIALS: raw(entry({ secret: weakSecret })) });
    const notJson = validate({ ...baseEnv(), INBOUND_SERVICE_CREDENTIALS: `oops ${secret}` });

    for (const { error } of [badChannel, weak, notJson]) {
      expect(error).toBeDefined();
      expect(error!.message).toContain('INBOUND_SERVICE_CREDENTIALS is invalid');
      expect(error!.message).not.toContain(secret);
      expect(error!.message).not.toContain(weakSecret);
    }
    expect(badChannel.error!.message).toMatch(/channel must be one of/);
    expect(weak.error!.message).toMatch(/at least 32 characters/);
  });

  it('19. rejects a duplicated keyId at startup', () => {
    const a = entry();
    const { error } = validate({ ...baseEnv(), INBOUND_SERVICE_CREDENTIALS: raw(a, entry({ keyId: a.keyId })) });

    expect(error!.message).toMatch(/keyId is duplicated/);
  });
});
