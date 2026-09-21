import { MessageStatus } from '@prisma/client';
import type { MetaStatus } from './whatsapp-webhook.parser';

/**
 * Monotonic status policy for delivery callbacks.
 *
 * Meta reports the life of an outbound message as sent -> delivered -> read (or
 * failed), and gives no ordering guarantee: callbacks can arrive out of order or
 * more than once. The stored status may only ever move FORWARD:
 *
 *     SENT -> DELIVERED -> READ
 *     SENT -> FAILED                (accepted by Meta, then not deliverable)
 *
 * so DELIVERED never goes back to SENT, READ never goes back to DELIVERED, a
 * late DELIVERED after READ changes nothing, and a FAILED never overwrites a
 * message that was already DELIVERED/READ (that would contradict the
 * recipient's device having it). FAILED is terminal: nothing moves out of it.
 * A repeated callback matches nothing, which is what makes it idempotent.
 *
 * `sent` never changes a row on its own: the dispatcher already recorded SENT
 * when Meta accepted the message; the callback only confirms it.
 *
 * A PENDING message is never touched by a callback: it has no externalId until
 * the dispatcher records the acceptance, so a callback cannot even find it, and
 * PENDING rows may hold a delivery lease that only the dispatcher may release.
 */
export const META_STATUS_TARGET: Readonly<Record<MetaStatus, MessageStatus>> = {
  sent: MessageStatus.SENT,
  delivered: MessageStatus.DELIVERED,
  read: MessageStatus.READ,
  failed: MessageStatus.FAILED,
};

/** The stored statuses a callback of this kind is allowed to advance FROM. Empty = it never changes a row. */
export const ADVANCES_FROM: Readonly<Record<MetaStatus, readonly MessageStatus[]>> = {
  sent: [],
  delivered: [MessageStatus.SENT],
  read: [MessageStatus.SENT, MessageStatus.DELIVERED],
  failed: [MessageStatus.SENT],
};

export function canAdvance(current: MessageStatus, status: MetaStatus): boolean {
  return ADVANCES_FROM[status].includes(current);
}

/**
 * The value stored in Message.lastErrorCode for a failed status: the numeric
 * Meta code only, in the same "short machine code" format the delivery engine
 * uses. Never Meta's title/message text (it can quote a phone number or content).
 */
export function failureCode(errorCode: string | null): string {
  return errorCode && /^\d{1,9}$/.test(errorCode) ? `WA_${errorCode}` : 'WA_UNKNOWN';
}
