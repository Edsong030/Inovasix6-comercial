/**
 * Non-secret UI hints kept in localStorage: the company slug and e-mail typed
 * at login. They are needed after a reload because GET /api/auth/me returns
 * ids and roles only, and the shell has to render a company/person label.
 *
 * NO TOKEN IS EVER STORED HERE. The access token lives in memory only and the
 * refresh token is an HttpOnly cookie the browser never exposes to JS.
 */

const SLUG_KEY = 'inovasix.company-slug';
const EMAIL_KEY = 'inovasix.last-email';

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Private mode / blocked storage — hints are optional by design.
  }
}

export interface SessionHints {
  slug: string | null;
  email: string | null;
}

export function readSessionHints(): SessionHints {
  if (typeof window === 'undefined') return { slug: null, email: null };
  return { slug: read(SLUG_KEY), email: read(EMAIL_KEY) };
}

export function writeSessionHints({ slug, email }: SessionHints): void {
  if (typeof window === 'undefined') return;
  write(SLUG_KEY, slug);
  write(EMAIL_KEY, email);
}

/** Keeps the slug (so the login form stays pre-filled) and drops the e-mail. */
export function clearEmailHint(): void {
  if (typeof window === 'undefined') return;
  write(EMAIL_KEY, null);
}
