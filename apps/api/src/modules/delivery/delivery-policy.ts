import { ConversationChannel } from '@prisma/client';

/**
 * Retry policy of the outbound delivery engine.
 *
 * At most OUTBOUND_MAX_ATTEMPTS attempts per message. After a temporary failure
 * of attempt n (1-based) the next attempt waits OUTBOUND_BACKOFF_MS[n - 1]
 * (+/- jitter): 1 min, 5 min, 15 min, 1 h. A temporary failure of the LAST
 * attempt (or a permanent failure at any point) ends in FAILED. The worst case
 * from first attempt to FAILED is about 1 h 21 min.
 *
 * The state that makes this survive restarts (attempt count, next attempt time)
 * is persisted on the Message; nothing here is remembered in memory.
 */
export const OUTBOUND_MAX_ATTEMPTS = 5;
export const OUTBOUND_BACKOFF_MS: readonly number[] = [60_000, 300_000, 900_000, 3_600_000];
export const OUTBOUND_BACKOFF_JITTER = 0.2;

/**
 * Whether an OUTBOUND message on this channel must go through the delivery
 * engine. MANUAL has no external provider (an internal user wrote it locally),
 * so there is nothing to deliver: it is never queued.
 */
export function requiresExternalDelivery(channel: ConversationChannel): boolean {
  return channel !== ConversationChannel.MANUAL;
}

/** True when attempt number `attempt` (1-based, already made) may be followed by another. */
export function hasAttemptsLeft(attempt: number): boolean {
  return attempt < OUTBOUND_MAX_ATTEMPTS;
}

/**
 * Delay before the attempt that follows a temporary failure of `failedAttempt`
 * (1-based). `random` is injectable (returns [0, 1)) so the jitter is testable.
 * Without it the delay is centred on the base value with +/- 20% spread.
 */
export function backoffDelayMs(failedAttempt: number, random: () => number = Math.random): number {
  const index = Math.min(Math.max(failedAttempt, 1), OUTBOUND_BACKOFF_MS.length) - 1;
  const base = OUTBOUND_BACKOFF_MS[index];
  const factor = 1 + OUTBOUND_BACKOFF_JITTER * (2 * random() - 1);
  return Math.round(base * factor);
}
