import type { ConversationChannel } from '@prisma/client';

/**
 * The seam between the delivery engine and a messaging provider.
 *
 * The domain knows nothing about WhatsApp, Meta, Instagram or any HTTP client:
 * an adapter receives a provider-neutral request and either returns the id the
 * provider gave the message or throws an OutboundDeliveryError saying whether
 * trying again could help.
 */

export interface OutboundSendInput {
  /**
   * The Message id. Stable across retries of the SAME message, so an adapter
   * can hand it to a provider that de-duplicates by idempotency key. The engine
   * is at-least-once: a crash between "provider accepted" and "SENT persisted"
   * makes the same message be sent again, and this key is the only thing that
   * lets a provider that supports it suppress the duplicate.
   */
  idempotencyKey: string;
  tenantId: string;
  conversationId: string;
  channel: ConversationChannel;
  recipient: {
    /** The contact's id on this channel (ContactChannelIdentity.externalContactId). */
    externalContactId: string;
    /** Provider thread/session id, when the channel has one. */
    externalConversationId: string | null;
  };
  body: string;
  /**
   * Aborted when the engine stops waiting (send timeout). Adapters should pass
   * it to their HTTP client. Aborting does NOT prove the provider did not
   * accept the message.
   */
  signal: AbortSignal;
}

export interface OutboundSendResult {
  /** The provider's id for the accepted message. Persisted as Message.externalId. */
  externalMessageId: string;
}

export interface OutboundChannelAdapter {
  /** The one external channel this adapter delivers to. Never MANUAL. */
  readonly channel: ConversationChannel;
  /**
   * Resolves ONLY when the provider accepted the message (=> status SENT, not
   * DELIVERED: delivery is confirmed later by the provider, not by this call).
   * Rejects with OutboundDeliveryError to classify a failure; any other error is
   * treated as temporary.
   */
  send(input: OutboundSendInput): Promise<OutboundSendResult>;
}

/** temporary: retrying later may work (network, 5xx, rate limit). permanent: it never will (invalid recipient, blocked, policy). */
export type OutboundFailureKind = 'temporary' | 'permanent';

/** Short machine codes only: they are stored and logged, so never put provider text or PII in one. */
export const OUTBOUND_ERROR_CODE_PATTERN = /^[A-Z0-9_]{1,64}$/;

export class OutboundDeliveryError extends Error {
  constructor(
    readonly kind: OutboundFailureKind,
    readonly code: string,
  ) {
    // The message is the code on purpose: nothing free-form travels with the error.
    super(code);
    this.name = 'OutboundDeliveryError';
  }

  static temporary(code: string): OutboundDeliveryError {
    return new OutboundDeliveryError('temporary', code);
  }

  static permanent(code: string): OutboundDeliveryError {
    return new OutboundDeliveryError('permanent', code);
  }
}
