-- =============================================================================
-- provision-roles.sql — Provision the three PostgreSQL roles. Idempotent.
-- Run by an admin/superuser (or the DB bootstrap pipeline). NOT run by the API.
--
-- Roles:
--   inovasix_owner        — DDL/migrations. LOGIN, NOSUPERUSER, NOBYPASSRLS.
--   inovasix_app          — API runtime. LOGIN, NOSUPERUSER, NOBYPASSRLS.
--   inovasix_auth_definer — DEFINER of the login-lookup function only.
--                           NOLOGIN, NOSUPERUSER, BYPASSRLS (the ONLY role with
--                           BYPASSRLS), reachable solely via that one function.
--
-- SECRETS: passwords are passed as psql variables, never hard-coded here.
--   psql ... -v owner_pw="$OWNER_PW" -v app_pw="$APP_PW" -f provision-roles.sql
-- The auth-definer is NOLOGIN, so it has no password.
--
-- CREATEDB decision:
--   LOCAL:            inovasix_owner MAY have CREATEDB (convenience: create the
--                     dev database from scratch). Toggle with :owner_createdb.
--   STAGING / PROD:   inovasix_owner should be NOCREATEDB. The database is
--                     created once by the platform/DBA; migrations only need
--                     DDL inside an existing database, not the ability to
--                     create new databases. Pass -v owner_createdb=NOCREATEDB.
--
-- No role is SUPERUSER in any environment. Only inovasix_auth_definer has
-- BYPASSRLS, and it is NOLOGIN + used exclusively as a function DEFINER.
-- =============================================================================

\if :{?owner_createdb}
\else
  \set owner_createdb NOCREATEDB
\endif

-- Owner / migrations role: owns schema + tables, runs DDL. Never used at runtime.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'inovasix_owner') THEN
    CREATE ROLE inovasix_owner LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE;
  END IF;
END
$$;
ALTER ROLE inovasix_owner NOSUPERUSER NOBYPASSRLS NOCREATEROLE;
ALTER ROLE inovasix_owner :owner_createdb;
ALTER ROLE inovasix_owner PASSWORD :'owner_pw';

-- Runtime application role: least privilege, cannot bypass RLS, no DDL.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'inovasix_app') THEN
    CREATE ROLE inovasix_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;
ALTER ROLE inovasix_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
ALTER ROLE inovasix_app PASSWORD :'app_pw';

-- Auth-definer role: owns ONLY the SECURITY DEFINER login-lookup function.
--   * NOLOGIN — nobody connects as this role; it exists solely as the DEFINER
--     of auth_lookup_login(), which runs with its privileges.
--   * BYPASSRLS — so the narrow login lookup can read tenants/users before a
--     tenant context exists. This is the ONLY role with BYPASSRLS, and it can
--     only be exercised through that single, minimal, read-only function.
--   * NOSUPERUSER, NOCREATEDB, NOCREATEROLE, and NOT a table owner (no DDL).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'inovasix_auth_definer') THEN
    CREATE ROLE inovasix_auth_definer NOLOGIN NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;
ALTER ROLE inovasix_auth_definer NOLOGIN NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE;
-- The auth-definer needs to read the auth-relevant tables (RLS is bypassed, but
-- table-level SELECT privilege is still required).
GRANT USAGE ON SCHEMA public TO inovasix_auth_definer;
GRANT SELECT ON public.tenants, public.users, public.user_roles, public.roles
  TO inovasix_auth_definer;
