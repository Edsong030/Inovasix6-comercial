/**
 * In-memory access-token holder.
 *
 * Deliberately a module-level variable and NOT React state:
 *  - it must be readable synchronously by the fetch wrapper, outside render;
 *  - it dies with the tab, which is the whole point (no localStorage, no
 *    sessionStorage, no cookie readable by JS).
 *
 * The refresh token never passes through here — it lives only in the
 * HttpOnly `inovasix_refresh` cookie owned by the API (see docs/auth.md).
 */

let accessToken: string | null = null;

export function getAccessToken(): string | null {
  return accessToken;
}

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function clearAccessToken(): void {
  accessToken = null;
}
