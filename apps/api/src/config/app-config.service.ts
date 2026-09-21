import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DEFAULT_FIRST_CONTACT_MESSAGE } from './first-contact';
import { DEFAULT_OUTBOUND_DELIVERY_SETTINGS, OutboundDeliverySettings } from './outbound-delivery';

/**
 * Typed, validated access to configuration. Modules depend on this instead of
 * reading process.env directly. Secret getters exist but their values are never
 * logged; the pino redaction config strips them from request logs as well.
 */
@Injectable()
export class AppConfigService {
  constructor(private readonly config: ConfigService) {}

  get nodeEnv(): 'development' | 'test' | 'production' {
    return this.config.getOrThrow('NODE_ENV');
  }

  get isProduction(): boolean {
    return this.nodeEnv === 'production';
  }

  get apiPort(): number {
    return Number(this.config.getOrThrow('API_PORT'));
  }

  get databaseUrl(): string {
    return this.config.getOrThrow('DATABASE_URL');
  }

  get redisUrl(): string {
    return this.config.getOrThrow('REDIS_URL');
  }

  /** Parsed CORS allow-list. */
  get webOrigins(): string[] {
    return this.config
      .getOrThrow<string>('WEB_ORIGIN')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean);
  }

  get jwtAccessSecret(): string {
    return this.config.getOrThrow('JWT_ACCESS_SECRET');
  }

  get jwtRefreshSecret(): string {
    return this.config.getOrThrow('JWT_REFRESH_SECRET');
  }

  /** Access token lifetime in seconds (default 15 minutes). */
  get accessTokenTtlSec(): number {
    return Number(this.config.get('JWT_ACCESS_TTL_SEC') ?? 15 * 60);
  }

  /** Refresh token lifetime in seconds (default 7 days). */
  get refreshTokenTtlSec(): number {
    return Number(this.config.get('JWT_REFRESH_TTL_SEC') ?? 7 * 24 * 60 * 60);
  }

  /**
   * Raw INBOUND_SERVICE_CREDENTIALS (holds secrets: never log it). Parsed and
   * validated by parseInboundCredentials; '[]' when unset.
   */
  get inboundServiceCredentialsRaw(): string {
    return this.config.get<string>('INBOUND_SERVICE_CREDENTIALS') ?? '[]';
  }

  /** Text of the automatic first-contact reply: FIRST_CONTACT_MESSAGE, or the built-in default when blank/unset. */
  get firstContactMessage(): string {
    const configured = this.config.get<string>('FIRST_CONTACT_MESSAGE')?.trim();
    return configured || DEFAULT_FIRST_CONTACT_MESSAGE;
  }

  /** Operational settings of the outbound delivery engine; the worker is off unless OUTBOUND_WORKER_ENABLED is true. */
  get outboundDelivery(): OutboundDeliverySettings {
    const d = DEFAULT_OUTBOUND_DELIVERY_SETTINGS;
    const number = (key: string, fallback: number): number => {
      const value = Number(this.config.get(key));
      return Number.isFinite(value) && value > 0 ? value : fallback;
    };
    // ConfigService already holds the Joi-converted boolean, but tolerate the raw string too.
    const enabled = this.config.get<unknown>('OUTBOUND_WORKER_ENABLED');
    return {
      workerEnabled: enabled === true || enabled === 'true',
      pollIntervalMs: number('OUTBOUND_POLL_INTERVAL_MS', d.pollIntervalMs),
      batchSize: number('OUTBOUND_BATCH_SIZE', d.batchSize),
      leaseMs: number('OUTBOUND_LEASE_MS', d.leaseMs),
      sendTimeoutMs: number('OUTBOUND_SEND_TIMEOUT_MS', d.sendTimeoutMs),
    };
  }

  get logLevel(): string {
    return this.config.getOrThrow('LOG_LEVEL');
  }
}
