import type { ConfigService } from '@nestjs/config';
import { AppConfigService } from './app-config.service';
import { envValidationOptions, envValidationSchema } from './env.validation';
import { DEFAULT_FIRST_CONTACT_MESSAGE, MAX_FIRST_CONTACT_MESSAGE_LENGTH } from './first-contact';

const configWith = (value: string | undefined) =>
  new AppConfigService({ get: (key: string) => (key === 'FIRST_CONTACT_MESSAGE' ? value : undefined) } as unknown as ConfigService);

describe('first-contact message configuration', () => {
  it('has a non-empty default that acknowledges, hands over and invites (no mandatory questions)', () => {
    expect(DEFAULT_FIRST_CONTACT_MESSAGE.length).toBeGreaterThan(0);
    expect(DEFAULT_FIRST_CONTACT_MESSAGE.length).toBeLessThanOrEqual(MAX_FIRST_CONTACT_MESSAGE_LENGTH);
    expect(DEFAULT_FIRST_CONTACT_MESSAGE).toMatch(/recebemos sua mensagem/i);
    expect(DEFAULT_FIRST_CONTACT_MESSAGE).toMatch(/equipe/i);
  });

  it('uses the default when FIRST_CONTACT_MESSAGE is unset, empty or only whitespace', () => {
    expect(configWith(undefined).firstContactMessage).toBe(DEFAULT_FIRST_CONTACT_MESSAGE);
    expect(configWith('').firstContactMessage).toBe(DEFAULT_FIRST_CONTACT_MESSAGE);
    expect(configWith('   ').firstContactMessage).toBe(DEFAULT_FIRST_CONTACT_MESSAGE);
  });

  it('uses the configured text (trimmed) when there is one', () => {
    expect(configWith('  Olá! Já vamos te atender.  ').firstContactMessage).toBe('Olá! Já vamos te atender.');
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

    it('is optional', () => {
      expect(validate({}).error).toBeUndefined();
      expect(validate({ FIRST_CONTACT_MESSAGE: '' }).error).toBeUndefined();
    });

    it('accepts a text up to the message limit and rejects a longer one at startup', () => {
      expect(validate({ FIRST_CONTACT_MESSAGE: 'x'.repeat(MAX_FIRST_CONTACT_MESSAGE_LENGTH) }).error).toBeUndefined();
      expect(validate({ FIRST_CONTACT_MESSAGE: 'x'.repeat(MAX_FIRST_CONTACT_MESSAGE_LENGTH + 1) }).error?.message).toContain('FIRST_CONTACT_MESSAGE');
    });
  });
});
