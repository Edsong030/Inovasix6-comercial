import { addDays, dayKey, dayLabel, startOfDay, startOfWeek, weekdayLabel } from './AgendaView';

describe('agenda week interval (current calendar week, Monday-Sunday)', () => {
  it('startOfWeek resolves to Monday for a mid-week date', () => {
    const wednesday = new Date(2026, 8, 9); // 2026-09-09 is a Wednesday
    const monday = startOfWeek(wednesday);
    expect(monday.getDay()).toBe(1);
    expect(monday.getDate()).toBe(7);
  });

  it('startOfWeek resolves to the PREVIOUS Monday for a Sunday (does not roll into next week)', () => {
    const sunday = new Date(2026, 8, 13); // 2026-09-13 is a Sunday
    const monday = startOfWeek(sunday);
    expect(monday.getDay()).toBe(1);
    expect(monday.getDate()).toBe(7);
  });

  it('a 7-day walk from startOfWeek covers Monday through Sunday exactly once', () => {
    const monday = startOfWeek(new Date(2026, 8, 9));
    const days = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
    expect(days.map((d) => d.getDay())).toEqual([1, 2, 3, 4, 5, 6, 0]);
    expect(dayKey(days[6])).not.toBe(dayKey(monday)); // no duplicate/overlap
  });

  it('dayLabel says "Hoje" for today and "Amanhã" for tomorrow, else a date', () => {
    const today = new Date(2026, 8, 9);
    expect(dayLabel(today, today)).toBe('Hoje');
    expect(dayLabel(addDays(today, 1), today)).toBe('Amanhã');
    expect(dayLabel(addDays(today, 2), today)).not.toMatch(/Hoje|Amanhã/);
  });

  it('weekdayLabel capitalizes the first letter (pt-BR)', () => {
    const label = weekdayLabel(new Date(2026, 8, 9));
    expect(label[0]).toBe(label[0].toUpperCase());
  });

  it('startOfDay strips the time component', () => {
    const withTime = new Date(2026, 8, 9, 23, 59, 59);
    const stripped = startOfDay(withTime);
    expect(stripped.getHours()).toBe(0);
    expect(stripped.getMinutes()).toBe(0);
  });
});
