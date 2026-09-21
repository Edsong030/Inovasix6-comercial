import * as Joi from 'joi';
import { MAX_FIRST_CONTACT_MESSAGE_LENGTH } from './first-contact';
import { InboundCredentialsConfigError, parseInboundCredentials } from './inbound-credentials';
import {
  DEFAULT_GRAPH_API_BASE_URL,
  DEFAULT_GRAPH_API_VERSION,
  DEFAULT_WHATSAPP_HTTP_TIMEOUT_MS,
  GRAPH_API_VERSION_PATTERN,
  MIN_APP_SECRET_LENGTH,
  MIN_VERIFY_TOKEN_LENGTH,
  WHATSAPP_HTTP_TIMEOUT_LIMITS,
  WhatsAppCloudConfigError,
  baseUrlProblem,
  parseWhatsAppCloudAccounts,
  secretProblem,
} from './whatsapp-cloud';
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

  // WhatsApp Cloud API (Meta). OFF unless WHATSAPP_CLOUD_ENABLED=true; when on,
  // the cross-checks below make the boot fail on any missing/weak secret. See
  // whatsapp-cloud.ts for what is global and what is per tenant.
  WHATSAPP_CLOUD_ENABLED: Joi.boolean().default(false),
  WHATSAPP_META_APP_SECRET: Joi.string().allow(''),
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: Joi.string().allow(''),
  WHATSAPP_GRAPH_API_VERSION: Joi.string().pattern(GRAPH_API_VERSION_PATTERN).default(DEFAULT_GRAPH_API_VERSION),
  WHATSAPP_GRAPH_API_BASE_URL: Joi.string()
    .default(DEFAULT_GRAPH_API_BASE_URL)
    .custom((value: string, helpers) => {
      const problem = baseUrlProblem(value, isProduction);
      return problem ? helpers.message({ custom: problem }) : value;
    }),
  WHATSAPP_HTTP_TIMEOUT_MS: Joi.number()
    .integer()
    .min(WHATSAPP_HTTP_TIMEOUT_LIMITS.min)
    .max(WHATSAPP_HTTP_TIMEOUT_LIMITS.max)
    .default(DEFAULT_WHATSAPP_HTTP_TIMEOUT_MS),
  WHATSAPP_CLOUD_ACCOUNTS: Joi.string()
    .allow('')
    .default('[]')
    .custom((value: string, helpers) => {
      try {
        parseWhatsAppCloudAccounts(value);
        return value;
      } catch (error) {
        if (error instanceof WhatsAppCloudConfigError) return helpers.message({ custom: error.message });
        return helpers.message({ custom: 'WHATSAPP_CLOUD_ACCOUNTS could not be validated' });
      }
    }),

  LOG_LEVEL: Joi.string()
    .valid('fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent')
    .default('info'),
})
  // With the WhatsApp integration ON every secret must be present and sound, at
  // least one account must exist, and one Graph API call must be able to time out
  // before the dispatcher gives up on the send (the dispatcher's limit is the
  // outer bound; a longer inner one would never fire).
  .custom((value, helpers) => {
    if (value.WHATSAPP_CLOUD_ENABLED !== true) return value;
    const problems = [
      secretProblem('WHATSAPP_META_APP_SECRET', value.WHATSAPP_META_APP_SECRET, MIN_APP_SECRET_LENGTH),
      secretProblem('WHATSAPP_WEBHOOK_VERIFY_TOKEN', value.WHATSAPP_WEBHOOK_VERIFY_TOKEN, MIN_VERIFY_TOKEN_LENGTH),
    ].filter((problem): problem is string => problem !== null);
    let accountCount = 0;
    try {
      accountCount = parseWhatsAppCloudAccounts(value.WHATSAPP_CLOUD_ACCOUNTS).length;
    } catch {
      accountCount = -1; // malformed: the field's own validation already reports why
    }
    if (accountCount === 0) problems.push('WHATSAPP_CLOUD_ACCOUNTS must list at least one account');
    if (Number(value.WHATSAPP_HTTP_TIMEOUT_MS) >= Number(value.OUTBOUND_SEND_TIMEOUT_MS)) {
      problems.push('WHATSAPP_HTTP_TIMEOUT_MS must be lower than OUTBOUND_SEND_TIMEOUT_MS');
    }
    return problems.length > 0 ? helpers.message({ custom: `WhatsApp Cloud API is enabled but misconfigured: ${problems.join('; ')}` }) : value;
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
