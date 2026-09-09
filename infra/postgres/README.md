# PostgreSQL provisioning & multi-tenant security

Reproducible setup for the Inovasix Flow AI database: three roles, ownership,
least-privilege grants, Row Level Security, and the login-lookup bootstrap. No
secrets live in this repo.

## Files

- `provision-roles.sql` — creates/updates `inovasix_owner`, `inovasix_app`, and
  `inovasix_auth_definer`. Passwords come from psql variables, never hard-coded.
- `configure-ownership-and-grants.sql` — makes `inovasix_owner` own the schema
  and tables, and grants least-privilege DML to `inovasix_app`. Run AFTER
  migrations create the tables.
- `configure-auth-definer.sql` — transfers ownership of the login-lookup
  function to `inovasix_auth_definer` and grants EXECUTE to `inovasix_app`. Run
  AFTER the `add_auth_login_lookup` migration.
- RLS and the login-lookup function are **versioned Prisma migrations**
  (`*_add_multi_tenant_rls`, `*_add_auth_login_lookup`), not loose scripts.

## Roles

| Role | Purpose | Attributes |
|------|---------|-----------|
| `inovasix_owner` | DDL / `prisma migrate` | LOGIN, NOSUPERUSER, NOBYPASSRLS, NOCREATEROLE; CREATEDB per environment; owns schema + tables |
| `inovasix_app` | API runtime | LOGIN, NOSUPERUSER, NOBYPASSRLS, NOCREATEDB, NOCREATEROLE; only SELECT/INSERT/UPDATE/DELETE; not a table owner |
| `inovasix_auth_definer` | DEFINER of `auth_lookup_login()` only | NOLOGIN, NOSUPERUSER, **BYPASSRLS**, NOCREATEDB, NOCREATEROLE; SELECT on tenants/users/user_roles/roles only; not a table owner |

### Why `inovasix_auth_definer`
FORCE RLS applies even to the table owner (`inovasix_owner` is NOBYPASSRLS), so
a SECURITY DEFINER function owned by the owner would return 0 rows. Login must
resolve a user by (slug, email) BEFORE a tenant context exists. The technical
`inovasix_auth_definer` role is the ONLY role with BYPASSRLS, it is NOLOGIN, and
it is reachable exclusively as the DEFINER of the single read-only function
`auth_lookup_login()`. This confines the bypass to one minimal, audited path.

### CREATEDB decision
- **Local**: `inovasix_owner` MAY have CREATEDB (`-v owner_createdb=CREATEDB`).
- **Staging / Production**: prefer `NOCREATEDB` (`-v owner_createdb=NOCREATEDB`).

## Secrets strategy
- Passwords injected at run time via psql variables `owner_pw` / `app_pw`.
- `inovasix_auth_definer` is NOLOGIN, so it has no password.
- No password (local/staging/prod) is committed. `.env` is gitignored;
  `.env.example` carries placeholders only.

## Connection URLs (see `.env.example`)
- `DATABASE_URL` — API runtime, connects as **`inovasix_app`** (RLS-enforced).
- `DATABASE_URL_OWNER` — migrations / DDL, connects as **`inovasix_owner`**.
- `DATABASE_URL_APP` — RLS integration tests, connects as **`inovasix_app`**.

## Bootstrap sequence for a NEW environment

1. Ensure a PostgreSQL server is available and the target database exists.
2. Provision roles (as admin), passing secrets externally:
   ```
   psql -h <host> -U <admin> -d <db> \
     -v owner_pw="$OWNER_PW" -v app_pw="$APP_PW" \
     -v owner_createdb=NOCREATEDB \
     -f infra/postgres/provision-roles.sql
   ```
3. Run Prisma migrations as the **owner** (tables + RLS + login-lookup function):
   ```
   DATABASE_URL="$DATABASE_URL_OWNER" npx prisma migrate deploy
   ```
4. Apply ownership + grants (as admin/owner):
   ```
   psql -h <host> -U <admin> -d <db> -f infra/postgres/configure-ownership-and-grants.sql
   ```
5. Activate the login-lookup DEFINER (as admin):
   ```
   psql -h <host> -U <admin> -d <db> -f infra/postgres/configure-auth-definer.sql
   ```
6. Point the API at `DATABASE_URL` (the `inovasix_app` role).
7. Run the isolation + auth tests before serving traffic:
   ```
   npm run test:integration --workspace=@inovasix-flow/api
   ```
8. Only then enable the application.

> Order matters: the `add_auth_login_lookup` migration (step 3) creates the
> function owned by `inovasix_owner` (NOBYPASSRLS) — so it returns 0 rows and
> login does NOT work until step 5 transfers ownership to
> `inovasix_auth_definer`. `configure-auth-definer.sql` fails clearly if the
> role or function is missing. Steps 2, 4, and 5 are idempotent.
