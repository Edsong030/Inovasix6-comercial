import { clearAccessToken, getAccessToken, setAccessToken } from './token-store';
import { AuthError, type MeResponse, type TokenResponse } from './types';

/**
 * Thin fetch layer for the Nest API.
 *
 * Rules enforced here (see apps/api/docs/auth.md):
 *  - the access token is read from the in-memory store and sent as a Bearer
 *    header, never persisted;
 *  - `credentials: 'include'` so the HttpOnly refresh cookie (Path=/api/auth)
 *    travels with /api/auth/* requests only;
 *  - a 401 on a protected call triggers AT MOST ONE refresh + replay.
 */

export const API_BASE_URL = (
  process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'
).replace(/\/+$/, '');

/** Message shown for every credential failure — never leaks the real reason. */
export const GENERIC_CREDENTIALS_ERROR = 'Empresa, e-mail ou senha inválidos.';
export const GENERIC_NETWORK_ERROR =
  'Não foi possível conectar ao servidor. Tente novamente em instantes.';

interface RequestOptions {
  /** Refresh + replay once when the response is 401. Off for the auth routes. */
  retryOnUnauthorized?: boolean;
  signal?: AbortSignal;
}

/** Notified when the session is definitively gone, so the UI can bail out. */
let sessionExpiredHandler: (() => void) | null = null;

export function setSessionExpiredHandler(handler: (() => void) | null): void {
  sessionExpiredHandler = handler;
}

/** De-duplicates concurrent refreshes: N parallel 401s share one round-trip. */
let refreshInFlight: Promise<string | null> | null = null;

async function rawRequest(
  path: string,
  init: RequestInit,
  token: string | null,
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  headers.set('Accept', 'application/json');
  if (token) headers.set('Authorization', `Bearer ${token}`);

  try {
    return await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      headers,
      // Required for the refresh cookie; harmless on the other routes.
      credentials: 'include',
      cache: 'no-store',
    });
  } catch {
    // Network/CORS failure — never surface the underlying details.
    throw new AuthError(GENERIC_NETWORK_ERROR);
  }
}

async function parseBody<T>(response: Response): Promise<T> {
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

/**
 * Performs the refresh round-trip. Resolves with the new access token, or null
 * when the refresh token is missing/expired/revoked/reused.
 */
async function performRefresh(): Promise<string | null> {
  const response = await rawRequest('/api/auth/refresh', { method: 'POST' }, null);
  if (!response.ok) return null;
  const body = await parseBody<TokenResponse>(response);
  if (!body?.accessToken) return null;
  setAccessToken(body.accessToken);
  return body.accessToken;
}

/** Single-flight refresh shared by every caller that hit a 401. */
export function refreshAccessToken(): Promise<string | null> {
  refreshInFlight ??= performRefresh()
    .catch(() => null)
    .finally(() => {
      refreshInFlight = null;
    });
  return refreshInFlight;
}

/**
 * Calls a protected endpoint. On 401 it refreshes once and replays the original
 * request exactly once; a second 401 ends the session. There is no third
 * attempt, so the flow cannot loop.
 */
export async function apiFetch<T>(
  path: string,
  init: RequestInit = {},
  { retryOnUnauthorized = true, signal }: RequestOptions = {},
): Promise<T> {
  const response = await rawRequest(path, { ...init, signal }, getAccessToken());

  if (response.status !== 401 || !retryOnUnauthorized) {
    if (!response.ok) throw new AuthError(await errorMessage(response), response.status);
    return parseBody<T>(response);
  }

  const token = await refreshAccessToken();
  if (!token) {
    clearAccessToken();
    sessionExpiredHandler?.();
    throw new AuthError(GENERIC_CREDENTIALS_ERROR, 401);
  }

  // The single replay. Its own 401 is final — no further refresh.
  const replay = await rawRequest(path, { ...init, signal }, token);
  if (!replay.ok) {
    if (replay.status === 401) {
      clearAccessToken();
      sessionExpiredHandler?.();
    }
    throw new AuthError(await errorMessage(replay), replay.status);
  }
  return parseBody<T>(replay);
}

async function errorMessage(response: Response): Promise<string> {
  if (response.status === 401 || response.status === 403) return GENERIC_CREDENTIALS_ERROR;
  if (response.status === 429) {
    return 'Muitas tentativas. Aguarde um minuto e tente novamente.';
  }
  // Surface the backend's own message for other 4xx/5xx (validation errors,
  // 404s, 409 status-transition conflicts) instead of a generic string — the
  // UI needs the real reason (e.g. "Follow-up cancelado não pode ser
  // concluído."), not just "something went wrong". Never used for 401/403/429
  // above, which stay generic on purpose (anti-enumeration).
  try {
    const body: unknown = await response.json();
    const message = (body as { message?: unknown } | undefined)?.message;
    if (typeof message === 'string' && message.trim()) return message;
    if (Array.isArray(message) && message.length > 0) return message.join(' ');
  } catch {
    // Body missing/not JSON — fall through to the generic message below.
  }
  return 'Não foi possível concluir a operação. Tente novamente.';
}

// -- auth endpoints -----------------------------------------------------------

export async function login(
  slug: string,
  email: string,
  password: string,
): Promise<TokenResponse> {
  const response = await rawRequest(
    '/api/auth/login',
    { method: 'POST', body: JSON.stringify({ slug, email, password }) },
    null,
  );

  if (!response.ok) {
    // 400 (malformed), 401 (bad credentials) and anything else collapse into
    // one message so the UI cannot be used to enumerate tenants or users.
    throw new AuthError(await errorMessage(response), response.status);
  }

  const body = await parseBody<TokenResponse>(response);
  setAccessToken(body.accessToken);
  return body;
}

export function fetchMe(signal?: AbortSignal): Promise<MeResponse> {
  // No retry: the caller (bootstrap / login) owns the refresh decision here.
  return apiFetch<MeResponse>('/api/auth/me', { method: 'GET' }, {
    retryOnUnauthorized: false,
    signal,
  });
}

export async function logout(): Promise<void> {
  try {
    await rawRequest('/api/auth/logout', { method: 'POST' }, getAccessToken());
  } catch {
    // Local sign-out must succeed even if the network call does not.
  } finally {
    clearAccessToken();
  }
}
