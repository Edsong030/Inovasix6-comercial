/**
 * Local <-> ISO datetime conversions for <input type="datetime-local">.
 *
 * TIMEZONE DEBT (mirrors the backend's documented debt — see
 * DashboardService's docblock): there is no per-tenant timezone yet. Every
 * conversion here uses the BROWSER's local timezone. As long as the user's
 * machine is set to America/Sao_Paulo (the only timezone this product
 * currently targets), typing 14:00 round-trips as 14:00. A user whose OS
 * clock is set to a different timezone will see a mismatch — same class of
 * limitation the backend already has for "today"/"this month".
 */

/** ISO 8601 (any offset) -> "YYYY-MM-DDTHH:mm" in the browser's local time, for <input type="datetime-local">. */
export function isoToDatetimeLocal(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "YYYY-MM-DDTHH:mm" (local, from <input type="datetime-local">) -> ISO 8601 UTC string for the API. */
export function datetimeLocalToIso(value: string): string {
  // The Date constructor parses a timezone-less "YYYY-MM-DDTHH:mm" string as
  // LOCAL time (per spec), so this correctly preserves the instant the user
  // actually picked — no manual offset math needed.
  return new Date(value).toISOString();
}

const dateTimeFormatter = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

const timeFormatter = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });

/** Read-only display: "10/09 14:00". */
export function formatDateTime(iso: string): string {
  return dateTimeFormatter.format(new Date(iso));
}

/** Read-only display: "14:00". */
export function formatTime(iso: string): string {
  return timeFormatter.format(new Date(iso));
}
