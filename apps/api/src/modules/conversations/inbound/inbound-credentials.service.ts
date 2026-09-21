import { Injectable } from '@nestjs/common';
import type { ConversationChannel } from '@prisma/client';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { AppConfigService } from '../../../config/app-config.service';
import { InboundCredential, parseInboundCredentials, sha256 } from '../../../config/inbound-credentials';

/**
 * The caller behind an authenticated inbound request. tenantId and channel come
 * from the server-side credential, never from the request body.
 */
export interface AuthenticatedInboundService {
  readonly tenantId: string;
  readonly channel: ConversationChannel;
  readonly keyId: string;
}

/** Request augmented by InboundServiceGuard. */
export interface RequestWithInboundService {
  inboundService?: AuthenticatedInboundService;
}

/**
 * In-memory registry of the credentials in INBOUND_SERVICE_CREDENTIALS, built
 * once at startup (a bad value throws and stops the boot).
 *
 * Lookup is by keyId (public), so the presented secret is compared against ONE
 * candidate, not against every configured secret.
 */
@Injectable()
export class InboundCredentialsService {
  private readonly byKeyId = new Map<string, InboundCredential>();
  /** Stand-in digest so an unknown keyId costs the same work as a wrong secret. */
  private readonly decoyDigest = randomBytes(32);

  constructor(config: AppConfigService) {
    for (const credential of parseInboundCredentials(config.inboundServiceCredentialsRaw)) {
      this.byKeyId.set(credential.keyId, credential);
    }
  }

  get size(): number {
    return this.byKeyId.size;
  }

  /**
   * Returns the caller for a valid keyId + secret, or null. It does not say
   * whether the keyId or the secret was wrong.
   *
   * Constant-time comparison: both sides are hashed with SHA-256 first, so the
   * two buffers handed to timingSafeEqual always have the same length (32
   * bytes). That avoids both the RangeError timingSafeEqual throws on unequal
   * lengths and the length oracle an explicit length check would leak.
   */
  authenticate(keyId: string, secret: string): AuthenticatedInboundService | null {
    const credential = this.byKeyId.get(keyId);
    const matches = timingSafeEqual(sha256(secret), credential?.secretDigest ?? this.decoyDigest);
    if (!credential || !matches) return null;
    return { tenantId: credential.tenantId, channel: credential.channel, keyId: credential.keyId };
  }
}
