# Authentication API

Backend authentication for Inovasix Flow AI. All routes are prefixed with `/api`.

## Design summary

- **Multi-tenant login**: `slug` (company) + `email` + `password`. The tenant is
  derived server-side from the slug via a hardened `SECURITY DEFINER` lookup;
  the client never supplies `tenantId` as an authority.
- **Passwords**: Argon2id (OWASP-recommended, memory-hard), constant-time
  verify, opportunistic rehash on login.
- **Access token**: short-lived JWT (default 15 min), signed with
  `JWT_ACCESS_SECRET`. Claims: `sub` (userId), `tenantId`, `roleCodes`,
  `sessionId`. Returned in the response body; the SPA holds it in memory.
- **Refresh token**: longer-lived JWT (default 7 days), signed with
  `JWT_REFRESH_SECRET`. Delivered ONLY as an `HttpOnly` cookie
  (`inovasix_refresh`, `SameSite=strict`, `Secure` in production, `Path=/api/auth`).
  Never in the body, never in localStorage. Only its SHA-256 hash is stored in
  `auth_sessions.refresh_token_hash`.
- **Rotation + reuse detection**: each refresh rotates the stored hash. A token
  whose hash no longer matches the session's current hash is treated as reuse
  (theft/replay) and revokes the session.
- **TenantContext**: derived exclusively from a verified access token (never
  from body/query/params/arbitrary headers).

## Endpoints

### POST /api/auth/login
Rate limit: 5 / minute.

Request:
```json
{ "slug": "inovasix-demo", "email": "edson@demo.local", "password": "..." }
```
Response `200`:
```json
{ "accessToken": "<jwt>", "expiresIn": 900, "tokenType": "Bearer" }
```
Also sets the `inovasix_refresh` HttpOnly cookie.

Errors: `401 { "message": "Credenciais inválidas." }` for wrong password,
unknown user/tenant, or non-ACTIVE status — all identical (anti-enumeration).
`400` for malformed input. `429` when rate-limited.

### POST /api/auth/refresh
Rate limit: 30 / minute. Reads the refresh cookie (no body).

Response `200`: same shape as login; rotates the refresh cookie.
Errors: `401` for missing/invalid/expired/revoked/reused refresh token.

### POST /api/auth/logout
Requires `Authorization: Bearer <access>`. Revokes the current session and
clears the refresh cookie. Response `204`.

### POST /api/auth/logout-all
Requires `Authorization: Bearer <access>`. Revokes every active session of the
user within the tenant and clears the cookie. Response `200 { "revoked": <n> }`.

### GET /api/auth/me
Requires `Authorization: Bearer <access>`. Response `200`:
```json
{ "userId": "<uuid>", "tenantId": "<uuid>", "roles": ["ADMIN"] }
```

## User status policy
- `ACTIVE` → login allowed.
- `INVITED` → denied (must accept invite / set password first). Same generic error.
- `SUSPENDED` → denied. Same generic error.

## Roles & authorization
Guard `JwtAuthGuard` authenticates; `RolesGuard` + `@Roles(RoleCode.ADMIN, ...)`
authorize based on the tenant-scoped `roleCodes` in the verified token. Codes:
`ADMIN`, `GESTOR`, `COMERCIAL`, `ATENDENTE`.

## Cookies & CSRF (frontend guidance)
- Refresh token: HttpOnly cookie, `SameSite=strict`, `Secure` in production,
  scoped to `Path=/api/auth`.
- `SameSite=strict` plus the existing CORS allow-list (credentialed, fixed
  origins) mitigates CSRF for the refresh/logout routes without a separate CSRF
  token in the MVP. If cross-site flows are needed later, add an Origin check
  and/or a double-submit CSRF token.
- Access token is not stored in a cookie; the SPA keeps it in memory and sends
  it as a Bearer header, so it is not subject to CSRF.

## Auditing
Recorded in `audit_logs` (never secrets/tokens): `LOGIN_SUCCESS`,
`LOGIN_FAILED`, `TOKEN_REFRESH`, `LOGOUT`, `LOGOUT_ALL`, `SESSION_REVOKED`.

## Rate limiting & brute force
- Login: 5/min (stricter than the global 120/min). Refresh: 30/min.
- Uses the request key of the throttler (IP-based by default). Values are
  conservative to resist brute force without locking out shared-NAT users.
- No permanent per-account lockout (would enable DoS against a victim's email).
