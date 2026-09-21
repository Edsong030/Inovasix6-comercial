import type { ConfigService } from '@nestjs/config';
import { AppConfigService } from './app-config.service';
import { envValidationOptions, envValidationSchema } from './env.validation';
import { DEFAULT_OUTBOUND_DELIVERY_SETTINGS } from './outbound-delivery';

const configWith = (values: Record<string, unknown>) =>
  new AppConfigService({ get: (key: string) => values[key] } as unknown as ConfigService);

describe('outbound delivery configuration', () => {
  it('defaults to a worker that is OFF, with conservative operational settings', () => {
    expect(DEFAULT_OUTBOUND_DELIVERY_SETTINGS).toEqual({ workerEnabled: false, pollIntervalMs: 2000, batchSize: 10, leaseMs: 60_000, sendTimeoutMs: 15_000 });
    expect(configWith({}).outboundDelivery).toEqual(DEFAULT_OUTBOUND_DELIVERY_SETTINGS);
  });

  it('reads the configured values (Joi-converted or raw strings)', () => {
    expect(
      configWith({
        OUTBOUND_WORKER_ENABLED: true,
        OUTBOUND_POLL_INTERVAL_MS: '500',
        OUTBOUND_BATCH_SIZE: 5,
        OUTBOUND_LEASE_MS: 30_000,
        OUTBOUND_SEND_TIMEOUT_MS: '10000',
      }).outboundDelivery,
    ).toEqual({ workerEnabled: true, pollIntervalMs: 500, batchSize: 5, leaseMs: 30_000, sendTimeoutMs: 10_000 });
    expect(configWith({ OUTBOUND_WORKER_ENABLED: 'true' }).outboundDelivery.workerEnabled).toBe(true);
  });

  it('only an explicit true enables the worker', () => {
    for (const value of [undefined, false, 'false', '', 'yes', 1]) {
      expect(configWith({ OUTBOUND_WORKER_ENABLED: value }).outboundDelivery.workerEnabled).toBe(false);
    }
  });

  it('falls back to the default for garbage numbers instead of producing NaN/0 timers', () => {
    const settings = configWith({ OUTBOUND_POLL_INTERVAL_MS: 'abc', OUTBOUND_BATCH_SIZE: 0, OUTBOUND_LEASE_MS: -1 }).outboundDelivery;

    expect(settings.pollIntervalMs).toBe(2000);
    expect(settings.batchSize).toBe(10);
    expect(settings.leaseMs).toBe(60_000);
  });

  describe('env validation', () => {
    const baseEnv = (): Record<string, string> => ({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/db?schema=public',
      REDIS_URL: 'redis://localhost:6379',
      WEB_ORIGIN: 'http://localhost:3000',
      JWT_ACCESS_SECRET: 'a_sufficiently_long_access_secret',
      JWT_REFRESH_SECRET: 'a_sufficiently_long_refresh_secret',
    });
    const validate = (extra: Record<string, string>) => envValidationSchema.validate({ ...baseEnv(), ...extra }, envValidationOptions);

    it('is all optional, and the worker defaults to false', () => {
      const { error, value } = validate({});

      expect(error).toBeUndefined();
      expect(value.OUTBOUND_WORKER_ENABLED).toBe(false);
      expect(value.OUTBOUND_POLL_INTERVAL_MS).toBe(2000);
      expect(value.OUTBOUND_SEND_TIMEOUT_MS).toBeLessThan(value.OUTBOUND_LEASE_MS);
    });

    it('accepts a valid configuration', () => {
      expect(validate({ OUTBOUND_WORKER_ENABLED: 'true', OUTBOUND_POLL_INTERVAL_MS: '1000', OUTBOUND_BATCH_SIZE: '20', OUTBOUND_LEASE_MS: '120000', OUTBOUND_SEND_TIMEOUT_MS: '30000' }).error).toBeUndefined();
    });

    it.each([
      ['OUTBOUND_WORKER_ENABLED', 'maybe'],
      ['OUTBOUND_POLL_INTERVAL_MS', '10'],
      ['OUTBOUND_POLL_INTERVAL_MS', 'fast'],
      ['OUTBOUND_BATCH_SIZE', '0'],
      ['OUTBOUND_BATCH_SIZE', '500'],
      ['OUTBOUND_LEASE_MS', '100'],
      ['OUTBOUND_SEND_TIMEOUT_MS', '10'],
    ])('rejects %s=%s at startup', (key, value) => {
      expect(validate({ [key]: value }).error?.message).toContain(key);
    });

    it('rejects a send timeout that is not below the lease (a send could outlive its own lease)', () => {
      const error = validate({ OUTBOUND_LEASE_MS: '20000', OUTBOUND_SEND_TIMEOUT_MS: '20000' }).error;
      expect(error?.message).toContain('OUTBOUND_SEND_TIMEOUT_MS must be lower than OUTBOUND_LEASE_MS');
      expect(validate({ OUTBOUND_LEASE_MS: '20000', OUTBOUND_SEND_TIMEOUT_MS: '19999' }).error).toBeUndefined();
    });

    it('a default lease with a long timeout is also rejected', () => {
      expect(validate({ OUTBOUND_SEND_TIMEOUT_MS: '90000' }).error?.message).toContain('must be lower than OUTBOUND_LEASE_MS');
    });
  });
});
