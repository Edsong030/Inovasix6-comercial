import { MessageStatus } from '@prisma/client';
import { ADVANCES_FROM, META_STATUS_TARGET, canAdvance, failureCode } from './whatsapp-status.policy';
import type { MetaStatus } from './whatsapp-webhook.parser';

const ALL_STORED = Object.values(MessageStatus);
const META: MetaStatus[] = ['sent', 'delivered', 'read', 'failed'];

/** Applies a sequence of callbacks to a stored status exactly as the service does. */
const replay = (start: MessageStatus, sequence: MetaStatus[]): MessageStatus =>
  sequence.reduce((current, status) => (canAdvance(current, status) ? META_STATUS_TARGET[status] : current), start);

describe('monotonic status policy', () => {
  it('maps the Meta statuses onto the existing MessageStatus values', () => {
    expect(META_STATUS_TARGET).toEqual({ sent: 'SENT', delivered: 'DELIVERED', read: 'READ', failed: 'FAILED' });
  });

  describe('the allowed moves', () => {
    it.each([
      ['SENT', 'delivered', true],
      ['SENT', 'read', true],
      ['SENT', 'failed', true],
      ['DELIVERED', 'read', true],
      // never backwards
      ['DELIVERED', 'sent', false],
      ['READ', 'sent', false],
      ['READ', 'delivered', false],
      ['READ', 'failed', false],
      ['DELIVERED', 'failed', false],
      ['DELIVERED', 'delivered', false],
      ['READ', 'read', false],
      // FAILED is terminal
      ['FAILED', 'sent', false],
      ['FAILED', 'delivered', false],
      ['FAILED', 'read', false],
      ['FAILED', 'failed', false],
      // `sent` never changes a row: the dispatcher already recorded SENT
      ['SENT', 'sent', false],
      // a PENDING message is the dispatcher's (it may hold a delivery lease): callbacks never touch it
      ['PENDING', 'sent', false],
      ['PENDING', 'delivered', false],
      ['PENDING', 'read', false],
      ['PENDING', 'failed', false],
    ] as const)('%s + %s callback -> %s', (current, status, allowed) => {
      expect(canAdvance(MessageStatus[current], status)).toBe(allowed);
    });

    it('never moves anything to a status of lower rank, over every pair', () => {
      const rank: Record<string, number> = { PENDING: 0, SENT: 1, DELIVERED: 2, READ: 3 };
      for (const current of ALL_STORED) {
        for (const status of META) {
          const target = META_STATUS_TARGET[status];
          if (canAdvance(current, status) && target !== 'FAILED') {
            expect(rank[target]).toBeGreaterThan(rank[current]);
          }
        }
      }
    });

    it('FAILED is only ever reachable from SENT (accepted by Meta, then not deliverable)', () => {
      expect(ALL_STORED.filter((current) => canAdvance(current, 'failed'))).toEqual(['SENT']);
      expect(ALL_STORED.filter((current) => canAdvance(current, 'failed') && ADVANCES_FROM.failed.includes(current))).toEqual(['SENT']);
    });
  });

  describe('out-of-order and duplicated callbacks', () => {
    it('READ then DELIVERED stays READ', () => {
      expect(replay('SENT', ['read', 'delivered'])).toBe('READ');
    });

    it('DELIVERED then SENT stays DELIVERED', () => {
      expect(replay('SENT', ['delivered', 'sent'])).toBe('DELIVERED');
    });

    it('READ, DELIVERED, SENT (fully reversed) ends READ', () => {
      expect(replay('SENT', ['read', 'delivered', 'sent'])).toBe('READ');
    });

    it('the normal order sent, delivered, read ends READ', () => {
      expect(replay('SENT', ['sent', 'delivered', 'read'])).toBe('READ');
    });

    it('a duplicate of any status changes nothing the second time', () => {
      for (const status of META) {
        const once = replay('SENT', [status]);
        expect(replay('SENT', [status, status, status])).toBe(once);
      }
    });

    it('a late FAILED never overwrites DELIVERED/READ, and a late DELIVERED never resurrects FAILED', () => {
      expect(replay('SENT', ['delivered', 'failed'])).toBe('DELIVERED');
      expect(replay('SENT', ['read', 'failed'])).toBe('READ');
      expect(replay('SENT', ['failed', 'delivered', 'read', 'sent'])).toBe('FAILED');
    });

    it('every permutation of the four callbacks ends where an independent oracle says', () => {
      const permutations = (items: MetaStatus[]): MetaStatus[][] =>
        items.length <= 1 ? [items] : items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]));
      // Oracle: a `failed` that arrives before any delivery outcome ends it as FAILED (terminal); otherwise the
      // furthest delivery outcome seen wins (READ > DELIVERED), and a late `failed` cannot undo a delivery.
      const oracle = (order: MetaStatus[]): MessageStatus => {
        const firstOutcome = order.findIndex((s) => s === 'delivered' || s === 'read');
        const failedAt = order.indexOf('failed');
        if (failedAt !== -1 && (firstOutcome === -1 || failedAt < firstOutcome)) return MessageStatus.FAILED;
        if (order.includes('read')) return MessageStatus.READ;
        return MessageStatus.DELIVERED;
      };

      const orders = permutations(['sent', 'delivered', 'read', 'failed']);
      expect(orders).toHaveLength(24);
      for (const order of orders) expect({ order, end: replay('SENT', order) }).toEqual({ order, end: oracle(order) });
    });
  });

  describe('failureCode', () => {
    it('stores only the numeric Meta code, in the delivery engine\'s machine-code format', () => {
      expect(failureCode('131047')).toBe('WA_131047');
      expect(failureCode('4')).toBe('WA_4');
      expect(failureCode('131047')).toMatch(/^[A-Z0-9_]{1,64}$/);
    });

    it.each([[null], [''], ['abc'], ['1234567890'], ['12 34'], ['5541999990000x'], ['-5']])('an unusable code %p becomes WA_UNKNOWN (no free text ever reaches the column)', (code) => {
      expect(failureCode(code)).toBe('WA_UNKNOWN');
    });
  });
});
