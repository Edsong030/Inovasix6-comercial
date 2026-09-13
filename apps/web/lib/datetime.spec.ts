import { datetimeLocalToIso, formatDateTime, formatTime, isoToDatetimeLocal } from './datetime';

/**
 * Timezone round-trip: this is the exact scenario from the manual test
 * requirement — "14:00 digitado deve reaparecer como 14:00". Both
 * conversions rely on the BROWSER's local timezone (documented debt), so
 * these tests run in whatever TZ the test runner uses — the assertion is
 * about internal consistency (local -> ISO -> local), not a fixed timezone.
 */
describe('datetime local <-> ISO round-trip', () => {
  it('a time typed as 14:00 reappears as 14:00 after converting to ISO and back', () => {
    const typed = '2026-09-15T14:00';
    const iso = datetimeLocalToIso(typed);
    const backToLocal = isoToDatetimeLocal(iso);
    expect(backToLocal).toBe(typed);
  });

  it('round-trips midnight and end-of-day without drifting a day', () => {
    expect(isoToDatetimeLocal(datetimeLocalToIso('2026-01-01T00:00'))).toBe('2026-01-01T00:00');
    expect(isoToDatetimeLocal(datetimeLocalToIso('2026-12-31T23:59'))).toBe('2026-12-31T23:59');
  });

  it('datetimeLocalToIso produces a real UTC ISO string (Z suffix)', () => {
    expect(datetimeLocalToIso('2026-09-15T14:00')).toMatch(/Z$/);
  });

  it('isoToDatetimeLocal pads single-digit month/day/hour/minute', () => {
    // 2026-01-02T03:04 local — every component below 10 must be zero-padded.
    const iso = new Date(2026, 0, 2, 3, 4).toISOString();
    expect(isoToDatetimeLocal(iso)).toBe('2026-01-02T03:04');
  });
});

describe('read-only display formatting', () => {
  it('formatTime renders HH:mm', () => {
    const iso = new Date(2026, 8, 9, 14, 30).toISOString();
    expect(formatTime(iso)).toMatch(/^\d{2}:\d{2}$/);
  });

  it('formatDateTime renders day/month plus HH:mm', () => {
    const iso = new Date(2026, 8, 9, 14, 30).toISOString();
    expect(formatDateTime(iso)).toMatch(/^\d{2}\/\d{2},? \d{2}:\d{2}$/);
  });
});
