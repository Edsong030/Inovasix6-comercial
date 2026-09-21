import * as Joi from 'joi';
import { MAX_FIRST_CONTACT_MESSAGE_LENGTH } from './first-contact';
import { InboundCredentialsConfigError, parseInboundCredentials } from './inbound-credentials';
import {
  DEFAULT_OUTBOUND_DELIVERY_SETTINGS,
  OUTBOUND_BATCH_SIZE_LIMITS,
  OUTBOUND_LEASE_LIMITS,
  OUTBOUND_POLL_INTERVAL_LIMITS,
  OUTBOUND_SEND_TIMEOUT_LIMITS,
} from './outbound-delivery';

/**
 * Server-side environment validation. The application must fail fast at boot
 * when a required variable is missing or invalid. Secrets never carry an
 * insecure fallback in production.
 *
 * Environments are separated explicitly:
 *  - production: strict. No default secrets. Strong length requirements.
 *  - development / test: same required keys, but local convenience defaults
 *    are allowed so the stack boots without a curated secret vault.
 */

const isProduction = process.env.NODE_ENV === 'production';

/** In production a secret must be explicit and long; elsewhere a local default is tolerated. */
function secret(devDefault: string): Joi.StringSchema {
  const base = Joi.string().min(isProduction ? 32 : 16);
  return isProduction ? base.required() : base.default(devDefault);
}

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'test', 'production')
    .default('development'),

  API_PORT: Joi.number().port().default(3001),

  // Data stores
  DATABASE_URL: Joi.string().uri({ scheme: ['postgresql', 'postgres'] }).required(),
  REDIS_URL: Joi.string().uri({ scheme: ['redis', 'rediss'] }).required(),

  // CORS: comma-separated list of allowed origins.
  WEB_ORIGIN: Joi.string().required(),

  // Auth secrets — never printed, never defaulted in production.
  JWT_ACCESS_SECRET: secret('dev_access_secret_change_me'),
  JWT_REFRESH_SECRET: secret('dev_refresh_secret_change_me'),

  // Machine-to-machine credentials for POST /api/conversations/inbound (JSON
  // array, see inbound-credentials.ts). Optional: unset/empty means the
  // endpoint rejects everything. Validated here so a bad value fails the boot;
  // the message never echoes the value (it holds secrets).
  INBOUND_SERVICE_CREDENTIALS: Joi.string()
    .allow('')
    .default('[]')
    .custom((value: string, helpers) => {
      try {
        parseInboundCredentials(value);
        return value;
      } catch (error) {
        if (error instanceof InboundCredentialsConfigError) return helpers.message({ custom: error.message });
        return helpers.message({ custom: 'INBOUND_SERVICE_CREDENTIALS could not be validated' });
      }
    }),

  // Optional override of the automatic first-contact reply text (see
  // first-contact.ts). Blank/unset means the built-in default.
  FIRST_CONTACT_MESSAGE: Joi.string().allow('').max(MAX_FIRST_CONTACT_MESSAGE_LENGTH),

  // Outbound delivery worker (see outbound-delivery.ts). Off unless enabled.
  OUTBOUND_WORKER_ENABLED: Joi.boolean().default(DEFAULT_OUTBOUND_DELIVERY_SETTINGS.workerEnabled),
  OUTBOUND_POLL_INTERVAL_MS: Joi.number()
    .integer()
    .min(OUTBOUND_POLL_INTERVAL_LIMITS.min)
    .max(OUTBOUND_POLL_INTERVAL_LIMITS.max)
    .default(DEFAULT_OUTBOUND_DELIVERY_SETTINGS.pollIntervalMs),
  OUTBOUND_BATCH_SIZE: Joi.number()
    .integer()
    .min(OUTBOUND_BATCH_SIZE_LIMITS.min)
    .max(OUTBOUND_BATCH_SIZE_LIMITS.max)
    .default(DEFAULT_OUTBOUND_DELIVERY_SETTINGS.batchSize),
  OUTBOUND_LEASE_MS: Joi.number()
    .integer()
    .min(OUTBOUND_LEASE_LIMITS.min)
    .max(OUTBOUND_LEASE_LIMITS.max)
    .default(DEFAULT_OUTBOUND_DELIVERY_SETTINGS.leaseMs),
  OUTBOUND_SEND_TIMEOUT_MS: Joi.number()
    .integer()
    .min(OUTBOUND_SEND_TIMEOUT_LIMITS.min)
    .max(OUTBOUND_SEND_TIMEOUT_LIMITS.max)
    .default(DEFAULT_OUTBOUND_DELIVERY_SETTINGS.sendTimeoutMs),

  LOG_LEVEL: Joi.string()
    .valid('fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent')
    .default('info'),
})
  // A send that outlives its lease could be claimed by another worker while
  // still in flight: the timeout must be strictly shorter than the lease.
  .custom((value, helpers) => {
    if (Number(value.OUTBOUND_SEND_TIMEOUT_MS) >= Number(value.OUTBOUND_LEASE_MS)) {
      return helpers.message({ custom: 'OUTBOUND_SEND_TIMEOUT_MS must be lower than OUTBOUND_LEASE_MS' });
    }
    return value;
  })
  // Access and refresh secrets must never be identical.
  .custom((value, helpers) => {
    if (value.JWT_ACCESS_SECRET === value.JWT_REFRESH_SECRET) {
      return helpers.error('any.invalid', {
        message: 'JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must differ',
      });
    }
    return value;
  })
  .messages({
    'any.invalid': 'JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must differ',
  });

/** Joi options used by ConfigModule: report every problem, reject unknown-but-typed keys loosely. */
export const envValidationOptions = {
  abortEarly: false,
  allowUnknown: true,
};
