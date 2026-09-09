import { envValidationOptions, envValidationSchema } from './env.validation';

/** A complete, valid set of variables used as a baseline for each test. */
function baseEnv(): Record<string, string> {
  return {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/db?schema=public',
    REDIS_URL: 'redis://localhost:6379',
    WEB_ORIGIN: 'http://localhost:3000',
    JWT_ACCESS_SECRET: 'a_sufficiently_long_access_secret',
    JWT_REFRESH_SECRET: 'a_sufficiently_long_refresh_secret',
  };
}

describe('env validation', () => {
  it('accepts a complete, valid environment', () => {
    const { error } = envValidationSchema.validate(baseEnv(), envValidationOptions);
    expect(error).toBeUndefined();
  });

  it.each(['DATABASE_URL', 'REDIS_URL', 'WEB_ORIGIN'])(
    'fails when required variable %s is missing',
    (key) => {
      const env = baseEnv();
      delete env[key];
      const { error } = envValidationSchema.validate(env, envValidationOptions);
      expect(error).toBeDefined();
      expect(error?.message).toContain(key);
    },
  );

  it('rejects an invalid DATABASE_URL scheme', () => {
    const env = { ...baseEnv(), DATABASE_URL: 'mysql://user:pass@localhost/db' };
    const { error } = envValidationSchema.validate(env, envValidationOptions);
    expect(error).toBeDefined();
  });

  it('rejects identical access and refresh secrets', () => {
    const env = {
      ...baseEnv(),
      JWT_ACCESS_SECRET: 'same_secret_value_used_twice',
      JWT_REFRESH_SECRET: 'same_secret_value_used_twice',
    };
    const { error } = envValidationSchema.validate(env, envValidationOptions);
    expect(error).toBeDefined();
    expect(error?.message).toContain('must differ');
  });

  describe('production has no insecure secret fallback', () => {
    const previous = process.env.NODE_ENV;

    afterEach(() => {
      process.env.NODE_ENV = previous;
      jest.resetModules();
    });

    it('requires JWT secrets to be present in production', async () => {
      // The schema branches on NODE_ENV at module-evaluation time, so set it
      // before a fresh dynamic import of the module.
      process.env.NODE_ENV = 'production';
      jest.resetModules();

      const prod = await import('./env.validation');

      const env = baseEnv();
      env.NODE_ENV = 'production';
      delete env.JWT_ACCESS_SECRET;
      delete env.JWT_REFRESH_SECRET;

      const { error } = prod.envValidationSchema.validate(env, prod.envValidationOptions);
      expect(error).toBeDefined();
      expect(error?.message).toContain('JWT_ACCESS_SECRET');
    });
  });
});
