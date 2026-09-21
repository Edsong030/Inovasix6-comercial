import { randomBytes, randomUUID } from 'node:crypto';
import type { AppConfigService } from '../../../config/app-config.service';
import { InboundCredentialsConfigError } from '../../../config/inbound-credentials';
import { InboundCredentialsService } from './inbound-credentials.service';

/** Test-only random secrets; nothing here is a real credential. */
const fakeSecret = () => randomBytes(32).toString('hex');

function build(entries: unknown[]): InboundCredentialsService {
  const config = { inboundServiceCredentialsRaw: JSON.stringify(entries) } as AppConfigService;
  return new InboundCredentialsService(config);
}

describe('InboundCredentialsService', () => {
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const secretA = fakeSecret();
  const secretB = fakeSecret();
  const credA = { keyId: 'test-tenant-a-whatsapp', tenantId: tenantA, channel: 'WHATSAPP', secret: secretA };
  const credB = { keyId: 'test-tenant-b-instagram', tenantId: tenantB, channel: 'INSTAGRAM', secret: secretB };
  let service: InboundCredentialsService;

  beforeEach(() => {
    service = build([credA, credB]);
  });

  it('3. the right secret authenticates', () => {
    expect(service.authenticate(credA.keyId, secretA)).not.toBeNull();
    expect(service.authenticate(credB.keyId, secretB)).not.toBeNull();
  });

  it('1. resolves the tenant of the credential', () => {
    expect(service.authenticate(credA.keyId, secretA)?.tenantId).toBe(tenantA);
    expect(service.authenticate(credB.keyId, secretB)?.tenantId).toBe(tenantB);
  });

  it('2. resolves the channel of the credential', () => {
    expect(service.authenticate(credA.keyId, secretA)?.channel).toBe('WHATSAPP');
    expect(service.authenticate(credB.keyId, secretB)?.channel).toBe('INSTAGRAM');
  });

  it('returns only tenantId, channel and keyId (no secret material)', () => {
    const caller = service.authenticate(credA.keyId, secretA);

    expect(caller).toEqual({ tenantId: tenantA, channel: 'WHATSAPP', keyId: credA.keyId });
    expect(JSON.stringify(caller)).not.toContain(secretA);
  });

  it('4. a wrong secret is rejected', () => {
    expect(service.authenticate(credA.keyId, fakeSecret())).toBeNull();
    // the secret of ANOTHER credential does not work for this keyId
    expect(service.authenticate(credA.keyId, secretB)).toBeNull();
  });

  it('5. an unknown keyId is rejected', () => {
    expect(service.authenticate('no-such-key', secretA)).toBeNull();
    expect(service.authenticate('__proto__', secretA)).toBeNull();
    expect(service.authenticate('constructor', secretA)).toBeNull();
    expect(service.authenticate('', secretA)).toBeNull();
  });

  it('7. secrets of any length are handled without throwing (no timingSafeEqual RangeError)', () => {
    for (const length of [0, 1, 31, 32, 33, 64, 65, 1000, 100_000]) {
      expect(() => service.authenticate(credA.keyId, 'x'.repeat(length))).not.toThrow();
      expect(service.authenticate(credA.keyId, 'x'.repeat(length))).toBeNull();
    }
    // a prefix or extension of the real secret is not the secret
    expect(service.authenticate(credA.keyId, secretA.slice(0, -1))).toBeNull();
    expect(service.authenticate(credA.keyId, `${secretA}x`)).toBeNull();
  });

  it('is case-sensitive on both keyId and secret', () => {
    expect(service.authenticate(credA.keyId.toUpperCase(), secretA)).toBeNull();
    expect(service.authenticate(credA.keyId, secretA.toUpperCase())).toBeNull();
  });

  it('with no credentials configured, nothing authenticates', () => {
    const empty = build([]);

    expect(empty.size).toBe(0);
    expect(empty.authenticate(credA.keyId, secretA)).toBeNull();
  });

  it('18. an invalid configuration fails at construction (startup), not at first request', () => {
    expect(() => build([{ ...credA, channel: 'X' }])).toThrow(InboundCredentialsConfigError);
    expect(() => build([{ ...credA, secret: 'short' }])).toThrow(InboundCredentialsConfigError);
  });

  it('19/20. duplicate keyId and invalid channel are rejected at construction, without leaking the secret', () => {
    for (const bad of [[credA, { ...credB, keyId: credA.keyId }], [{ ...credA, channel: 'MANUAL' }]]) {
      try {
        build(bad);
        throw new Error('expected a config error');
      } catch (error) {
        expect(error).toBeInstanceOf(InboundCredentialsConfigError);
        expect((error as Error).message).not.toContain(secretA);
        expect((error as Error).message).not.toContain(secretB);
      }
    }
  });
});
