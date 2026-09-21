import { ConversationChannel } from '@prisma/client';
import {
  OUTBOUND_BACKOFF_JITTER,
  OUTBOUND_BACKOFF_MS,
  OUTBOUND_MAX_ATTEMPTS,
  backoffDelayMs,
  hasAttemptsLeft,
  requiresExternalDelivery,
} from './delivery-policy';

describe('delivery policy', () => {
  it('is the approved policy: 5 attempts, backoff 1 min / 5 min / 15 min / 1 h, jitter +/-20%', () => {
    expect(OUTBOUND_MAX_ATTEMPTS).toBe(5);
    expect(OUTBOUND_BACKOFF_MS).toEqual([60_000, 300_000, 900_000, 3_600_000]);
    expect(OUTBOUND_BACKOFF_JITTER).toBe(0.2);
    // one delay between each pair of attempts
    expect(OUTBOUND_BACKOFF_MS).toHaveLength(OUTBOUND_MAX_ATTEMPTS - 1);
  });

  describe('hasAttemptsLeft', () => {
    it('allows another attempt after attempts 1-4 and none after the 5th', () => {
      expect([1, 2, 3, 4, 5, 6].map(hasAttemptsLeft)).toEqual([true, true, true, true, false, false]);
    });
  });

  describe('backoffDelayMs', () => {
    it.each([
      [1, 60_000],
      [2, 300_000],
      [3, 900_000],
      [4, 3_600_000],
    ])('after a failed attempt %i the delay is centred on %i ms', (attempt, base) => {
      expect(backoffDelayMs(attempt, () => 0.5)).toBe(base);
    });

    it('spreads by exactly +/-20% at the extremes of the random source', () => {
      expect(backoffDelayMs(1, () => 0)).toBe(48_000);
      expect(backoffDelayMs(1, () => 0.999999)).toBeGreaterThanOrEqual(71_990);
      expect(backoffDelayMs(1, () => 0.999999)).toBeLessThanOrEqual(72_000);
      expect(backoffDelayMs(4, () => 0)).toBe(2_880_000);
    });

    it('stays inside the jitter band for real random values, and is never zero', () => {
      for (let attempt = 1; attempt <= 4; attempt++) {
        const base = OUTBOUND_BACKOFF_MS[attempt - 1];
        for (let i = 0; i < 200; i++) {
          const delay = backoffDelayMs(attempt);
          expect(delay).toBeGreaterThanOrEqual(base * 0.8);
          expect(delay).toBeLessThanOrEqual(base * 1.2);
        }
      }
    });

    it('is bounded for out-of-range attempts instead of throwing or returning NaN', () => {
      expect(backoffDelayMs(0, () => 0.5)).toBe(60_000);
      expect(backoffDelayMs(99, () => 0.5)).toBe(3_600_000);
    });
  });

  describe('requiresExternalDelivery', () => {
    it('is true for every external channel and false for MANUAL', () => {
      expect(requiresExternalDelivery(ConversationChannel.MANUAL)).toBe(false);
      for (const channel of [ConversationChannel.WHATSAPP, ConversationChannel.INSTAGRAM, ConversationChannel.FACEBOOK, ConversationChannel.WEBCHAT]) {
        expect(requiresExternalDelivery(channel)).toBe(true);
      }
    });
  });
});
